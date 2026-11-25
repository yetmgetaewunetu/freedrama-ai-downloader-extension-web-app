import type {
  DownloadStatus,
  PublicDramaSummary,
  PublicRendition
} from "../../../shared/src/types.js";

export interface PageContext {
  supported: boolean;
  kind: "drama" | "episode" | "other";
  url: string;
  slug?: string;
  episodeNumber?: number;
  title?: string;
  thumbnail?: string | null;
}

export interface ExtensionDownloadJob {
  id: string;
  episodeId: string;
  seriesId: string;
  episodeNumber: number;
  dramaTitle: string;
  requestedQuality?: number;
  qualityLabel: string | null;
  status: DownloadStatus;
  progress: number;
  downloadedBytes: number;
  totalBytes: number | null;
  filename: string | null;
  chromeDownloadId: number | null;
  refreshedOnce?: boolean;
  error: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface InspectedDramaState {
  url: string;
  drama: PublicDramaSummary;
  currentEpisodeNumber?: number;
  currentEpisodeId?: string;
  currentRenditions?: PublicRendition[];
  episodeNotice?: string | null;
  inspectedAt: number;
}

export type RuntimeRequest =
  | { type: "GET_PAGE_CONTEXT" }
  | { type: "INSPECT_URL"; url: string }
  | { type: "INSPECT_EPISODE_RENDITIONS"; episodeId: string }
  | {
      type: "ENQUEUE_DOWNLOADS";
      dramaTitle: string;
      seriesId: string;
      episodes: Array<{ episodeId: string; episodeNumber: number }>;
      quality?: number;
    }
  | { type: "GET_STATE" }
  | { type: "SYNC_PROGRESS" }
  | { type: "CANCEL_DOWNLOAD"; jobId: string }
  | { type: "CLEAR_FINISHED_DOWNLOADS" }
  | { type: "SHOW_DOWNLOAD_FILE"; chromeDownloadId: number };

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}
