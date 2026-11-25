import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router, type NextFunction, type Request, type Response } from "express";
import { sanitizePathSegment } from "../../shared/src/filename.js";
import type { AppConfig } from "./config.js";
import { DownloadManager, resolveSafePath } from "./downloader.js";
import {
  FreeDramaClient,
  getRenditionLabel,
  isExpired,
  selectRendition,
  toDramaSummary,
  toPublicRenditions
} from "./freedramaClient.js";
import { AppError } from "./types.js";
import { parseFreeDramaUrl } from "./urlProcessor.js";

export function createApiRouter(
  config: AppConfig,
  client: FreeDramaClient,
  downloadManager: DownloadManager
): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      hasSessionCookie: Boolean(config.freedramaCookie),
      downloadsDir: config.downloadsDir,
      concurrency: config.downloadConcurrency
    });
  });

  router.post("/drama/inspect", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const url = req.body?.url;
      const parsed = parseFreeDramaUrl(url);
      const detail = await client.getSeriesDetail(parsed.slug);

      let matchedEpisodeNumber: number | undefined;
      if (parsed.kind === "episode") {
        matchedEpisodeNumber = parsed.ordinal;
      }

      res.json({
        success: true,
        inspectedKind: parsed.kind,
        matchedEpisodeNumber,
        drama: toDramaSummary(detail)
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/episode/inspect", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const url = req.body?.url;
      const parsed = parseFreeDramaUrl(url);
      if (parsed.kind !== "episode") {
        throw new AppError(
          400,
          "INVALID_URL",
          "Please provide a FreeDrama episode URL (ending with /<episodeNumber>)."
        );
      }

      const detail = await client.getSeriesDetail(parsed.slug);
      const episodeMeta = detail.episodes.find((ep) => ep.ordinal === parsed.ordinal);
      if (!episodeMeta) {
        throw new AppError(
          404,
          "EPISODE_NOT_FOUND",
          `Episode ${parsed.ordinal} was not found in "${detail.series.title}".`
        );
      }

      const playback = await client.getEpisodePlayback(episodeMeta.id);

      // Deliberately omit signed mp4Url/url/expiresAt from browser responses.
      const renditions = toPublicRenditions(playback.renditions);

      res.json({
        success: true,
        dramaTitle: detail.series.title,
        episode: {
          id: playback.episodeId,
          seriesId: playback.seriesId,
          number: playback.ordinal,
          title: episodeMeta.title?.trim() || `Episode ${playback.ordinal}`,
          duration: playback.durationS,
          lock: episodeMeta.lock,
          renditions
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/downloads", (req: Request, res: Response, next: NextFunction) => {
    try {
      const { episodeId, seriesId, quality, episodeNumber, dramaTitle } = req.body ?? {};
      if (typeof episodeId !== "string" || !episodeId.trim()) {
        throw new AppError(400, "INVALID_REQUEST", "episodeId is required.");
      }
      if (typeof seriesId !== "string" || !seriesId.trim()) {
        throw new AppError(400, "INVALID_REQUEST", "seriesId is required.");
      }

      let parsedQuality: number | undefined;
      if (quality !== undefined && quality !== null && quality !== "auto") {
        const num = Number(quality);
        if (!Number.isFinite(num) || num <= 0) {
          throw new AppError(400, "INVALID_QUALITY", "quality must be a positive number or 'auto'.");
        }
        parsedQuality = num;
      }

      const job = downloadManager.enqueue({
        episodeId,
        seriesId,
        quality: parsedQuality,
        episodeNumber:
          typeof episodeNumber === "number" && Number.isFinite(episodeNumber)
            ? episodeNumber
            : undefined,
        dramaTitle: typeof dramaTitle === "string" ? dramaTitle : undefined
      });

      res.status(202).json({
        success: true,
        job
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/downloads", (_req: Request, res: Response) => {
    res.json({
      success: true,
      jobs: downloadManager.listJobs()
    });
  });

  router.get("/downloads/:id", (req: Request, res: Response, next: NextFunction) => {
    try {
      const jobId = String(req.params.id);
      const job = downloadManager.getJob(jobId);
      if (!job) {
        throw new AppError(404, "JOB_NOT_FOUND", "Download job not found.");
      }
      res.json(job);
    } catch (err) {
      next(err);
    }
  });

  router.post("/downloads/:id/cancel", (req: Request, res: Response, next: NextFunction) => {
    try {
      const jobId = String(req.params.id);
      const job = downloadManager.cancelJob(jobId);
      if (!job) {
        throw new AppError(404, "JOB_NOT_FOUND", "Download job not found.");
      }
      res.json({
        success: true,
        job
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/downloads/:id/file", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const jobId = String(req.params.id);
      const job = downloadManager.getInternalJob(jobId);
      if (!job) {
        throw new AppError(404, "JOB_NOT_FOUND", "Download job not found.");
      }

      if (job.status !== "completed" || !job.relativePath || !job.filename) {
        throw new AppError(409, "FILE_NOT_READY", "Downloaded file is not completed yet.");
      }

      const safeFilePath = resolveSafePath(config.downloadsDir, job.relativePath);
      const fileStats = await stat(safeFilePath);
      if (!fileStats.isFile()) {
        throw new AppError(404, "FILE_NOT_FOUND", "Downloaded file could not be located.");
      }

      res.download(safeFilePath, job.filename);
    } catch (err) {
      next(err);
    }
  });

  // Streams the authorized MP4 directly to the user's browser without writing to server disk.
  router.get(
    "/episodes/:episodeId/stream",
    async (req: Request, res: Response, next: NextFunction) => {
      const abortController = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      });

      try {
        const episodeId = String(req.params.episodeId || "").trim();
        const rawQuality = req.query.quality;
        const dramaTitleParam =
          typeof req.query.dramaTitle === "string" ? req.query.dramaTitle : "";
        const seriesIdParam =
          typeof req.query.seriesId === "string" ? req.query.seriesId.trim() : "";

        let requestedQuality: number | undefined;
        if (
          typeof rawQuality === "string" &&
          rawQuality.trim() !== "" &&
          rawQuality !== "auto"
        ) {
          const parsed = Number.parseInt(rawQuality, 10);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new AppError(
              400,
              "INVALID_QUALITY",
              "quality must be a positive number or 'auto'."
            );
          }
          requestedQuality = parsed;
        }

        let resolvedPlayback = await client.getEpisodePlayback(
          episodeId,
          abortController.signal
        );
        let rendition = selectRendition(resolvedPlayback.renditions, requestedQuality);

        if (!rendition || !rendition.mp4Url) {
          throw new AppError(
            422,
            "NO_MP4_RENDITION",
            "No authorized MP4 rendition is available for this episode."
          );
        }

        if (isExpired(rendition.expiresAt)) {
          resolvedPlayback = await client.getEpisodePlayback(
            episodeId,
            abortController.signal
          );
          rendition = selectRendition(resolvedPlayback.renditions, requestedQuality);
          if (!rendition?.mp4Url || isExpired(rendition.expiresAt)) {
            throw new AppError(
              502,
              "SIGNED_URL_EXPIRED",
              "Retrieved playback URL is expired."
            );
          }
        }

        let upstream = await client.fetchApprovedMedia(
          rendition.mp4Url,
          abortController.signal
        );

        if (upstream.status === 401 || upstream.status === 403) {
          resolvedPlayback = await client.getEpisodePlayback(
            episodeId,
            abortController.signal
          );
          rendition = selectRendition(resolvedPlayback.renditions, requestedQuality);
          if (!rendition?.mp4Url) {
            throw new AppError(403, "CDN_ACCESS_DENIED", "CDN rejected video download.");
          }
          upstream = await client.fetchApprovedMedia(
            rendition.mp4Url,
            abortController.signal
          );
        }

        if (upstream.status !== 200 && upstream.status !== 206) {
          throw new AppError(
            502,
            "CDN_HTTP_ERROR",
            `Video stream failed with HTTP ${upstream.status}.`
          );
        }

        const contentType = upstream.headers.get("content-type") || "video/mp4";
        if (
          !contentType.toLowerCase().includes("video/") &&
          !contentType.toLowerCase().includes("application/octet-stream")
        ) {
          throw new AppError(
            502,
            "INVALID_CONTENT_TYPE",
            `Unexpected video content type: ${contentType}`
          );
        }

        if (!upstream.body) {
          throw new AppError(502, "EMPTY_RESPONSE", "Empty video response body.");
        }

        let dramaTitle = dramaTitleParam.trim();
        if (!dramaTitle && seriesIdParam) {
          try {
            const detail = await client.getSeriesDetail(
              seriesIdParam,
              abortController.signal
            );
            dramaTitle = detail.series.title;
          } catch {
            // Fallback to episode-only filename if title lookup fails.
          }
        }

        const ordinal = resolvedPlayback.ordinal || 1;
        const qualityLabel = getRenditionLabel(rendition);
        const safePrefix = dramaTitle
          ? `${sanitizePathSegment(dramaTitle, "FreeDrama")} - `
          : "";
        const filename = sanitizePathSegment(
          `${safePrefix}Episode_${String(ordinal).padStart(3, "0")}_${qualityLabel}.mp4`,
          `Episode_${String(ordinal).padStart(3, "0")}_${qualityLabel}.mp4`
        );

        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Rendition-Quality", qualityLabel);
        const contentLength = upstream.headers.get("content-length");
        if (contentLength) {
          res.setHeader("Content-Length", contentLength);
        }

        await pipeline(Readable.fromWeb(upstream.body as any), res, {
          signal: abortController.signal
        });
      } catch (err) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        next(err);
      }
    }
  );

  return router;
}
