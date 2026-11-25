import { useMemo } from "react";
import { Download, Eye } from "lucide-react";
import type {
  PublicDramaSummary,
  PublicEpisodeSummary,
  PublicRendition
} from "../../../shared/src/types.js";
import { formatDuration } from "../utils/format.js";

interface EpisodesSectionProps {
  drama: PublicDramaSummary | null;
  currentEpisodeId?: string;
  episodeRenditionsMap: Record<string, PublicRendition[]>;
  selectedIds: Set<string>;
  selectedQuality: string;
  onQualityChange: (value: string) => void;
  onToggleEpisode: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onInspectQualities: (episodeId: string) => Promise<void>;
  onDownloadEpisodes: (episodes: PublicEpisodeSummary[]) => Promise<void>;
}

const DEFAULT_QUALITY_OPTIONS: PublicRendition[] = [
  { height: 1920, width: 1080, label: "1080p" },
  { height: 960, width: 540, label: "540p" }
];

export function EpisodesSection({
  drama,
  currentEpisodeId,
  episodeRenditionsMap,
  selectedIds,
  selectedQuality,
  onQualityChange,
  onToggleEpisode,
  onSelectAll,
  onDeselectAll,
  onInspectQualities,
  onDownloadEpisodes
}: EpisodesSectionProps) {
  const qualityOptions = useMemo(() => {
    const currentRenditions = currentEpisodeId
      ? episodeRenditionsMap[currentEpisodeId]
      : undefined;
    if (currentRenditions && currentRenditions.length > 0) {
      return currentRenditions;
    }
    const firstInspected = Object.values(episodeRenditionsMap).find((r) => r.length > 0);
    return firstInspected ?? DEFAULT_QUALITY_OPTIONS;
  }, [currentEpisodeId, episodeRenditionsMap]);

  if (!drama) {
    return null;
  }

  const selectedEpisodes = drama.episodes.filter((ep) => selectedIds.has(ep.id));

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Episodes ({drama.episodes.length})
        </h2>

        <select
          aria-label="Select video quality"
          value={selectedQuality}
          onChange={(e) => onQualityChange(e.target.value)}
          className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-100 focus:border-indigo-500 focus:outline-none"
        >
          <option value="auto">Auto (Highest)</option>
          {qualityOptions.map((q) => (
            <option key={q.height} value={String(q.height)}>
              {q.label} ({q.width}x{q.height})
            </option>
          ))}
        </select>
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onSelectAll}
            className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={onDeselectAll}
            className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200"
          >
            Deselect all
          </button>
        </div>

        <button
          type="button"
          disabled={selectedEpisodes.length === 0}
          onClick={() => void onDownloadEpisodes(selectedEpisodes)}
          className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download className="h-3 w-3" />
          Download selected ({selectedEpisodes.length})
        </button>
      </div>

      <div className="max-h-52 space-y-1 overflow-y-auto pr-1">
        {drama.episodes.map((ep) => {
          const checked = selectedIds.has(ep.id);
          const renditions = episodeRenditionsMap[ep.id];
          const isCurrent = ep.id === currentEpisodeId;

          return (
            <div
              key={ep.id}
              className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition ${
                isCurrent
                  ? "border-indigo-700/70 bg-indigo-950/30"
                  : checked
                    ? "border-slate-700 bg-slate-800/60"
                    : "border-slate-800/80 bg-slate-950/50 hover:bg-slate-900"
              }`}
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleEpisode(ep.id)}
                  className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 text-indigo-500"
                />
                <span className="font-mono text-[11px] text-slate-400">
                  #{String(ep.number).padStart(3, "0")}
                </span>
                <span className="truncate font-medium text-slate-100">{ep.title}</span>
              </label>

              <div className="flex shrink-0 items-center gap-1.5">
                <span className="font-mono text-[10px] text-slate-500">
                  {formatDuration(ep.duration)}
                </span>

                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    ep.lock === "free"
                      ? "bg-emerald-950/70 text-emerald-300"
                      : "bg-amber-950/70 text-amber-300"
                  }`}
                >
                  {ep.lock === "free" ? "Free" : "VIP"}
                </span>

                {renditions && renditions.length > 0 ? (
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300">
                    {renditions.map((r) => r.label).join("/")}
                  </span>
                ) : (
                  <button
                    type="button"
                    title="Inspect available resolutions"
                    onClick={() => void onInspectQualities(ep.id)}
                    className="rounded border border-slate-700 bg-slate-900 p-1 text-slate-400 hover:text-slate-200"
                  >
                    <Eye className="h-3 w-3" />
                  </button>
                )}

                <button
                  type="button"
                  title={`Download Episode ${ep.number}`}
                  onClick={() => void onDownloadEpisodes([ep])}
                  className="rounded bg-slate-800 p-1 text-indigo-300 hover:bg-indigo-600 hover:text-white"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
