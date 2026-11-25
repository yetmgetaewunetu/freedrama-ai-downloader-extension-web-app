import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Film,
  FolderDown,
  Loader2,
  Lock,
  Search,
  Sparkles,
  Unlock,
  XCircle
} from "lucide-react";
import type {
  DownloadJob,
  DramaSummary,
  EpisodeSummary,
  HealthInfo,
  InspectedEpisode,
  RenditionOption
} from "./types.js";

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "--";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function triggerBrowserSave(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

const DEFAULT_QUALITIES: RenditionOption[] = [
  { height: 1920, width: 1080, label: "1080p" },
  { height: 960, width: 540, label: "540p" }
];

const STATUS_BADGE_STYLES: Record<DownloadJob["status"], string> = {
  queued: "bg-slate-800 text-slate-300 border-slate-700",
  resolving: "bg-amber-950/60 text-amber-300 border-amber-700/60",
  downloading: "bg-sky-950/60 text-sky-300 border-sky-700/60",
  completed: "bg-emerald-950/60 text-emerald-300 border-emerald-700/60",
  failed: "bg-rose-950/60 text-rose-300 border-rose-700/60",
  cancelled: "bg-zinc-900 text-zinc-400 border-zinc-700"
};

export default function App() {
  const [urlInput, setUrlInput] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [episodeNotice, setEpisodeNotice] = useState<string | null>(null);

  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [drama, setDrama] = useState<DramaSummary | null>(null);
  const [inspectedEpisode, setInspectedEpisode] = useState<InspectedEpisode | null>(null);
  const [selectedQuality, setSelectedQuality] = useState<string>("auto");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [queueError, setQueueError] = useState<string | null>(null);

  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const activeCountRef = useRef(0);
  const jobsRef = useRef<DownloadJob[]>([]);

  const updateJob = useCallback((jobId: string, patch: Partial<DownloadJob>) => {
    setJobs((prev) => {
      const next = prev.map((j) =>
        j.id === jobId ? { ...j, ...patch, updatedAt: Date.now() } : j
      );
      jobsRef.current = next;
      return next;
    });
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      if (res.ok) {
        setHealth((await res.json()) as HealthInfo);
      }
    } catch {
      // Ignore transient startup errors.
    }
  }, []);

  useEffect(() => {
    void fetchHealth();
  }, [fetchHealth]);

  const qualityOptions = useMemo(() => {
    if (inspectedEpisode && inspectedEpisode.renditions.length > 0) {
      return [...inspectedEpisode.renditions].sort((a, b) => b.height - a.height);
    }
    return DEFAULT_QUALITIES;
  }, [inspectedEpisode]);

  const latestJobByEpisodeId = useMemo(() => {
    const map = new Map<string, DownloadJob>();
    for (const job of jobs) {
      if (!map.has(job.episodeId)) {
        map.set(job.episodeId, job);
      }
    }
    return map;
  }, [jobs]);

  const runBrowserDownload = useCallback(
    async (job: DownloadJob) => {
      const controller = new AbortController();
      abortControllersRef.current.set(job.id, controller);

      try {
        updateJob(job.id, { status: "resolving", error: null, errorCode: null });

        const params = new URLSearchParams();
        params.set("seriesId", job.seriesId);
        if (job.dramaTitle) params.set("dramaTitle", job.dramaTitle);
        if (job.requestedQuality) params.set("quality", String(job.requestedQuality));

        const response = await fetch(
          `/api/episodes/${encodeURIComponent(job.episodeId)}/stream?${params.toString()}`,
          { signal: controller.signal }
        );

        if (!response.ok) {
          let message = `Download failed (HTTP ${response.status}).`;
          let errorCode = "DOWNLOAD_FAILED";
          try {
            const payload = (await response.json()) as {
              message?: string;
              error?: string;
            };
            if (payload.message) message = payload.message;
            if (payload.error) errorCode = payload.error;
          } catch {
            // Keep default HTTP message.
          }
          updateJob(job.id, { status: "failed", error: message, errorCode });
          return;
        }

        const headerTotal = Number.parseInt(
          response.headers.get("content-length") || "",
          10
        );
        const totalBytes =
          Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : null;
        const resolvedQuality =
          response.headers.get("x-rendition-quality") || job.qualityLabel;

        const disposition = response.headers.get("content-disposition") || "";
        const filenameMatch = /filename="([^"]+)"/i.exec(disposition);
        const filename =
          filenameMatch?.[1] ||
          `Episode_${String(job.episodeNumber ?? 1).padStart(3, "0")}.mp4`;

        updateJob(job.id, {
          status: "downloading",
          totalBytes,
          qualityLabel: resolvedQuality,
          filename,
          downloadedBytes: 0,
          progress: 0
        });

        if (!response.body) {
          throw new Error("Empty stream received from server.");
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let received = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
            copy.set(value);
            chunks.push(copy);
            received += value.byteLength;
            const progress =
              totalBytes && totalBytes > 0
                ? Math.min(99, Math.floor((received / totalBytes) * 100))
                : 0;
            updateJob(job.id, { downloadedBytes: received, progress });
          }
        }

        const blob = new Blob(chunks, { type: "video/mp4" });
        triggerBrowserSave(blob, filename);

        updateJob(job.id, {
          status: "completed",
          progress: 100,
          downloadedBytes: blob.size,
          totalBytes: blob.size,
          completedAt: Date.now()
        });
      } catch (err) {
        if (controller.signal.aborted) {
          updateJob(job.id, {
            status: "cancelled",
            error: "Download cancelled by user.",
            errorCode: "CANCELLED"
          });
          return;
        }
        updateJob(job.id, {
          status: "failed",
          error: err instanceof Error ? err.message : "Download failed.",
          errorCode: "DOWNLOAD_FAILED"
        });
      } finally {
        abortControllersRef.current.delete(job.id);
      }
    },
    [updateJob]
  );

  const pumpQueue = useCallback(() => {
    const maxConcurrency = health?.concurrency ?? 2;
    while (activeCountRef.current < maxConcurrency) {
      const nextJob = [...jobsRef.current]
        .reverse()
        .find((j) => j.status === "queued");
      if (!nextJob) break;

      activeCountRef.current += 1;
      updateJob(nextJob.id, { status: "resolving" });

      void runBrowserDownload(nextJob).finally(() => {
        activeCountRef.current = Math.max(0, activeCountRef.current - 1);
        pumpQueue();
      });
    }
  }, [health?.concurrency, runBrowserDownload, updateJob]);

  async function handleInspect(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setInspectError("Please paste a FreeDrama.ai show or episode URL.");
      return;
    }

    setInspecting(true);
    setInspectError(null);
    setEpisodeNotice(null);
    setInspectedEpisode(null);

    try {
      const dramaRes = await fetch("/api/drama/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed })
      });
      const dramaPayload = await dramaRes.json();

      if (!dramaRes.ok || !dramaPayload.success) {
        throw new Error(dramaPayload.message || "Failed to inspect FreeDrama URL.");
      }

      const loadedDrama = dramaPayload.drama as DramaSummary;
      setDrama(loadedDrama);

      if (dramaPayload.inspectedKind === "episode" && dramaPayload.matchedEpisodeNumber) {
        const matchedEp = loadedDrama.episodes.find(
          (ep) => ep.number === dramaPayload.matchedEpisodeNumber
        );
        if (matchedEp) {
          setSelectedIds(new Set([matchedEp.id]));
        } else {
          setSelectedIds(new Set());
        }

        const epRes = await fetch("/api/episode/inspect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed })
        });
        const epPayload = await epRes.json();
        if (epRes.ok && epPayload.success) {
          setInspectedEpisode(epPayload.episode as InspectedEpisode);
        } else {
          setEpisodeNotice(
            epPayload.message ||
              `Episode ${dramaPayload.matchedEpisodeNumber} playback details are unavailable without an authorized VIP session.`
          );
        }
      } else {
        setSelectedIds(new Set());
      }
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : "Inspection failed.");
    } finally {
      setInspecting(false);
    }
  }

  async function handleInspectSingleEpisode(ep: EpisodeSummary) {
    if (!drama) return;
    setEpisodeNotice(null);
    const epUrl = `https://freedrama.ai/en/show/${drama.slug}/${ep.number}`;

    try {
      const res = await fetch("/api/episode/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: epUrl })
      });
      const payload = await res.json();
      if (!res.ok || !payload.success) {
        setEpisodeNotice(
          payload.message || `Unable to inspect Episode ${ep.number} qualities.`
        );
        return;
      }
      setInspectedEpisode(payload.episode as InspectedEpisode);
    } catch (err) {
      setEpisodeNotice(
        err instanceof Error ? err.message : "Failed to inspect episode qualities."
      );
    }
  }

  function enqueueEpisodes(episodes: EpisodeSummary[]) {
    if (!drama || episodes.length === 0) return;
    setQueueError(null);

    const qualityValue =
      selectedQuality === "auto" ? undefined : Number.parseInt(selectedQuality, 10);
    const qualityLabel =
      qualityValue === 1920 || qualityValue === 1080
        ? "1080p"
        : qualityValue === 960 || qualityValue === 540
          ? "540p"
          : qualityValue
            ? `${qualityValue}p`
            : null;

    const now = Date.now();
    const newJobs: DownloadJob[] = [];

    for (const ep of episodes) {
      const duplicate = jobsRef.current.find(
        (j) =>
          j.episodeId === ep.id &&
          j.requestedQuality === qualityValue &&
          (j.status === "queued" ||
            j.status === "resolving" ||
            j.status === "downloading")
      );
      if (duplicate) continue;

      newJobs.push({
        id: crypto.randomUUID(),
        episodeId: ep.id,
        seriesId: drama.id,
        episodeNumber: ep.number,
        dramaTitle: drama.title,
        requestedQuality: qualityValue,
        qualityLabel,
        status: "queued",
        progress: 0,
        downloadedBytes: 0,
        totalBytes: null,
        filename: null,
        error: null,
        errorCode: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null
      });
    }

    if (newJobs.length === 0) {
      setQueueError("Selected episode(s) are already in the active download queue.");
      return;
    }

    const updated = [...newJobs.reverse(), ...jobsRef.current];
    jobsRef.current = updated;
    setJobs(updated);
    pumpQueue();
  }

  function handleCancelJob(jobId: string) {
    const controller = abortControllersRef.current.get(jobId);
    if (controller) {
      controller.abort();
      return;
    }
    updateJob(jobId, {
      status: "cancelled",
      error: "Download cancelled by user.",
      errorCode: "CANCELLED"
    });
  }

  function toggleEpisode(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const selectedEpisodes = useMemo(() => {
    if (!drama) return [];
    return drama.episodes.filter((ep) => selectedIds.has(ep.id));
  }, [drama, selectedIds]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800/80 bg-slate-900/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/20 text-indigo-400 ring-1 ring-indigo-500/40">
              <Film className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-white">
                FreeDrama.ai Video Downloader
              </h1>
              <p className="text-xs text-slate-400">
                Direct browser MP4 downloads — saved straight to your PC Downloads folder
              </p>
            </div>
          </div>

          {health && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
                  health.hasSessionCookie
                    ? "border-emerald-700/60 bg-emerald-950/60 text-emerald-300"
                    : "border-amber-700/60 bg-amber-950/60 text-amber-300"
                }`}
              >
                {health.hasSessionCookie ? (
                  <Unlock className="h-3.5 w-3.5" />
                ) : (
                  <Lock className="h-3.5 w-3.5" />
                )}
                {health.hasSessionCookie
                  ? "Authorized cookie configured"
                  : "Unauthenticated (free episodes only)"}
              </span>
              <span className="rounded-full border border-slate-800 bg-slate-900 px-2.5 py-1 text-slate-400">
                Concurrency: {health.concurrency}
              </span>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
        {/* URL Inspector */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
          <form onSubmit={handleInspect} className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://freedrama.ai/en/show/love-is-a-dangerous-game-2-45153c99/1"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2.5 pl-10 pr-4 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>
            <button
              type="submit"
              disabled={inspecting}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {inspecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Inspecting...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Inspect
                </>
              )}
            </button>
          </form>

          {inspectError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-800/60 bg-rose-950/40 px-3.5 py-2.5 text-sm text-rose-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <span>{inspectError}</span>
            </div>
          )}

          {episodeNotice && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-800/60 bg-amber-950/40 px-3.5 py-2.5 text-sm text-amber-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <span>{episodeNotice}</span>
            </div>
          )}
        </section>

        {/* Drama Details & Episode List */}
        {drama && (
          <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              {drama.thumbnail ? (
                <img
                  src={drama.thumbnail}
                  alt={drama.title}
                  className="h-40 w-28 shrink-0 rounded-xl border border-slate-800 object-cover"
                />
              ) : (
                <div className="flex h-40 w-28 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-slate-600">
                  <Film className="h-8 w-8" />
                </div>
              )}

              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold text-white">{drama.title}</h2>
                  <span className="rounded-md bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                    {drama.episodes.length} Episodes
                  </span>
                  {drama.freeEpisodes !== undefined && (
                    <span className="rounded-md bg-emerald-950/60 px-2 py-0.5 text-xs text-emerald-300 ring-1 ring-emerald-700/50">
                      {drama.freeEpisodes} Free
                    </span>
                  )}
                </div>

                {drama.synopsis && (
                  <p className="line-clamp-3 text-sm text-slate-400">{drama.synopsis}</p>
                )}

                <p className="text-xs text-slate-500">Series ID: {drama.id}</p>

                {inspectedEpisode && (
                  <div className="mt-2 inline-flex flex-wrap items-center gap-2 rounded-lg border border-indigo-800/50 bg-indigo-950/30 px-3 py-1.5 text-xs text-indigo-200">
                    <span className="font-medium">
                      Inspected Episode {inspectedEpisode.number}:
                    </span>
                    {inspectedEpisode.renditions.map((r) => (
                      <span
                        key={r.height}
                        className="rounded bg-indigo-900/60 px-1.5 py-0.5 font-mono text-[11px]"
                      >
                        {r.label} ({r.width}x{r.height})
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Controls Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-slate-800 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set(drama.episodes.map((e) => e.id)))}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
                >
                  Select All
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(
                      new Set(
                        drama.episodes
                          .filter((e) => e.lock === "free")
                          .map((e) => e.id)
                      )
                    )
                  }
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
                >
                  Select Free
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200"
                >
                  Clear
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <span>Quality:</span>
                  <select
                    value={selectedQuality}
                    onChange={(e) => setSelectedQuality(e.target.value)}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="auto">Auto (Highest)</option>
                    {qualityOptions.map((q) => (
                      <option key={q.height} value={String(q.height)}>
                        {q.label} ({q.width}x{q.height})
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  disabled={selectedEpisodes.length === 0}
                  onClick={() => enqueueEpisodes(selectedEpisodes)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download Selected ({selectedEpisodes.length})
                </button>

                <button
                  type="button"
                  onClick={() => enqueueEpisodes(drama.episodes)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/50 bg-indigo-950/50 px-3.5 py-1.5 text-xs font-medium text-indigo-200 hover:bg-indigo-900/50"
                >
                  <FolderDown className="h-3.5 w-3.5" />
                  Download All
                </button>
              </div>
            </div>

            {queueError && (
              <div className="flex items-start gap-2 rounded-xl border border-rose-800/60 bg-rose-950/40 px-3.5 py-2 text-xs text-rose-200">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                <span>{queueError}</span>
              </div>
            )}

            {/* Episode Table */}
            <div className="max-h-[420px] overflow-auto rounded-xl border border-slate-800">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="sticky top-0 bg-slate-950/95 text-xs uppercase text-slate-400 backdrop-blur">
                  <tr>
                    <th className="w-10 px-3 py-2.5"></th>
                    <th className="px-3 py-2.5">#</th>
                    <th className="px-3 py-2.5">Title</th>
                    <th className="px-3 py-2.5">Duration</th>
                    <th className="px-3 py-2.5">Access</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {drama.episodes.map((ep) => {
                    const checked = selectedIds.has(ep.id);
                    const job = latestJobByEpisodeId.get(ep.id);
                    const isFree = ep.lock === "free";

                    return (
                      <tr
                        key={ep.id}
                        className={`transition hover:bg-slate-800/40 ${
                          checked ? "bg-indigo-950/20" : ""
                        }`}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleEpisode(ep.id)}
                            aria-label={`Select Episode ${ep.number}`}
                            className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                          />
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-300">
                          {String(ep.number).padStart(3, "0")}
                        </td>
                        <td className="px-3 py-2 font-medium text-slate-100">{ep.title}</td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-400">
                          {formatDuration(ep.duration)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                              isFree
                                ? "border-emerald-700/50 bg-emerald-950/50 text-emerald-300"
                                : "border-amber-700/50 bg-amber-950/50 text-amber-300"
                            }`}
                          >
                            {isFree ? "Free" : "VIP"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {job ? (
                            <span
                              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${STATUS_BADGE_STYLES[job.status]}`}
                            >
                              {job.status}
                              {job.status === "downloading" ? ` (${job.progress}%)` : ""}
                            </span>
                          ) : (
                            <span className="text-slate-500">Idle</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => void handleInspectSingleEpisode(ep)}
                              className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
                            >
                              Qualities
                            </button>
                            <button
                              type="button"
                              onClick={() => enqueueEpisodes([ep])}
                              className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1 text-xs font-medium text-indigo-300 hover:bg-indigo-600 hover:text-white"
                            >
                              <Download className="h-3 w-3" />
                              Download
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Download Queue */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">Download Queue</h2>
            <span className="text-xs text-slate-500">
              Files stream directly to your browser Downloads folder (not stored on server)
            </span>
          </div>

          {jobs.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-800 py-8 text-center text-sm text-slate-500">
              No downloads queued yet. Inspect a drama or episode above to get started.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-slate-950 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-3 py-2.5">Episode</th>
                    <th className="px-3 py-2.5">Quality</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="w-44 px-3 py-2.5">Progress</th>
                    <th className="px-3 py-2.5">Size</th>
                    <th className="px-3 py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {jobs.map((job) => {
                    const isActive =
                      job.status === "queued" ||
                      job.status === "resolving" ||
                      job.status === "downloading";

                    return (
                      <tr key={job.id} className="align-top">
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-slate-100">
                            {job.dramaTitle || job.seriesId}
                            {job.episodeNumber !== undefined
                              ? ` — Episode ${String(job.episodeNumber).padStart(3, "0")}`
                              : ""}
                          </div>
                          {job.filename && (
                            <div className="font-mono text-[11px] text-slate-500">
                              {job.filename}
                            </div>
                          )}
                          {job.error && (
                            <div className="mt-1 flex items-start gap-1 text-xs text-rose-300">
                              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                              <span>{job.error}</span>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-slate-300">
                          {job.qualityLabel ??
                            (job.requestedQuality ? `${job.requestedQuality}h` : "Auto")}
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${STATUS_BADGE_STYLES[job.status]}`}
                          >
                            {job.status === "completed" && (
                              <CheckCircle2 className="h-3 w-3" />
                            )}
                            {job.status === "failed" && <XCircle className="h-3 w-3" />}
                            {job.status}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
                              <div
                                className={`h-full transition-all ${
                                  job.status === "completed"
                                    ? "bg-emerald-500"
                                    : job.status === "failed"
                                      ? "bg-rose-500"
                                      : "bg-indigo-500"
                                }`}
                                style={{ width: `${job.progress}%` }}
                              />
                            </div>
                            <span className="w-9 text-right font-mono text-xs text-slate-300">
                              {job.progress}%
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-slate-300">
                          {formatBytes(job.downloadedBytes)}
                          {job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : ""}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {isActive ? (
                            <button
                              type="button"
                              onClick={() => handleCancelJob(job.id)}
                              className="rounded-lg border border-rose-800/60 bg-rose-950/40 px-2.5 py-1 text-xs font-medium text-rose-200 hover:bg-rose-900/50"
                            >
                              Cancel
                            </button>
                          ) : job.status === "completed" ? (
                            <span className="text-xs text-emerald-400">Saved to PC</span>
                          ) : (
                            <span className="text-xs text-slate-500">--</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
