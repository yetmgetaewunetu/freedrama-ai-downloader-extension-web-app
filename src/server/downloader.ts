import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sanitizePathSegment } from "../../shared/src/filename.js";
import { APPROVED_CDN_HOSTS, type AppConfig } from "./config.js";
import {
  FreeDramaClient,
  getRenditionLabel,
  isExpired,
  parseRetryAfterSeconds,
  selectRendition
} from "./freedramaClient.js";
import {
  AppError,
  type DownloadJob,
  type PublicDownloadJob,
  type VideoRendition
} from "./types.js";
import { assertApprovedUrl } from "./urlProcessor.js";

export { sanitizePathSegment };

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_FREE_DISK_BYTES = 20 * 1024 * 1024;
const DISK_HEADROOM_BYTES = 10 * 1024 * 1024;
const MAX_CDN_RETRIES = 2;

export function resolveSafePath(baseDir: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...segments);
  const prefix = resolvedBase.endsWith(path.sep)
    ? resolvedBase
    : `${resolvedBase}${path.sep}`;

  if (!resolvedTarget.startsWith(prefix)) {
    throw new AppError(400, "INVALID_PATH", "Resolved path escapes downloads directory.");
  }

  return resolvedTarget;
}

export function parseContentRangeTotal(header: string | null): {
  start: number;
  end: number;
  total: number | null;
} | null {
  if (!header) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  const total = match[3] === "*" ? null : Number.parseInt(match[3], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end, total };
}

export async function validateMp4File(
  filePath: string,
  expectedSize: number | null
): Promise<void> {
  const fileStats = await stat(filePath);
  if (!fileStats.isFile() || fileStats.size <= 0) {
    throw new AppError(502, "INCOMPLETE_FILE", "Downloaded file is empty.");
  }

  if (expectedSize !== null && expectedSize > 0 && fileStats.size !== expectedSize) {
    throw new AppError(
      502,
      "INCOMPLETE_FILE",
      `Downloaded size (${fileStats.size} bytes) does not match expected size (${expectedSize} bytes).`
    );
  }

  if (fileStats.size < 12) {
    throw new AppError(502, "INVALID_MP4", "Downloaded file is too small to be a valid MP4.");
  }

  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);
    if (bytesRead < 8 || header.subarray(4, 8).toString("ascii") !== "ftyp") {
      throw new AppError(
        502,
        "INVALID_MP4",
        "Downloaded file failed MP4 container validation (missing ftyp box)."
      );
    }
  } finally {
    await handle.close();
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Ignore missing cleanup targets.
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface EnqueueDownloadInput {
  episodeId: string;
  seriesId: string;
  quality?: number;
  episodeNumber?: number;
  dramaTitle?: string;
}

export class DownloadManager {
  private readonly config: AppConfig;
  private readonly client: FreeDramaClient;
  private readonly fetchImpl: typeof fetch;
  private readonly jobs = new Map<string, DownloadJob>();
  private readonly queue: string[] = [];
  private readonly abortControllers = new Map<string, AbortController>();
  private activeCount = 0;

  constructor(
    config: AppConfig,
    client: FreeDramaClient,
    fetchImpl: typeof fetch = fetch
  ) {
    this.config = config;
    this.client = client;
    this.fetchImpl = fetchImpl;
  }

  enqueue(input: EnqueueDownloadInput): PublicDownloadJob {
    const now = Date.now();
    const id = randomUUID();
    const job: DownloadJob = {
      id,
      episodeId: input.episodeId.trim(),
      seriesId: input.seriesId.trim(),
      episodeNumber: input.episodeNumber,
      dramaTitle: input.dramaTitle,
      requestedQuality: input.quality,
      status: "queued",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: null,
      filename: null,
      relativePath: null,
      absolutePath: null,
      error: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };

    this.jobs.set(id, job);
    this.queue.push(id);
    this.pumpQueue();

    return this.toPublicJob(job);
  }

  getJob(id: string): PublicDownloadJob | null {
    const job = this.jobs.get(id);
    return job ? this.toPublicJob(job) : null;
  }

  getInternalJob(id: string): DownloadJob | null {
    return this.jobs.get(id) ?? null;
  }

  listJobs(): PublicDownloadJob[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((job) => this.toPublicJob(job));
  }

  cancelJob(id: string): PublicDownloadJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return this.toPublicJob(job);
    }

    const queueIndex = this.queue.indexOf(id);
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1);
    }

    job.status = "cancelled";
    job.error = "Download cancelled by user.";
    job.errorCode = "CANCELLED";
    job.updatedAt = Date.now();

    const controller = this.abortControllers.get(id);
    if (controller) {
      controller.abort(new AppError(499, "CANCELLED", "Download cancelled by user."));
    }

    return this.toPublicJob(job);
  }

  private toPublicJob(job: DownloadJob): PublicDownloadJob {
    return {
      id: job.id,
      episodeId: job.episodeId,
      seriesId: job.seriesId,
      episodeNumber: job.episodeNumber,
      dramaTitle: job.dramaTitle,
      requestedQuality: job.requestedQuality,
      qualityLabel: job.selectedQualityLabel ?? null,
      status: job.status,
      progress: job.progress,
      downloadedBytes: job.downloadedBytes,
      totalBytes: job.totalBytes,
      filename: job.filename,
      error: job.error,
      errorCode: job.errorCode,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt
    };
  }

  private pumpQueue(): void {
    while (this.activeCount < this.config.downloadConcurrency && this.queue.length > 0) {
      const nextId = this.queue.shift();
      if (!nextId) break;
      const job = this.jobs.get(nextId);
      if (!job || job.status === "cancelled") continue;

      this.activeCount += 1;
      void this.processJob(job).finally(() => {
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.abortControllers.delete(job.id);
        this.pumpQueue();
      });
    }
  }

  private async checkDiskSpace(requiredBytes: number | null): Promise<void> {
    await mkdir(this.config.downloadsDir, { recursive: true });
    const stats = await statfs(this.config.downloadsDir);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const minimumNeeded =
      requiredBytes && requiredBytes > 0
        ? requiredBytes + DISK_HEADROOM_BYTES
        : MIN_FREE_DISK_BYTES;

    if (availableBytes < minimumNeeded) {
      throw new AppError(
        507,
        "INSUFFICIENT_DISK_SPACE",
        `Insufficient disk space in downloads directory (${Math.floor(availableBytes / (1024 * 1024))} MB free).`
      );
    }
  }

  private async resolveTargetPaths(
    dramaTitle: string,
    ordinal: number,
    rendition: VideoRendition,
    requestedQuality?: number
  ): Promise<{ filename: string; relativePath: string; absolutePath: string }> {
    const safeDramaDir = sanitizePathSegment(dramaTitle, "FreeDrama_Series");
    const dirPath = resolveSafePath(this.config.downloadsDir, safeDramaDir);
    await mkdir(dirPath, { recursive: true });

    const paddedEp = String(ordinal).padStart(3, "0");
    const qualityLabel = getRenditionLabel(rendition);
    const baseName = `Episode_${paddedEp}.mp4`;
    const qualifiedName = `Episode_${paddedEp}_${qualityLabel}.mp4`;

    let chosenName = requestedQuality ? qualifiedName : baseName;
    if (!requestedQuality && (await fileExists(resolveSafePath(dirPath, baseName)))) {
      chosenName = qualifiedName;
    }

    const safeFileName = sanitizePathSegment(chosenName, qualifiedName);
    const absolutePath = resolveSafePath(dirPath, safeFileName);
    const relativePath = path.join(safeDramaDir, safeFileName);

    return { filename: safeFileName, relativePath, absolutePath };
  }

  private async resolvePlaybackAndRendition(
    job: DownloadJob,
    signal: AbortSignal
  ): Promise<{
    ordinal: number;
    dramaTitle: string;
    rendition: VideoRendition;
  }> {
    let dramaTitle = job.dramaTitle?.trim() || "";
    if (!dramaTitle) {
      try {
        const seriesDetail = await this.client.getSeriesDetail(job.seriesId, signal);
        dramaTitle = seriesDetail.series.title || job.seriesId;
        job.dramaTitle = dramaTitle;
      } catch {
        dramaTitle = job.seriesId;
      }
    }

    for (let refreshAttempt = 0; refreshAttempt < 2; refreshAttempt++) {
      const playback = await this.client.getEpisodePlayback(job.episodeId, signal);
      const rendition = selectRendition(playback.renditions, job.requestedQuality);

      if (!rendition || !rendition.mp4Url) {
        throw new AppError(
          422,
          "NO_MP4_RENDITION",
          "No authorized MP4 rendition is available for this episode."
        );
      }

      if (isExpired(rendition.expiresAt)) {
        if (refreshAttempt === 0) {
          continue;
        }
        throw new AppError(
          502,
          "SIGNED_URL_EXPIRED",
          "Retrieved playback URL is already expired."
        );
      }

      return {
        ordinal: playback.ordinal || job.episodeNumber || 1,
        dramaTitle,
        rendition
      };
    }

    throw new AppError(502, "SIGNED_URL_EXPIRED", "Unable to obtain a non-expired playback URL.");
  }

  private async processJob(job: DownloadJob): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(job.id, controller);
    const signal = controller.signal;

    let partPath: string | null = null;

    try {
      job.status = "resolving";
      job.updatedAt = Date.now();

      let { ordinal, dramaTitle, rendition } = await this.resolvePlaybackAndRendition(
        job,
        signal
      );

      job.episodeNumber = ordinal;
      job.dramaTitle = dramaTitle;
      job.selectedHeight = rendition.height;
      job.selectedWidth = rendition.width;
      job.selectedQualityLabel = getRenditionLabel(rendition);

      const paths = await this.resolveTargetPaths(
        dramaTitle,
        ordinal,
        rendition,
        job.requestedQuality
      );
      job.filename = paths.filename;
      job.relativePath = paths.relativePath;
      job.absolutePath = paths.absolutePath;
      const activePartPath = `${paths.absolutePath}.part-${job.id}`;
      partPath = activePartPath;

      await this.checkDiskSpace(null);

      let refreshedExpiredOnce = false;

      for (let attempt = 0; attempt <= MAX_CDN_RETRIES; attempt++) {
        if (signal.aborted) {
          throw new AppError(499, "CANCELLED", "Download cancelled by user.");
        }

        if (isExpired(rendition.expiresAt)) {
          if (!refreshedExpiredOnce) {
            refreshedExpiredOnce = true;
            const refreshed = await this.resolvePlaybackAndRendition(job, signal);
            rendition = refreshed.rendition;
          } else {
            throw new AppError(502, "SIGNED_URL_EXPIRED", "Signed video URL expired.");
          }
        }

        const mp4Url = assertApprovedUrl(rendition.mp4Url!, APPROVED_CDN_HOSTS);

        job.status = "downloading";
        job.downloadedBytes = 0;
        job.progress = 0;
        job.updatedAt = Date.now();

        try {
          const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
          const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

          const response = await this.fetchImpl(mp4Url.toString(), {
            method: "GET",
            redirect: "follow",
            signal: combinedSignal
          });

          if (response.status === 401 || response.status === 403) {
            if (!refreshedExpiredOnce) {
              refreshedExpiredOnce = true;
              const refreshed = await this.resolvePlaybackAndRendition(job, signal);
              rendition = refreshed.rendition;
              continue;
            }
            throw new AppError(
              response.status,
              "CDN_ACCESS_DENIED",
              `CDN rejected video download with HTTP ${response.status}.`
            );
          }

          if (response.status === 404) {
            throw new AppError(404, "VIDEO_NOT_FOUND", "Video resource was not found on CDN.");
          }

          if (response.status === 429) {
            const retryAfter = parseRetryAfterSeconds(response.headers.get("retry-after"));
            if (attempt < MAX_CDN_RETRIES && retryAfter !== undefined && retryAfter <= 10) {
              await sleep(Math.max(retryAfter, 1) * 1000, signal);
              continue;
            }
            throw new AppError(
              429,
              "RATE_LIMITED",
              "CDN rate limit reached. Please try again shortly.",
              retryAfter
            );
          }

          if (response.status >= 500) {
            if (attempt < MAX_CDN_RETRIES) {
              await sleep(1000 * (attempt + 1), signal);
              continue;
            }
            throw new AppError(
              502,
              "CDN_SERVER_ERROR",
              `CDN returned HTTP ${response.status}.`
            );
          }

          if (response.status !== 200 && response.status !== 206) {
            throw new AppError(
              502,
              "CDN_HTTP_ERROR",
              `Video download failed with HTTP ${response.status}.`
            );
          }

          const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
          if (
            contentType &&
            !contentType.includes("video/") &&
            !contentType.includes("application/octet-stream")
          ) {
            throw new AppError(
              502,
              "INVALID_CONTENT_TYPE",
              `Unexpected video content type: ${contentType}`
            );
          }

          let expectedBytes: number | null = null;
          const contentLengthHeader = response.headers.get("content-length");
          if (contentLengthHeader) {
            const parsedLength = Number.parseInt(contentLengthHeader, 10);
            if (Number.isFinite(parsedLength) && parsedLength > 0) {
              expectedBytes = parsedLength;
            }
          }

          if (response.status === 206) {
            const rangeInfo = parseContentRangeTotal(response.headers.get("content-range"));
            if (rangeInfo) {
              if (rangeInfo.start !== 0) {
                throw new AppError(
                  502,
                  "INVALID_CONTENT_RANGE",
                  `Unexpected non-zero byte offset (${rangeInfo.start}) for full download.`
                );
              }
              if (rangeInfo.total !== null) {
                expectedBytes = rangeInfo.total;
              }
            }
          }

          job.totalBytes = expectedBytes;
          await this.checkDiskSpace(expectedBytes);

          if (!response.body) {
            throw new AppError(502, "EMPTY_RESPONSE", "Empty video response body.");
          }

          const counterStream = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              job.downloadedBytes += chunk.length;
              if (job.totalBytes && job.totalBytes > 0) {
                job.progress = Math.min(
                  99,
                  Math.floor((job.downloadedBytes / job.totalBytes) * 100)
                );
              }
              job.updatedAt = Date.now();
              callback(null, chunk);
            }
          });

          await pipeline(
            Readable.fromWeb(response.body as any),
            counterStream,
            createWriteStream(activePartPath),
            { signal: combinedSignal }
          );

          await validateMp4File(activePartPath, expectedBytes);
          await rename(activePartPath, paths.absolutePath);
          partPath = null;

          const finalStats = await stat(paths.absolutePath);
          job.downloadedBytes = finalStats.size;
          job.totalBytes = finalStats.size;
          job.progress = 100;
          job.status = "completed";
          job.completedAt = Date.now();
          job.updatedAt = Date.now();
          return;
        } catch (err) {
          if (partPath) {
            await safeUnlink(partPath);
          }

          if (signal.aborted || (err instanceof AppError && err.code === "CANCELLED")) {
            throw new AppError(499, "CANCELLED", "Download cancelled by user.");
          }

          if (err instanceof AppError) {
            // Do not retry permanent validation, auth, disk-space, or 404 failures.
            if (
              err.statusCode === 401 ||
              err.statusCode === 403 ||
              err.statusCode === 404 ||
              err.statusCode === 422 ||
              err.statusCode === 507 ||
              err.code === "INVALID_CONTENT_TYPE" ||
              err.code === "INVALID_MP4"
            ) {
              throw err;
            }
          }

          if (attempt < MAX_CDN_RETRIES) {
            await sleep(1000 * (attempt + 1), signal);
            continue;
          }

          throw err;
        }
      }
    } catch (err) {
      if (partPath) {
        await safeUnlink(partPath);
      }

      if (signal.aborted || (err instanceof AppError && err.code === "CANCELLED")) {
        job.status = "cancelled";
        job.error = "Download cancelled by user.";
        job.errorCode = "CANCELLED";
        job.updatedAt = Date.now();
        return;
      }

      const appErr =
        err instanceof AppError
          ? err
          : new AppError(
              500,
              "DOWNLOAD_FAILED",
              err instanceof Error ? err.message : "Download failed."
            );

      job.status = "failed";
      job.error = appErr.message;
      job.errorCode = appErr.code;
      job.updatedAt = Date.now();
    }
  }
}
