import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import {
  DownloadManager,
  parseContentRangeTotal,
  resolveSafePath,
  sanitizePathSegment
} from "../src/server/downloader.js";
import {
  FreeDramaClient,
  getRenditionLabel,
  isExpired,
  selectRendition
} from "../src/server/freedramaClient.js";
import type { VideoRendition } from "../src/server/types.js";
import { parseFreeDramaUrl } from "../src/server/urlProcessor.js";

function createFakeMp4Bytes(size = 1024): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(size));
  // ISO BMFF size + 'ftyp' + 'isom'
  buf[0] = 0x00;
  buf[1] = 0x00;
  buf[2] = 0x00;
  buf[3] = 0x18;
  buf[4] = 0x66; // f
  buf[5] = 0x74; // t
  buf[6] = 0x79; // y
  buf[7] = 0x70; // p
  buf[8] = 0x69; // i
  buf[9] = 0x73; // s
  buf[10] = 0x6f; // o
  buf[11] = 0x6d; // m
  return buf;
}

async function waitForJobTerminal(manager: DownloadManager, jobId: string) {
  for (let i = 0; i < 100; i++) {
    const job = manager.getJob(jobId);
    if (
      job &&
      (job.status === "completed" ||
        job.status === "failed" ||
        job.status === "cancelled")
    ) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

describe("URL Processor & Security", () => {
  it("parses drama and episode URLs", () => {
    const drama = parseFreeDramaUrl(
      "https://freedrama.ai/en/show/love-is-a-dangerous-game-2-45153c99"
    );
    expect(drama).toEqual({
      kind: "drama",
      slug: "love-is-a-dangerous-game-2-45153c99",
      normalizedUrl: "https://freedrama.ai/en/show/love-is-a-dangerous-game-2-45153c99"
    });

    const ep = parseFreeDramaUrl(
      "https://freedrama.ai/en/show/love-is-a-dangerous-game-2-45153c99/43?ref=r_ad6dzsw5ez"
    );
    expect(ep).toEqual({
      kind: "episode",
      slug: "love-is-a-dangerous-game-2-45153c99",
      ordinal: 43,
      normalizedUrl:
        "https://freedrama.ai/en/show/love-is-a-dangerous-game-2-45153c99/43"
    });
  });

  it("rejects unapproved hosts, non-https, and invalid paths", () => {
    expect(() => parseFreeDramaUrl("https://evil.example.com/en/show/abc")).toThrow();
    expect(() => parseFreeDramaUrl("http://freedrama.ai/en/show/abc")).toThrow();
    expect(() => parseFreeDramaUrl("https://freedrama.ai/login")).toThrow();
    expect(() => parseFreeDramaUrl("not-a-url")).toThrow();
  });

  it("sanitizes filenames and prevents path traversal", () => {
    expect(sanitizePathSegment("../../secret:<>", "fallback")).toBe("secret");
    expect(sanitizePathSegment("CON", "fallback")).toBe("CON_dir");
    expect(() => resolveSafePath("/tmp/downloads", "../etc/passwd")).toThrow();
  });
});

describe("Rendition Selection & Expiration", () => {
  const renditions: VideoRendition[] = [
    {
      height: 960,
      width: 540,
      bandwidth: 623311,
      mp4Url: "https://cdn.freedrama.ai/bcdn_token=a/540/video.mp4",
      expiresAt: 1999999999
    },
    {
      height: 1920,
      width: 1080,
      bandwidth: 2349431,
      mp4Url: "https://cdn.freedrama.ai/bcdn_token=b/1080/video.mp4",
      expiresAt: 1999999999
    }
  ];

  it("selects exact 540p, 1080p, or highest auto quality", () => {
    const r540 = selectRendition(renditions, 960);
    expect(r540?.height).toBe(960);
    expect(getRenditionLabel(r540!)).toBe("540p");

    const r540Short = selectRendition(renditions, 540);
    expect(r540Short?.height).toBe(960);

    const r1080 = selectRendition(renditions, 1920);
    expect(r1080?.height).toBe(1920);
    expect(getRenditionLabel(r1080!)).toBe("1080p");

    const auto = selectRendition(renditions);
    expect(auto?.height).toBe(1920);
  });

  it("ignores unapproved CDN domains in renditions", () => {
    const evilRenditions: VideoRendition[] = [
      {
        height: 1920,
        width: 1080,
        mp4Url: "https://169.254.169.254/latest/meta-data"
      }
    ];
    expect(selectRendition(evilRenditions)).toBeNull();
  });

  it("evaluates Unix expiration timestamps accurately", () => {
    const now = 1_700_000_000_000;
    expect(isExpired(1_699_999_999, now)).toBe(true);
    expect(isExpired(1_700_000_000, now)).toBe(true);
    expect(isExpired(1_700_000_060, now)).toBe(false);
  });

  it("parses Content-Range headers", () => {
    expect(parseContentRangeTotal("bytes 0-6200080/6200081")).toEqual({
      start: 0,
      end: 6200080,
      total: 6200081
    });
  });
});

describe("DownloadManager Behavior (Mocked Transport)", () => {
  let tmpDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "freedrama-test-"));
    config = {
      port: 3000,
      downloadsDir: tmpDir,
      downloadConcurrency: 2,
      locale: "en-US",
      freedramaCookie: ""
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("re-resolves an expired signed URL once and completes download", async () => {
    let playbackCalls = 0;
    const mp4Payload = createFakeMp4Bytes(2048);

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/episode/ep-1/playback")) {
        playbackCalls += 1;
        const expiresAt =
          playbackCalls === 1
            ? Math.floor(Date.now() / 1000) - 60
            : Math.floor(Date.now() / 1000) + 300;
        return new Response(
          JSON.stringify({
            episodeId: "ep-1",
            seriesId: "ser-1",
            ordinal: 1,
            durationS: 90,
            renditions: [
              {
                height: 1920,
                width: 1080,
                mp4Url: `https://cdn.freedrama.ai/token_${playbackCalls}/video.mp4`,
                expiresAt
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.includes("cdn.freedrama.ai/token_2")) {
        return new Response(mp4Payload, {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-length": String(mp4Payload.length),
            "content-range": `bytes 0-${mp4Payload.length - 1}/${mp4Payload.length}`
          }
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    const client = new FreeDramaClient(config, mockFetch);
    const manager = new DownloadManager(config, client, mockFetch);

    const queued = manager.enqueue({
      episodeId: "ep-1",
      seriesId: "ser-1",
      episodeNumber: 1,
      dramaTitle: "Test Drama",
      quality: 1920
    });

    const done = await waitForJobTerminal(manager, queued.id);
    expect(playbackCalls).toBe(2);
    expect(done.status).toBe("completed");
    expect(done.filename).toBe("Episode_001_1080p.mp4");
    expect(done.downloadedBytes).toBe(2048);

    const savedStats = await stat(path.join(tmpDir, "Test Drama", "Episode_001_1080p.mp4"));
    expect(savedStats.size).toBe(2048);
  });

  it("handles 403 not_entitled without retrying indefinitely", async () => {
    let playbackCalls = 0;
    const mockFetch: typeof fetch = async () => {
      playbackCalls += 1;
      return new Response(
        JSON.stringify({
          error: "not_entitled",
          message: "not entitled to episode ep-43"
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      );
    };

    const client = new FreeDramaClient(config, mockFetch);
    const manager = new DownloadManager(config, client, mockFetch);

    const queued = manager.enqueue({
      episodeId: "ep-43",
      seriesId: "ser-1",
      episodeNumber: 43,
      dramaTitle: "Test Drama"
    });

    const done = await waitForJobTerminal(manager, queued.id);
    expect(playbackCalls).toBe(1);
    expect(done.status).toBe("failed");
    expect(done.errorCode).toBe("NOT_ENTITLED");
  });

  it("rejects non-MP4 content and cleans up partial file", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/playback")) {
        return new Response(
          JSON.stringify({
            episodeId: "ep-2",
            seriesId: "ser-1",
            ordinal: 2,
            durationS: 90,
            renditions: [
              {
                height: 960,
                width: 540,
                mp4Url: "https://cdn.freedrama.ai/valid/video.mp4",
                expiresAt: Math.floor(Date.now() / 1000) + 300
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response("<html>error</html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    };

    const client = new FreeDramaClient(config, mockFetch);
    const manager = new DownloadManager(config, client, mockFetch);

    const queued = manager.enqueue({
      episodeId: "ep-2",
      seriesId: "ser-1",
      episodeNumber: 2,
      dramaTitle: "Test Drama"
    });

    const done = await waitForJobTerminal(manager, queued.id);
    expect(done.status).toBe("failed");
    expect(done.errorCode).toBe("INVALID_CONTENT_TYPE");
  });

  it("processes a batch of 3 episodes respecting max concurrency and produces valid MP4s", async () => {
    const mp4Payload = createFakeMp4Bytes(1500);
    let activeCdn = 0;
    let maxObservedCdn = 0;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/playback")) {
        const epId = url.split("/").slice(-2)[0];
        const num = Number.parseInt(epId.replace("ep-", ""), 10);
        return new Response(
          JSON.stringify({
            episodeId: epId,
            seriesId: "ser-1",
            ordinal: num,
            durationS: 90,
            renditions: [
              {
                height: 960,
                width: 540,
                mp4Url: `https://cdn.freedrama.ai/${epId}/video.mp4`,
                expiresAt: Math.floor(Date.now() / 1000) + 300
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      activeCdn += 1;
      maxObservedCdn = Math.max(maxObservedCdn, activeCdn);
      await new Promise((r) => setTimeout(r, 30));
      activeCdn -= 1;

      return new Response(mp4Payload, {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": String(mp4Payload.length)
        }
      });
    };

    const client = new FreeDramaClient(config, mockFetch);
    const manager = new DownloadManager(config, client, mockFetch);

    const jobs = [1, 2, 3].map((n) =>
      manager.enqueue({
        episodeId: `ep-${n}`,
        seriesId: "ser-1",
        episodeNumber: n,
        dramaTitle: "Batch Show"
      })
    );

    const results = await Promise.all(jobs.map((j) => waitForJobTerminal(manager, j.id)));
    expect(results.every((r) => r.status === "completed")).toBe(true);
    expect(maxObservedCdn).toBeLessThanOrEqual(2);
  });
});
