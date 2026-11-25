export interface Subtitle {
  code?: string;
  language?: string;
  url?: string;
}

export interface Language {
  code: string;
  kind?: string;
}

export interface AudioTrack {
  code: string;
  kind?: string;
  sound?: string;
  burnedText?: string;
}

export interface VideoRendition {
  height: number;
  width: number;
  bandwidth?: number;
  averageBandwidth?: number;
  codecs?: string | null;
  url?: string;
  mp4Url?: string;
  expiresAt?: number;
}

export interface EpisodePlaybackResponse {
  episodeId: string;
  seriesId: string;
  ordinal: number;
  durationS: number;
  source?: string;
  renditions: VideoRendition[];
  subtitleMode?: string;
  subtitles?: Subtitle[];
  languages?: Language[];
  audio?: AudioTrack[];
  pickedAudio?: string;
  pickedLanguage?: string;
  originalLanguage?: string;
  burnedIn?: boolean;
  cleanCutAvailable?: boolean;
  resumeAt?: number;
  shareUrl?: string;
  openUrl?: string;
}

export interface FreeDramaSeriesPoster {
  vertical?: string;
  horizontal?: string;
}

export interface FreeDramaSeriesInfo {
  id: string;
  slug: string;
  title: string;
  synopsis?: string;
  episodeCount: number;
  freeEpisodes?: number;
  isFree?: boolean;
  orientation?: string;
  posters?: FreeDramaSeriesPoster;
}

export interface FreeDramaEpisodeItem {
  id: string;
  code?: string;
  ordinal: number;
  title: string;
  durationS: number;
  lock: "free" | "vip" | "none" | string;
  still?: string;
  publishedAt?: string;
}

export interface FreeDramaSeriesDetailResponse {
  series: FreeDramaSeriesInfo;
  episodes: FreeDramaEpisodeItem[];
}

export interface PublicRendition {
  height: number;
  width: number;
  label: string;
  bandwidth?: number;
  averageBandwidth?: number;
}

export interface PublicEpisodeSummary {
  id: string;
  number: number;
  title: string;
  duration: number;
  lock: string;
  still?: string;
}

export interface PublicDramaSummary {
  id: string;
  slug: string;
  title: string;
  synopsis?: string;
  thumbnail: string | null;
  episodeCount: number;
  freeEpisodes?: number;
  episodes: PublicEpisodeSummary[];
}

export type DownloadStatus =
  | "queued"
  | "resolving"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
