export * from "../../shared/src/types.js";
import type { DownloadStatus } from "../../shared/src/types.js";

export interface DownloadJob {
  id: string;
  episodeId: string;
  seriesId: string;
  episodeNumber?: number;
  dramaTitle?: string;
  requestedQuality?: number;
  selectedQualityLabel?: string;
  selectedHeight?: number;
  selectedWidth?: number;
  status: DownloadStatus;
  progress: number;
  downloadedBytes: number;
  totalBytes: number | null;
  filename: string | null;
  relativePath: string | null;
  absolutePath: string | null;
  error: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface PublicDownloadJob {
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
