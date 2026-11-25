import { useState } from "react";
import { Film, RefreshCw, Search } from "lucide-react";
import type { InspectedDramaState, PageContext } from "../types/messages.js";

interface CurrentDramaSectionProps {
  pageContext: PageContext | null;
  inspected: InspectedDramaState | null;
  inspecting: boolean;
  onInspectUrl: (url: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function CurrentDramaSection({
  pageContext,
  inspected,
  inspecting,
  onInspectUrl,
  onRefresh
}: CurrentDramaSectionProps) {
  const [manualUrl, setManualUrl] = useState("");
  const drama = inspected?.drama ?? null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!manualUrl.trim()) return;
    await onInspectUrl(manualUrl.trim());
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Current Drama
        </h2>
        <button
          type="button"
          disabled={inspecting}
          onClick={() => void (inspected?.url ? onInspectUrl(inspected.url) : onRefresh())}
          className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${inspecting ? "animate-spin" : ""}`} />
          {inspecting ? "Inspecting..." : "Refresh"}
        </button>
      </div>

      {drama ? (
        <div className="flex items-start gap-3">
          {drama.thumbnail ? (
            <img
              src={drama.thumbnail}
              alt={drama.title}
              className="h-16 w-12 shrink-0 rounded-lg border border-slate-800 object-cover"
            />
          ) : (
            <div className="flex h-16 w-12 shrink-0 items-center justify-center rounded-lg border border-slate-800 bg-slate-950 text-slate-600">
              <Film className="h-5 w-5" />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-white">{drama.title}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">
                {drama.episodes.length} episodes
              </span>
              {drama.freeEpisodes !== undefined && (
                <span className="rounded bg-emerald-950/70 px-1.5 py-0.5 text-emerald-300 ring-1 ring-emerald-800/60">
                  {drama.freeEpisodes} free
                </span>
              )}
              {inspected?.currentEpisodeNumber !== undefined && (
                <span className="rounded bg-indigo-950/80 px-1.5 py-0.5 font-medium text-indigo-300 ring-1 ring-indigo-700/60">
                  Current: Ep {inspected.currentEpisodeNumber}
                </span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/50 p-2.5 text-xs text-slate-400">
          {pageContext?.supported
            ? "Click Refresh to inspect the active FreeDrama page."
            : "Navigate to a FreeDrama.ai show or episode page, or paste a URL below."}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-2.5 flex gap-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            type="url"
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="https://freedrama.ai/en/show/..."
            className="w-full rounded-lg border border-slate-700 bg-slate-950 py-1.5 pl-8 pr-2 text-xs text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={inspecting || !manualUrl.trim()}
          className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Inspect
        </button>
      </form>
    </section>
  );
}
