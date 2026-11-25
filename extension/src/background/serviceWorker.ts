import {
  APPROVED_CDN_HOSTS,
  AppError,
  FreeDramaApiClient,
  assertApprovedUrl,
  buildEpisodeRelativePath,
  getRenditionLabel,
  isExpired,
  parseFreeDramaUrl,
  selectRendition,
  toDramaSummary,
  toPublicRenditions,
  type PublicRendition
} from "../../../shared/src/index.js";
import {
  cancelChromeDownload,
  findChromeDownload,
  showChromeDownload,
  startChromeDownload
} from "../services/chromeDownloads.js";
import {
  loadJobs,
  loadLastInspected,
  saveJobs,
  saveLastInspected,
  withJobsLock
} from "../services/storage.js";
import type {
  ApiResponse,
  ExtensionDownloadJob,
  InspectedDramaState,
  RuntimeRequest
} from "../types/messages.js";

const MAX_CONCURRENCY = 2;

const apiClient = new FreeDramaApiClient({
  credentials: "include"
});

const resolvingAborts = new Map<string, AbortController>();
let pumping = false;

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toUserError(err: unknown): { code: string; message: string } {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: "UNKNOWN_ERROR", message: err.message };
  }
  return { code: "UNKNOWN_ERROR", message: "An unexpected error occurred." };
}

function formatChromeDownloadError(errorCode?: string): string {
  switch (errorCode) {
    case "SERVER_FORBIDDEN":
    case "SERVER_UNAUTHORIZED":
      return "Download authorization failed or signed URL expired.";
    case "NETWORK_FAILED":
    case "NETWORK_TIMEOUT":
    case "NETWORK_DISCONNECTED":
      return `Network interruption during download (${errorCode}).`;
    case "FILE_NO_SPACE":
      return "Insufficient disk space to complete download.";
    case "USER_CANCELED":
      return "Download cancelled by user.";
    default:
      return errorCode
        ? `Chrome download interrupted (${errorCode}).`
        : "Chrome download failed.";
  }
}

async function resolveAndStartJob(jobId: string): Promise<void> {
  const controller = new AbortController();
  resolvingAborts.set(jobId, controller);

  try {
    const initialJob = await withJobsLock(async () => {
      const jobs = await loadJobs();
      const target = jobs.find((j) => j.id === jobId);
      if (!target || target.status !== "resolving") return null;
      return { ...target };
    });

    if (!initialJob) return;

    let selectedMp4Url: string | null = null;
    let selectedLabel: string | null = null;
    let resolvedOrdinal = initialJob.episodeNumber;
    let resolvedDramaTitle = initialJob.dramaTitle;

    if (!resolvedDramaTitle) {
      try {
        const seriesDetail = await apiClient.getSeriesDetail(
          initialJob.seriesId,
          controller.signal
        );
        resolvedDramaTitle = seriesDetail.series.title || initialJob.seriesId;
      } catch {
        resolvedDramaTitle = initialJob.seriesId;
      }
    }

    for (let refreshAttempt = 0; refreshAttempt < 2; refreshAttempt++) {
      const playback = await apiClient.getEpisodePlayback(
        initialJob.episodeId,
        controller.signal
      );

      const rendition = selectRendition(playback.renditions, initialJob.requestedQuality);
      if (!rendition || !rendition.mp4Url) {
        throw new AppError(
          422,
          "NO_MP4_RENDITION",
          "No authorized MP4 rendition is available for this episode."
        );
      }

      if (isExpired(rendition.expiresAt)) {
        if (refreshAttempt === 0) continue;
        throw new AppError(
          502,
          "SIGNED_URL_EXPIRED",
          "Retrieved signed video URL was already expired."
        );
      }

      const validUrl = assertApprovedUrl(rendition.mp4Url, APPROVED_CDN_HOSTS);
      selectedMp4Url = validUrl.toString();
      selectedLabel = getRenditionLabel(rendition);
      resolvedOrdinal = playback.ordinal || initialJob.episodeNumber;
      break;
    }

    if (!selectedMp4Url || !selectedLabel) {
      throw new AppError(
        502,
        "SIGNED_URL_EXPIRED",
        "Unable to obtain a non-expired playback URL."
      );
    }

    // Re-check cancellation before calling chrome.downloads.download.
    const stillActive = await withJobsLock(async () => {
      const jobs = await loadJobs();
      const current = jobs.find((j) => j.id === jobId);
      return current && current.status === "resolving";
    });
    if (!stillActive || controller.signal.aborted) {
      return;
    }

    const { filename, relativePath } = buildEpisodeRelativePath(
      resolvedDramaTitle,
      resolvedOrdinal,
      selectedLabel
    );

    const chromeDownloadId = await startChromeDownload(selectedMp4Url, relativePath);

    await withJobsLock(async () => {
      const jobs = await loadJobs();
      const target = jobs.find((j) => j.id === jobId);
      if (!target) {
        await cancelChromeDownload(chromeDownloadId);
        return;
      }
      if (target.status === "cancelled") {
        await cancelChromeDownload(chromeDownloadId);
        return;
      }

      target.status = "downloading";
      target.chromeDownloadId = chromeDownloadId;
      target.qualityLabel = selectedLabel;
      target.filename = filename;
      target.dramaTitle = resolvedDramaTitle;
      target.episodeNumber = resolvedOrdinal;
      target.error = null;
      target.errorCode = null;
      target.updatedAt = Date.now();
      await saveJobs(jobs);
    });
  } catch (err) {
    if (controller.signal.aborted) {
      return;
    }
    const { code, message } = toUserError(err);
    await withJobsLock(async () => {
      const jobs = await loadJobs();
      const target = jobs.find((j) => j.id === jobId);
      if (!target || target.status === "cancelled") return;
      target.status = "failed";
      target.error = message;
      target.errorCode = code;
      target.updatedAt = Date.now();
      await saveJobs(jobs);
    });
  } finally {
    resolvingAborts.delete(jobId);
    void pumpQueue();
  }
}

async function pumpQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const toStart: string[] = [];

    await withJobsLock(async () => {
      const jobs = await loadJobs();
      const activeCount = jobs.filter(
        (j) => j.status === "resolving" || j.status === "downloading"
      ).length;

      let slots = Math.max(0, MAX_CONCURRENCY - activeCount);
      if (slots === 0) return;

      let changed = false;
      for (const job of jobs) {
        if (slots === 0) break;
        if (job.status === "queued") {
          job.status = "resolving";
          job.updatedAt = Date.now();
          toStart.push(job.id);
          slots -= 1;
          changed = true;
        }
      }

      if (changed) {
        await saveJobs(jobs);
      }
    });

    for (const jobId of toStart) {
      void resolveAndStartJob(jobId);
    }
  } finally {
    pumping = false;
  }
}

async function syncProgressFromChrome(): Promise<ExtensionDownloadJob[]> {
  const result = await withJobsLock(async () => {
    const jobs = await loadJobs();
    let changed = false;

    for (const job of jobs) {
      if (job.status !== "downloading" || job.chromeDownloadId === null) continue;
      const item = await findChromeDownload(job.chromeDownloadId);
      if (!item) continue;

      if (item.state === "complete") {
        job.status = "completed";
        job.progress = 100;
        job.downloadedBytes = item.bytesReceived || item.totalBytes || job.downloadedBytes;
        job.totalBytes = item.totalBytes > 0 ? item.totalBytes : job.downloadedBytes;
        job.completedAt = Date.now();
        job.updatedAt = Date.now();
        changed = true;
      } else if (item.state === "interrupted") {
        job.status = item.error === "USER_CANCELED" ? "cancelled" : "failed";
        job.errorCode = item.error ?? "DOWNLOAD_INTERRUPTED";
        job.error = formatChromeDownloadError(item.error);
        job.updatedAt = Date.now();
        changed = true;
      } else {
        const received = item.bytesReceived ?? 0;
        const total = item.totalBytes > 0 ? item.totalBytes : null;
        const progress =
          total && total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : job.progress;

        if (
          received !== job.downloadedBytes ||
          total !== job.totalBytes ||
          progress !== job.progress
        ) {
          job.downloadedBytes = received;
          job.totalBytes = total;
          job.progress = progress;
          job.updatedAt = Date.now();
          changed = true;
        }
      }
    }

    if (changed) {
      await saveJobs(jobs);
    }
    return jobs;
  });

  return result;
}

async function reconcileOnStartup(): Promise<void> {
  await withJobsLock(async () => {
    const jobs = await loadJobs();
    let changed = false;

    for (const job of jobs) {
      // If SW suspended while resolving before chromeDownloadId was obtained, re-queue.
      if (job.status === "resolving" && job.chromeDownloadId === null) {
        job.status = "queued";
        job.updatedAt = Date.now();
        changed = true;
      }
    }

    if (changed) {
      await saveJobs(jobs);
    }
  });

  await syncProgressFromChrome();
  void pumpQueue();
}

chrome.downloads.onChanged.addListener((delta) => {
  void (async () => {
    let shouldPump = false;

    await withJobsLock(async () => {
      const jobs = await loadJobs();
      const job = jobs.find((j) => j.chromeDownloadId === delta.id);
      if (!job) return;

      if (delta.state?.current === "complete") {
        const item = await findChromeDownload(delta.id);
        job.status = "completed";
        job.progress = 100;
        job.downloadedBytes = item?.bytesReceived || item?.totalBytes || job.downloadedBytes;
        job.totalBytes =
          item && item.totalBytes > 0 ? item.totalBytes : job.downloadedBytes;
        job.error = null;
        job.errorCode = null;
        job.completedAt = Date.now();
        job.updatedAt = Date.now();
        await saveJobs(jobs);
        shouldPump = true;
        return;
      }

      if (delta.state?.current === "interrupted") {
        const errCode = delta.error?.current;
        if (errCode === "USER_CANCELED") {
          job.status = "cancelled";
          job.errorCode = "CANCELLED";
          job.error = "Download cancelled by user.";
          job.updatedAt = Date.now();
          await saveJobs(jobs);
          shouldPump = true;
          return;
        }

        // If CDN rejected due to expired signed URL, refresh playback once automatically.
        if (
          (errCode === "SERVER_FORBIDDEN" || errCode === "SERVER_UNAUTHORIZED") &&
          !job.refreshedOnce
        ) {
          job.refreshedOnce = true;
          job.chromeDownloadId = null;
          job.downloadedBytes = 0;
          job.progress = 0;
          job.status = "queued";
          job.error = null;
          job.errorCode = null;
          job.updatedAt = Date.now();
          await saveJobs(jobs);
          shouldPump = true;
          return;
        }

        job.status = "failed";
        job.errorCode = errCode ?? "DOWNLOAD_INTERRUPTED";
        job.error = formatChromeDownloadError(errCode);
        job.updatedAt = Date.now();
        await saveJobs(jobs);
        shouldPump = true;
      }
    });

    if (shouldPump) {
      void pumpQueue();
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void reconcileOnStartup();
});

chrome.runtime.onInstalled.addListener(() => {
  void reconcileOnStartup();
});

async function handleInspectUrl(url: string): Promise<ApiResponse<InspectedDramaState>> {
  try {
    const parsed = parseFreeDramaUrl(url);
    const detail = await apiClient.getSeriesDetail(parsed.slug);
    const drama = toDramaSummary(detail);

    let currentEpisodeNumber: number | undefined;
    let currentEpisodeId: string | undefined;
    let currentRenditions: PublicRendition[] | undefined;
    let episodeNotice: string | null = null;

    if (parsed.kind === "episode") {
      currentEpisodeNumber = parsed.ordinal;
      const matched = drama.episodes.find((e) => e.number === parsed.ordinal);
      if (matched) {
        currentEpisodeId = matched.id;
        try {
          const playback = await apiClient.getEpisodePlayback(matched.id);
          currentRenditions = toPublicRenditions(playback.renditions);
        } catch (err) {
          episodeNotice = toUserError(err).message;
        }
      } else {
        episodeNotice = `Episode ${parsed.ordinal} was not found in "${drama.title}".`;
      }
    }

    const state: InspectedDramaState = {
      url: parsed.normalizedUrl,
      drama,
      currentEpisodeNumber,
      currentEpisodeId,
      currentRenditions,
      episodeNotice,
      inspectedAt: Date.now()
    };

    await saveLastInspected(state);
    return { ok: true, data: state };
  } catch (err) {
    const { code, message } = toUserError(err);
    return { ok: false, error: message, errorCode: code };
  }
}

async function handleInspectEpisodeRenditions(
  episodeId: string
): Promise<ApiResponse<PublicRendition[]>> {
  try {
    const playback = await apiClient.getEpisodePlayback(episodeId);
    return { ok: true, data: toPublicRenditions(playback.renditions) };
  } catch (err) {
    const { code, message } = toUserError(err);
    return { ok: false, error: message, errorCode: code };
  }
}

async function handleEnqueueDownloads(
  req: Extract<RuntimeRequest, { type: "ENQUEUE_DOWNLOADS" }>
): Promise<ApiResponse<{ added: number; skippedDuplicates: number; jobs: ExtensionDownloadJob[] }>> {
  let added = 0;
  let skippedDuplicates = 0;

  const jobs = await withJobsLock(async () => {
    const existing = await loadJobs();
    const now = Date.now();

    for (const ep of req.episodes) {
      const duplicate = existing.find(
        (j) =>
          j.episodeId === ep.episodeId &&
          j.requestedQuality === req.quality &&
          (j.status === "queued" || j.status === "resolving" || j.status === "downloading")
      );
      if (duplicate) {
        skippedDuplicates += 1;
        continue;
      }

      const newJob: ExtensionDownloadJob = {
        id: makeId(),
        episodeId: ep.episodeId,
        seriesId: req.seriesId,
        episodeNumber: ep.episodeNumber,
        dramaTitle: req.dramaTitle,
        requestedQuality: req.quality,
        qualityLabel: req.quality
          ? req.quality === 1920 || req.quality === 1080
            ? "1080p"
            : req.quality === 960 || req.quality === 540
              ? "540p"
              : `${req.quality}p`
          : null,
        status: "queued",
        progress: 0,
        downloadedBytes: 0,
        totalBytes: null,
        filename: null,
        chromeDownloadId: null,
        error: null,
        errorCode: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null
      };

      existing.unshift(newJob);
      added += 1;
    }

    await saveJobs(existing);
    return existing;
  });

  if (added > 0) {
    void pumpQueue();
  }

  return {
    ok: true,
    data: { added, skippedDuplicates, jobs }
  };
}

async function handleCancelDownload(jobId: string): Promise<ApiResponse<ExtensionDownloadJob[]>> {
  let chromeIdToCancel: number | null = null;
  let shouldPump = false;

  const jobs = await withJobsLock(async () => {
    const list = await loadJobs();
    const job = list.find((j) => j.id === jobId);
    if (!job) return list;

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return list;
    }

    if (job.chromeDownloadId !== null) {
      chromeIdToCancel = job.chromeDownloadId;
    }

    const abortController = resolvingAborts.get(jobId);
    if (abortController) {
      abortController.abort();
    }

    job.status = "cancelled";
    job.errorCode = "CANCELLED";
    job.error = "Download cancelled by user.";
    job.updatedAt = Date.now();
    await saveJobs(list);
    shouldPump = true;
    return list;
  });

  if (chromeIdToCancel !== null) {
    await cancelChromeDownload(chromeIdToCancel);
  }
  if (shouldPump) {
    void pumpQueue();
  }

  return { ok: true, data: jobs };
}

chrome.runtime.onMessage.addListener(
  (message: RuntimeRequest, _sender, sendResponse) => {
    void (async () => {
      try {
        switch (message?.type) {
          case "GET_STATE": {
            const [jobs, lastInspected] = await Promise.all([
              syncProgressFromChrome(),
              loadLastInspected()
            ]);
            void pumpQueue();
            sendResponse({ ok: true, data: { jobs, lastInspected } });
            return;
          }
          case "SYNC_PROGRESS": {
            const jobs = await syncProgressFromChrome();
            void pumpQueue();
            sendResponse({ ok: true, data: jobs });
            return;
          }
          case "INSPECT_URL": {
            sendResponse(await handleInspectUrl(message.url));
            return;
          }
          case "INSPECT_EPISODE_RENDITIONS": {
            sendResponse(await handleInspectEpisodeRenditions(message.episodeId));
            return;
          }
          case "ENQUEUE_DOWNLOADS": {
            sendResponse(await handleEnqueueDownloads(message));
            return;
          }
          case "CANCEL_DOWNLOAD": {
            sendResponse(await handleCancelDownload(message.jobId));
            return;
          }
          case "CLEAR_FINISHED_DOWNLOADS": {
            const jobs = await withJobsLock(async () => {
              const current = await loadJobs();
              const activeOnly = current.filter(
                (j) =>
                  j.status === "queued" ||
                  j.status === "resolving" ||
                  j.status === "downloading"
              );
              await saveJobs(activeOnly);
              return activeOnly;
            });
            sendResponse({ ok: true, data: jobs });
            return;
          }
          case "SHOW_DOWNLOAD_FILE": {
            showChromeDownload(message.chromeDownloadId);
            sendResponse({ ok: true });
            return;
          }
          default:
            sendResponse({ ok: false, error: "Unsupported message type." });
        }
      } catch (err) {
        const { code, message: msg } = toUserError(err);
        sendResponse({ ok: false, error: msg, errorCode: code });
      }
    })();

    return true;
  }
);
