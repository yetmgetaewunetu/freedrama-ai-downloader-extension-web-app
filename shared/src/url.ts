import { APPROVED_API_HOSTS } from "./constants.js";
import { AppError } from "./types.js";

export type ParsedFreeDramaUrl =
  | {
      kind: "drama";
      slug: string;
      normalizedUrl: string;
    }
  | {
      kind: "episode";
      slug: string;
      ordinal: number;
      normalizedUrl: string;
    };

/**
 * Validates that an outbound URL uses HTTPS and targets an approved host,
 * preventing SSRF and arbitrary redirect targets.
 */
export function assertApprovedUrl(rawUrl: string, allowedHosts: Set<string>): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError(400, "INVALID_URL", "Invalid URL format.");
  }

  if (parsed.protocol !== "https:") {
    throw new AppError(400, "INVALID_URL", "Only HTTPS URLs are permitted.");
  }

  if (parsed.username || parsed.password || parsed.port) {
    throw new AppError(
      400,
      "INVALID_URL",
      "URL must not include credentials or custom ports."
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    throw new AppError(
      400,
      "UNAPPROVED_DOMAIN",
      `Host "${host}" is not an approved FreeDrama domain.`
    );
  }

  return parsed;
}

const SHOW_PATH_REGEX =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?show\/([a-z0-9][a-z0-9-]{1,160})(?:\/(\d+))?\/?$/i;

/**
 * Parses and validates a FreeDrama.ai drama or episode URL.
 */
export function parseFreeDramaUrl(rawUrl: string): ParsedFreeDramaUrl {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new AppError(400, "INVALID_URL", "Please enter a FreeDrama.ai URL.");
  }

  const parsed = assertApprovedUrl(rawUrl.trim(), APPROVED_API_HOSTS);
  const match = SHOW_PATH_REGEX.exec(parsed.pathname);

  if (!match) {
    throw new AppError(
      400,
      "INVALID_URL",
      "URL must be a FreeDrama show or episode URL (e.g. https://freedrama.ai/en/show/<slug> or .../show/<slug>/<episodeNumber>)."
    );
  }

  const slug = match[1];
  const episodeSegment = match[2];

  if (episodeSegment !== undefined) {
    const ordinal = Number.parseInt(episodeSegment, 10);
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
      throw new AppError(
        400,
        "INVALID_URL",
        "Episode number in URL must be a positive integer."
      );
    }

    return {
      kind: "episode",
      slug,
      ordinal,
      normalizedUrl: `https://freedrama.ai${parsed.pathname}`
    };
  }

  return {
    kind: "drama",
    slug,
    normalizedUrl: `https://freedrama.ai${parsed.pathname}`
  };
}
