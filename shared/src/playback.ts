import { APPROVED_CDN_HOSTS } from "./constants.js";
import type {
  FreeDramaSeriesDetailResponse,
  PublicDramaSummary,
  PublicRendition,
  VideoRendition
} from "./types.js";
import { assertApprovedUrl } from "./url.js";

export function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const numeric = Number.parseInt(headerValue, 10);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric;
  }
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return undefined;
}

export function isExpired(expiresAt?: number, nowMs: number = Date.now()): boolean {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return false;
  }
  return nowMs >= expiresAt * 1000;
}

export function getRenditionLabel(rendition: VideoRendition): string {
  const shortEdge = Math.min(rendition.width, rendition.height);
  return `${shortEdge}p`;
}

/**
 * Selects an authorized MP4 rendition matching the requested height (e.g. 1920/960)
 * or short-edge quality (e.g. 1080/540), falling back to highest available resolution.
 */
export function selectRendition(
  renditions: VideoRendition[],
  preferredQuality?: number
): VideoRendition | null {
  const available = renditions.filter((item) => {
    if (!item.mp4Url || item.height <= 0 || item.width <= 0) {
      return false;
    }
    try {
      assertApprovedUrl(item.mp4Url, APPROVED_CDN_HOSTS);
      return true;
    } catch {
      return false;
    }
  });

  if (available.length === 0) {
    return null;
  }

  if (preferredQuality !== undefined && preferredQuality > 0) {
    const exactHeight = available.find((item) => item.height === preferredQuality);
    if (exactHeight) return exactHeight;

    const exactShortEdge = available.find(
      (item) => Math.min(item.width, item.height) === preferredQuality
    );
    if (exactShortEdge) return exactShortEdge;
  }

  return [...available].sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  })[0];
}

export function toPublicRenditions(renditions: VideoRendition[]): PublicRendition[] {
  return renditions
    .filter((item) => {
      if (!item.mp4Url || item.height <= 0 || item.width <= 0) return false;
      try {
        assertApprovedUrl(item.mp4Url, APPROVED_CDN_HOSTS);
        return true;
      } catch {
        return false;
      }
    })
    .map((item) => ({
      height: item.height,
      width: item.width,
      label: getRenditionLabel(item),
      bandwidth: item.bandwidth,
      averageBandwidth: item.averageBandwidth
    }))
    .sort((a, b) => b.height - a.height);
}

export function toDramaSummary(detail: FreeDramaSeriesDetailResponse): PublicDramaSummary {
  const { series, episodes } = detail;
  return {
    id: series.id,
    slug: series.slug,
    title: series.title,
    synopsis: series.synopsis,
    thumbnail: series.posters?.vertical ?? series.posters?.horizontal ?? null,
    episodeCount: series.episodeCount ?? episodes.length,
    freeEpisodes: series.freeEpisodes,
    episodes: episodes.map((ep) => ({
      id: ep.id,
      number: ep.ordinal,
      title: ep.title?.trim() || `Episode ${ep.ordinal}`,
      duration: ep.durationS,
      lock: ep.lock,
      still: ep.still
    }))
  };
}
