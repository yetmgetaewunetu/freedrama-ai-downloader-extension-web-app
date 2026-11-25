import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AppConfig } from "./config.js";
import { DownloadManager } from "./downloader.js";
import { FreeDramaClient } from "./freedramaClient.js";
import { createApiRouter } from "./routes.js";
import { AppError } from "./types.js";

export interface AppDependencies {
  config: AppConfig;
  client?: FreeDramaClient;
  downloadManager?: DownloadManager;
}

export function createApp({ config, client, downloadManager }: AppDependencies) {
  const app = express();
  const apiClient = client ?? new FreeDramaClient(config);
  const manager = downloadManager ?? new DownloadManager(config, apiClient);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use("/api", createApiRouter(config, apiClient, manager));

  const clientDistDir = path.resolve(process.cwd(), "dist/client");
  if (existsSync(clientDistDir)) {
    app.use(express.static(clientDistDir));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) {
        next();
        return;
      }
      res.sendFile(path.join(clientDistDir, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      if (err.retryAfterSeconds !== undefined) {
        res.setHeader("Retry-After", String(err.retryAfterSeconds));
      }
      res.status(err.statusCode).json({
        success: false,
        error: err.code,
        message: err.message
      });
      return;
    }

    const message =
      err instanceof Error ? err.message : "An unexpected server error occurred.";
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message
    });
  });

  return { app, apiClient, manager };
}
