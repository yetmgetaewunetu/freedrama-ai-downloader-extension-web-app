import { APPROVED_API_HOSTS, APPROVED_CDN_HOSTS, DEFAULT_LOCALE } from "./constants.js";
import { parseRetryAfterSeconds } from "./playback.js";
import {
  AppError,
  type EpisodePlaybackResponse,
  type FreeDramaSeriesDetailResponse
} from "./types.js";
import { assertApprovedUrl } from "./url.js";

const IDENTIFIER_REGEX = /^[a-zA-Z0-9_-]{1,180}$/;
const API_BASE = "https://freedrama.ai";
const API_TIMEOUT_MS = 20_000;
const MAX_TRANSIENT_RETRIES = 2;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type FetchCredentials = "omit" | "same-origin" | "include";

export interface FreeDramaApiClientOptions {
  locale?: string;
  cookie?: string;
  credentials?: FetchCredentials;
  fetchImpl?: typeof fetch;
}

/**
 * Platform-agnostic FreeDrama.ai API client shared between the Node.js web backend
 * and the Chrome extension background service worker.
 */
export class FreeDramaApiClient {
  private readonly locale: string;
  private readonly cookie: string;
  private readonly credentials?: FetchCredentials;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FreeDramaApiClientOptions = {}) {
    this.locale = options.locale?.trim() || DEFAULT_LOCALE;
    this.cookie = options.cookie?.trim() || "";
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-app-locale": this.locale,
      "x-app-link-locale": this.locale
    };

    if (this.cookie) {
      headers.Cookie = this.cookie;
    }

    return headers;
  }

  private async requestJson<T>(
    path: string,
    notFoundCode: string,
    notFoundMessage: string,
    signal?: AbortSignal
  ): Promise<T> {
    const targetUrl = assertApprovedUrl(`${API_BASE}${path}`, APPROVED_API_HOSTS);

    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      let response: Response;
      try {
        const init: RequestInit = {
          method: "GET",
          headers: this.buildHeaders(),
          redirect: "manual",
          signal: combinedSignal
        };
        if (this.credentials) {
          init.credentials = this.credentials;
        }
        response = await this.fetchImpl(targetUrl.toString(), init);
      } catch (err) {
        if (signal?.aborted) {
          throw new AppError(499, "CANCELLED", "Request cancelled.");
        }
        if (attempt < MAX_TRANSIENT_RETRIES) {
          await sleep(500 * (attempt + 1), signal);
          continue;
        }
        throw new AppError(
          502,
          "NETWORK_ERROR",
          `Unable to reach FreeDrama API: ${err instanceof Error ? err.message : "Network error"}`
        );
      }

      if (response.status >= 300 && response.status < 400) {
        throw new AppError(
          502,
          "UNEXPECTED_REDIRECT",
          "Unexpected redirect from FreeDrama API."
        );
      }

      if (response.status === 401 || response.status === 403) {
        let errorCode = "NOT_ENTITLED";
        let message =
          "Authorization required or episode is VIP-locked. Sign in to an entitled FreeDrama account.";
        try {
          const body = (await response.json()) as { error?: string; message?: string };
          if (body?.error === "not_entitled") {
            message =
              "This episode requires an authorized FreeDrama VIP/account session (not_entitled).";
          } else if (body?.message) {
            message = body.message;
          }
          if (response.status === 401) {
            errorCode = "UNAUTHORIZED";
          }
        } catch {
          // Use default authorization message.
        }
        throw new AppError(response.status, errorCode, message);
      }

      if (response.status === 404) {
        throw new AppError(404, notFoundCode, notFoundMessage);
      }

      if (response.status === 429) {
        const retryAfter = parseRetryAfterSeconds(response.headers.get("retry-after"));
        if (attempt < MAX_TRANSIENT_RETRIES && retryAfter !== undefined && retryAfter <= 5) {
          await sleep(Math.max(retryAfter, 1) * 1000, signal);
          continue;
        }
        throw new AppError(
          429,
          "RATE_LIMITED",
          retryAfter
            ? `FreeDrama API rate limit reached. Retry after ${retryAfter}s.`
            : "FreeDrama API rate limit reached. Please slow down and try again.",
          retryAfter
        );
      }

      if (response.status >= 500) {
        if (attempt < MAX_TRANSIENT_RETRIES) {
          await sleep(700 * (attempt + 1), signal);
          continue;
        }
        throw new AppError(
          502,
          "UPSTREAM_SERVER_ERROR",
          `FreeDrama API returned HTTP ${response.status}.`
        );
      }

      if (!response.ok) {
        throw new AppError(
          502,
          "UPSTREAM_ERROR",
          `FreeDrama API returned unexpected HTTP ${response.status}.`
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        throw new AppError(
          502,
          "INVALID_RESPONSE",
          `Expected JSON from FreeDrama API, received "${contentType || "unknown"}".`
        );
      }

      return (await response.json()) as T;
    }

    throw new AppError(502, "UPSTREAM_ERROR", "FreeDrama API request failed.");
  }

  async getSeriesDetail(
    slugOrId: string,
    signal?: AbortSignal
  ): Promise<FreeDramaSeriesDetailResponse> {
    if (!IDENTIFIER_REGEX.test(slugOrId)) {
      throw new AppError(400, "INVALID_IDENTIFIER", "Invalid series identifier.");
    }

    const data = await this.requestJson<FreeDramaSeriesDetailResponse>(
      `/api/series/${encodeURIComponent(slugOrId)}`,
      "DRAMA_NOT_FOUND",
      "Drama not found on FreeDrama.",
      signal
    );

    if (!data?.series?.id || !Array.isArray(data?.episodes)) {
      throw new AppError(
        502,
        "INVALID_RESPONSE",
        "FreeDrama series response was missing expected series or episodes fields."
      );
    }

    return data;
  }

  async getEpisodePlayback(
    episodeId: string,
    signal?: AbortSignal
  ): Promise<EpisodePlaybackResponse> {
    if (!IDENTIFIER_REGEX.test(episodeId)) {
      throw new AppError(400, "INVALID_IDENTIFIER", "Invalid episode identifier.");
    }

    const data = await this.requestJson<EpisodePlaybackResponse>(
      `/api/episode/${encodeURIComponent(episodeId)}/playback`,
      "EPISODE_NOT_FOUND",
      "Episode not found or unavailable.",
      signal
    );

    if (!data?.episodeId || !Array.isArray(data?.renditions)) {
      throw new AppError(
        502,
        "NO_PLAYBACK_DATA",
        "Playback response did not contain valid rendition data."
      );
    }

    return data;
  }

  async fetchApprovedMedia(
    mediaUrl: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const validated = assertApprovedUrl(mediaUrl, APPROVED_CDN_HOSTS);
    return this.fetchImpl(validated.toString(), {
      method: "GET",
      redirect: "follow",
      signal
    });
  }
}
