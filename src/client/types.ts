export interface RenditionOption {
  height: number;
  width: number;
  label: string;
  bandwidth?: number;
  averageBandwidth?: number;
}

export interface EpisodeSummary {
  id: string;
  number: number;
  title: string;
  duration: number;
  lock: string;
  still?: string;
}

export interface DramaSummary {
  id: string;
  slug: string;
  title: string;
  synopsis?: string;
  thumbnail: string | null;
  episodeCount: number;
  freeEpisodes?: number;
  episodes: EpisodeSummary[];
}

export interface InspectedEpisode {
  id: string;
  seriesId: string;
  number: number;
  title: string;
  duration: number;
  lock: string;
  renditions: RenditionOption[];
}

export type DownloadStatus =
  | "queued"
  | "resolving"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadJob {
  id: string;
  episodeId: string;
  seriesId: string;
  episodeNumber?: number;
  dramaTitle?: string;
  requestedQuality?: number;
  qualityLabel: string | null;
  status: DownloadStatus;
  progress: number;
  downloadedBytes: number;
  totalBytes: number | null;
  filename: string | null;
  error: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface HealthInfo {
  ok: boolean;
  hasSessionCookie: boolean;
  downloadsDir: string;
  concurrency: number;
}
