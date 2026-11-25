import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { DownloadManager } from "../src/server/downloader.js";
import { FreeDramaClient } from "../src/server/freedramaClient.js";

describe("Express API Endpoints", () => {
  let tmpDir: string;
  let baseUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "freedrama-api-test-"));
    const config: AppConfig = {
      port: 0,
      downloadsDir: tmpDir,
      downloadConcurrency: 2,
      locale: "en-US",
      freedramaCookie: ""
    };

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/series/")) {
        return new Response(
          JSON.stringify({
            series: {
              id: "45153c99-4457-4133-8305-29235cfa649d",
              slug: "love-is-a-dangerous-game-2-45153c99",
              title: "Love Is A Dangerous Game 2",
              episodeCount: 2,
              freeEpisodes: 1,
              posters: { vertical: "https://cdn.freedrama.ai/poster.jpg" }
            },
            episodes: [
              {
                id: "ep-1-uuid",
                ordinal: 1,
                title: "",
                durationS: 102,
                lock: "free"
              },
              {
                id: "ep-2-uuid",
                ordinal: 2,
                title: "Finale",
                durationS: 96,
                lock: "vip"
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.includes("/api/episode/ep-1-uuid/playback")) {
        return new Response(
          JSON.stringify({
            episodeId: "ep-1-uuid",
            seriesId: "45153c99-4457-4133-8305-29235cfa649d",
            ordinal: 1,
            durationS: 102,
            renditions: [
              {
                height: 960,
                width: 540,
                mp4Url: "https://cdn.freedrama.ai/bcdn_token=SECRET/540/video.mp4",
                expiresAt: 1999999999
              },
              {
                height: 1920,
                width: 1080,
                mp4Url: "https://cdn.freedrama.ai/bcdn_token=SECRET/1080/video.mp4",
                expiresAt: 1999999999
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.includes("cdn.freedrama.ai/")) {
        const fakeMp4 = new Uint8Array(new ArrayBuffer(64));
        fakeMp4[4] = 0x66;
        fakeMp4[5] = 0x74;
        fakeMp4[6] = 0x79;
        fakeMp4[7] = 0x70;
        return new Response(fakeMp4, {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "content-length": String(fakeMp4.length)
          }
        });
      }

      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    };

    const client = new FreeDramaClient(config, mockFetch);
    const manager = new DownloadManager(config, client, mockFetch);
    const { app } = createApp({ config, client, downloadManager: manager });

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    closeServer = () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
  });

  afterEach(async () => {
    await closeServer();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("inspects drama and episode without leaking signed URLs", async () => {
    const dramaRes = await fetch(`${baseUrl}/api/drama/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://freedrama.ai/en/show/love-is-a-dangerous-game-2-45153c99"
      })
    });
    expect(dramaRes.status).toBe(200);
    const dramaBody = await dramaRes.json();
    expect(dramaBody.success).toBe(true);
    expect(dramaBody.drama.episodes).toHaveLength(2);
    expect(dramaBody.drama.episodes[0].title).toBe("Episode 1");

    const epRes = await fetch(`${baseUrl}/api/episode/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://freedrama.ai/en/show/love-is-a-dangerous-game-2-45153c99/1"
      })
    });
    expect(epRes.status).toBe(200);
    const epBody = await epRes.json();
    expect(epBody.success).toBe(true);
    expect(epBody.episode.renditions).toHaveLength(2);
    expect(JSON.stringify(epBody)).not.toContain("bcdn_token");
    expect(JSON.stringify(epBody)).not.toContain("mp4Url");
  });

  it("validates invalid URLs cleanly", async () => {
    const res = await fetch(`${baseUrl}/api/drama/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/bad" })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("UNAPPROVED_DOMAIN");
  });

  it("streams MP4 directly to the browser without writing to server disk", async () => {
    const res = await fetch(
      `${baseUrl}/api/episodes/ep-1-uuid/stream?seriesId=45153c99-4457-4133-8305-29235cfa649d&dramaTitle=Test+Show&quality=960`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Test Show - Episode_001_540p.mp4"'
    );
    expect(res.headers.get("x-rendition-quality")).toBe("540p");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(64);

    // Ensure zero files were written to the server downloads directory.
    const serverFiles = await readdir(tmpDir);
    expect(serverFiles).toHaveLength(0);
  });
});
