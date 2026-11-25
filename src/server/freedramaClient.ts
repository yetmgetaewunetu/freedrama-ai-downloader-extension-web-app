import { FreeDramaApiClient } from "../../shared/src/apiClient.js";
import {
  getRenditionLabel,
  isExpired,
  parseRetryAfterSeconds,
  selectRendition,
  toDramaSummary,
  toPublicRenditions
} from "../../shared/src/playback.js";
import type { AppConfig } from "./config.js";

export {
  getRenditionLabel,
  isExpired,
  parseRetryAfterSeconds,
  selectRendition,
  toDramaSummary,
  toPublicRenditions
};

export class FreeDramaClient extends FreeDramaApiClient {
  constructor(config: AppConfig, fetchImpl: typeof fetch = fetch) {
    super({
      locale: config.locale,
      cookie: config.freedramaCookie,
      fetchImpl
    });
  }
}
