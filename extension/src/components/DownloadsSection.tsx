import { AlertCircle, CheckCircle2, FolderOpen, X, XCircle } from "lucide-react";
import type { ExtensionDownloadJob } from "../types/messages.js";
import { formatBytes } from "../utils/format.js";

interface DownloadsSectionProps {
  jobs: ExtensionDownloadJob[];
  onCancel: (jobId: string) => Promise<void>;
  onClearFinished: () => Promise<void>;
  onShowInFolder: (chromeDownloadId: number) => Promise<void>;
}

const STATUS_BADGE: Record<ExtensionDownloadJob["status"], string> = {
  queued: "bg-slate-800 text-slate-300",
  resolving: "bg-amber-950/70 text-amber-300",
  downloading: "bg-sky-950/70 text-sky-300",
  completed: "bg-emerald-950/70 text-emerald-300",
  failed: "bg-rose-950/70 text-rose-300",
  cancelled: "bg-zinc-800 text-zinc-400"
};

export function DownloadsSection({
  jobs,
  onCancel,
  onClearFinished,
  onShowInFolder
}: DownloadsSectionProps) {
  const hasFinished = jobs.some(
    (j) => j.status === "completed" || j.status === "failed" || j.status === "cancelled"
  );

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Downloads ({jobs.length})
        </h2>
        {hasFinished && (
          <button
            type="button"
            onClick={() => void onClearFinished()}
            className="text-[11px] text-slate-400 hover:text-slate-200"
          >
            Clear finished
          </button>
        )}
      </div>

      {jobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/40 py-5 text-center text-xs text-slate-500">
          No active or recent downloads.
        </div>
      ) : (
        <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
          {jobs.map((job) => {
            const isActive =
              job.status === "queued" ||
              job.status === "resolving" ||
              job.status === "downloading";

            return (
              <div
                key={job.id}
                className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-slate-100">
                      {job.dramaTitle} — Ep {String(job.episodeNumber).padStart(3, "0")}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                      <span className="font-mono text-indigo-300">
                        {job.qualityLabel ?? "Auto"}
                      </span>
                      <span>•</span>
                      <span>
                        {formatBytes(job.downloadedBytes)}
                        {job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : ""}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <span
                      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[job.status]}`}
                    >
                      {job.status === "completed" && <CheckCircle2 className="h-3 w-3" />}
                      {job.status === "failed" && <XCircle className="h-3 w-3" />}
                      {job.status}
                    </span>

                    {isActive && (
                      <button
                        type="button"
                        title="Cancel download"
                        onClick={() => void onCancel(job.id)}
                        className="rounded border border-rose-800/60 bg-rose-950/50 p-1 text-rose-300 hover:bg-rose-900/60"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}

                    {job.status === "completed" && job.chromeDownloadId !== null && (
                      <button
                        type="button"
                        title="Show in folder"
                        onClick={() => void onShowInFolder(job.chromeDownloadId!)}
                        className="rounded border border-emerald-700/60 bg-emerald-950/50 p-1 text-emerald-300 hover:bg-emerald-900/60"
                      >
                        <FolderOpen className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>

                {(isActive || job.status === "completed") && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className={`h-full transition-all ${
                          job.status === "completed" ? "bg-emerald-500" : "bg-indigo-500"
                        }`}
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                    <span className="w-8 text-right font-mono text-[10px] text-slate-400">
                      {job.progress}%
                    </span>
                  </div>
                )}

                {job.error && (
                  <div className="mt-1.5 flex items-start gap-1 text-[11px] text-rose-300">
                    <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{job.error}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
