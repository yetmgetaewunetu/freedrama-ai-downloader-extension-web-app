import { useCallback, useEffect, useMemo, useState } from "react";
import type { PublicEpisodeSummary, PublicRendition } from "../../../shared/src/types.js";
import type {
  ApiResponse,
  ExtensionDownloadJob,
  InspectedDramaState,
  PageContext,
  RuntimeRequest
} from "../types/messages.js";

function sendRuntimeMessage<T>(message: RuntimeRequest): Promise<ApiResponse<T>> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: ApiResponse<T> | undefined) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message || "Extension runtime unavailable."
        });
        return;
      }
      resolve(response ?? { ok: false, error: "No response from background worker." });
    });
  });
}

async function queryActiveFreeDramaContext(): Promise<PageContext | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;

  if (tab.url && !tab.url.startsWith("https://freedrama.ai") && !tab.url.startsWith("https://www.freedrama.ai")) {
    return {
      supported: false,
      kind: "other",
      url: tab.url,
      title: tab.title
    };
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tab.id!,
      { type: "GET_PAGE_CONTEXT" } satisfies RuntimeRequest,
      (response: ApiResponse<PageContext> | undefined) => {
        if (chrome.runtime.lastError || !response?.ok || !response.data) {
          if (tab.url) {
            resolve({
              supported:
                tab.url.includes("freedrama.ai/show/") ||
                /freedrama\.ai\/[a-z]{2}(?:-[a-z]{2})?\/show\//i.test(tab.url),
              kind: "drama",
              url: tab.url,
              title: tab.title
            });
            return;
          }
          resolve(null);
          return;
        }
        resolve(response.data);
      }
    );
  });
}

export function useExtensionState() {
  const [pageContext, setPageContext] = useState<PageContext | null>(null);
  const [inspected, setInspected] = useState<InspectedDramaState | null>(null);
  const [episodeRenditionsMap, setEpisodeRenditionsMap] = useState<
    Record<string, PublicRendition[]>
  >({});
  const [jobs, setJobs] = useState<ExtensionDownloadJob[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedQuality, setSelectedQuality] = useState<string>("auto");
  const [loading, setLoading] = useState(true);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const inspectUrl = useCallback(async (url: string) => {
    setInspecting(true);
    setError(null);
    setNotice(null);

    const res = await sendRuntimeMessage<InspectedDramaState>({
      type: "INSPECT_URL",
      url
    });

    if (!res.ok || !res.data) {
      setError(res.error || "Failed to inspect FreeDrama URL.");
      setInspecting(false);
      return;
    }

    const next = res.data;
    setInspected(next);
    setNotice(next.episodeNotice ?? null);

    if (next.currentEpisodeId && next.currentRenditions) {
      setEpisodeRenditionsMap((prev) => ({
        ...prev,
        [next.currentEpisodeId!]: next.currentRenditions!
      }));
      setSelectedIds(new Set([next.currentEpisodeId]));
    } else {
      setSelectedIds(new Set());
    }

    setInspecting(false);
  }, []);

  const refreshActiveTab = useCallback(async () => {
    setError(null);
    const [ctx, stateRes] = await Promise.all([
      queryActiveFreeDramaContext(),
      sendRuntimeMessage<{
        jobs: ExtensionDownloadJob[];
        lastInspected: InspectedDramaState | null;
      }>({ type: "GET_STATE" })
    ]);

    if (ctx) setPageContext(ctx);
    if (stateRes.ok && stateRes.data) {
      setJobs(stateRes.data.jobs);
      if (stateRes.data.lastInspected) {
        setInspected(stateRes.data.lastInspected);
        if (
          stateRes.data.lastInspected.currentEpisodeId &&
          stateRes.data.lastInspected.currentRenditions
        ) {
          setEpisodeRenditionsMap((prev) => ({
            ...prev,
            [stateRes.data!.lastInspected!.currentEpisodeId!]:
              stateRes.data!.lastInspected!.currentRenditions!
          }));
        }
      }
    }

    if (ctx?.supported && ctx.url) {
      await inspectUrl(ctx.url);
    }

    setLoading(false);
  }, [inspectUrl]);

  useEffect(() => {
    void refreshActiveTab();
  }, [refreshActiveTab]);

  const hasActiveDownloads = useMemo(
    () =>
      jobs.some(
        (j) => j.status === "queued" || j.status === "resolving" || j.status === "downloading"
      ),
    [jobs]
  );

  useEffect(() => {
    const interval = setInterval(
      () => {
        void sendRuntimeMessage<ExtensionDownloadJob[]>({ type: "SYNC_PROGRESS" }).then(
          (res) => {
            if (res.ok && res.data) {
              setJobs(res.data);
            }
          }
        );
      },
      hasActiveDownloads ? 650 : 2500
    );

    return () => clearInterval(interval);
  }, [hasActiveDownloads]);

  const inspectEpisodeQualities = useCallback(async (episodeId: string) => {
    setNotice(null);
    const res = await sendRuntimeMessage<PublicRendition[]>({
      type: "INSPECT_EPISODE_RENDITIONS",
      episodeId
    });
    if (!res.ok || !res.data) {
      setNotice(res.error || "Unable to inspect episode renditions.");
      return;
    }
    setEpisodeRenditionsMap((prev) => ({
      ...prev,
      [episodeId]: res.data!
    }));
  }, []);

  const enqueueEpisodes = useCallback(
    async (episodes: PublicEpisodeSummary[]) => {
      if (!inspected?.drama || episodes.length === 0) return;
      setNotice(null);

      const quality =
        selectedQuality === "auto" ? undefined : Number.parseInt(selectedQuality, 10);

      const res = await sendRuntimeMessage<{
        added: number;
        skippedDuplicates: number;
        jobs: ExtensionDownloadJob[];
      }>({
        type: "ENQUEUE_DOWNLOADS",
        dramaTitle: inspected.drama.title,
        seriesId: inspected.drama.id,
        episodes: episodes.map((e) => ({ episodeId: e.id, episodeNumber: e.number })),
        quality
      });

      if (!res.ok || !res.data) {
        setError(res.error || "Failed to queue downloads.");
        return;
      }

      setJobs(res.data.jobs);
      if (res.data.skippedDuplicates > 0 && res.data.added === 0) {
        setNotice("Selected episode(s) are already in the active download queue.");
      } else if (res.data.skippedDuplicates > 0) {
        setNotice(
          `Queued ${res.data.added} download(s); skipped ${res.data.skippedDuplicates} duplicate active job(s).`
        );
      }
    },
    [inspected, selectedQuality]
  );

  const cancelDownload = useCallback(async (jobId: string) => {
    const res = await sendRuntimeMessage<ExtensionDownloadJob[]>({
      type: "CANCEL_DOWNLOAD",
      jobId
    });
    if (res.ok && res.data) {
      setJobs(res.data);
    }
  }, []);

  const clearFinishedDownloads = useCallback(async () => {
    const res = await sendRuntimeMessage<ExtensionDownloadJob[]>({
      type: "CLEAR_FINISHED_DOWNLOADS"
    });
    if (res.ok && res.data) {
      setJobs(res.data);
    }
  }, []);

  const showDownloadInFolder = useCallback(async (chromeDownloadId: number) => {
    await sendRuntimeMessage({ type: "SHOW_DOWNLOAD_FILE", chromeDownloadId });
  }, []);

  const toggleEpisode = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (!inspected?.drama) return;
    setSelectedIds(new Set(inspected.drama.episodes.map((e) => e.id)));
  }, [inspected]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  return {
    pageContext,
    inspected,
    episodeRenditionsMap,
    jobs,
    selectedIds,
    selectedQuality,
    loading,
    inspecting,
    error,
    notice,
    setSelectedQuality,
    inspectUrl,
    refreshActiveTab,
    inspectEpisodeQualities,
    enqueueEpisodes,
    cancelDownload,
    clearFinishedDownloads,
    showDownloadInFolder,
    toggleEpisode,
    selectAll,
    deselectAll
  };
}
