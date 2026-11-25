import { AlertCircle, Film, Loader2 } from "lucide-react";
import { CurrentDramaSection } from "../components/CurrentDramaSection.js";
import { DownloadsSection } from "../components/DownloadsSection.js";
import { EpisodesSection } from "../components/EpisodesSection.js";
import { useExtensionState } from "../hooks/useExtensionState.js";

export default function App() {
  const {
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
  } = useExtensionState();

  return (
    <div className="min-h-[520px] w-[420px] bg-slate-950 p-3.5 text-slate-100">
      <header className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400 ring-1 ring-indigo-500/40">
            <Film className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold leading-tight text-white">
              FreeDrama Downloader
            </h1>
            <p className="text-[10px] text-slate-400">Uses your active Chrome session</p>
          </div>
        </div>

        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
            pageContext?.supported
              ? "border-emerald-700/60 bg-emerald-950/60 text-emerald-300"
              : "border-slate-700 bg-slate-900 text-slate-400"
          }`}
        >
          {pageContext?.supported ? "FreeDrama Tab" : "Standby"}
        </span>
      </header>

      {loading ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-xs text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
          <span>Detecting current page...</span>
        </div>
      ) : (
        <div className="space-y-3">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-800/60 bg-rose-950/40 px-2.5 py-2 text-xs text-rose-200">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {notice && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-800/60 bg-amber-950/40 px-2.5 py-2 text-xs text-amber-200">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span>{notice}</span>
            </div>
          )}

          <CurrentDramaSection
            pageContext={pageContext}
            inspected={inspected}
            inspecting={inspecting}
            onInspectUrl={inspectUrl}
            onRefresh={refreshActiveTab}
          />

          <EpisodesSection
            drama={inspected?.drama ?? null}
            currentEpisodeId={inspected?.currentEpisodeId}
            episodeRenditionsMap={episodeRenditionsMap}
            selectedIds={selectedIds}
            selectedQuality={selectedQuality}
            onQualityChange={setSelectedQuality}
            onToggleEpisode={toggleEpisode}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
            onInspectQualities={inspectEpisodeQualities}
            onDownloadEpisodes={enqueueEpisodes}
          />

          <DownloadsSection
            jobs={jobs}
            onCancel={cancelDownload}
            onClearFinished={clearFinishedDownloads}
            onShowInFolder={showDownloadInFolder}
          />
        </div>
      )}
    </div>
  );
}
