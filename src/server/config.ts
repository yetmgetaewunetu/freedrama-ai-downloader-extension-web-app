import "dotenv/config";
import path from "node:path";
import {
  APPROVED_API_HOSTS,
  APPROVED_CDN_HOSTS,
  DEFAULT_LOCALE
} from "../../shared/src/constants.js";

export { APPROVED_API_HOSTS, APPROVED_CDN_HOSTS };

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface AppConfig {
  port: number;
  downloadsDir: string;
  downloadConcurrency: number;
  locale: string;
  freedramaCookie: string;
}

export function loadConfig(): AppConfig {
  const port = parsePositiveInt(process.env.PORT, 3000);
  const downloadsDir = path.resolve(
    process.cwd(),
    process.env.DOWNLOADS_DIR?.trim() || "./downloads"
  );
  const rawConcurrency = parsePositiveInt(process.env.DOWNLOAD_CONCURRENCY, 2);
  // Keep concurrency conservative (1-2) to respect platform rate limits.
  const downloadConcurrency = Math.min(Math.max(rawConcurrency, 1), 2);
  const locale = process.env.FREEDRAMA_LOCALE?.trim() || DEFAULT_LOCALE;
  const freedramaCookie = process.env.FREEDRAMA_COOKIE?.trim() || "";

  return {
    port,
    downloadsDir,
    downloadConcurrency,
    locale,
    freedramaCookie
  };
}
