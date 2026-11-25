import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEpisodeRelativePath } from "../shared/src/filename.js";

type ListenerFn = (...args: any[]) => any;

function setupChromeMock(fetchImpl: typeof fetch) {
  const storageData: Record<string, any> = {};
  const onMessageListeners: ListenerFn[] = [];
  const onChangedListeners: ListenerFn[] = [];
  const onStartupListeners: ListenerFn[] = [];
  let nextDownloadId = 100;
  const downloadItems = new Map<number, any>();

  (globalThis as any).fetch = fetchImpl;
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
        set: vi.fn(async (obj: Record<string, any>) => {
          Object.assign(storageData, obj);
        })
      }
    },
    downloads: {
      download: vi.fn(async (opts: { url: string; filename: string }) => {
        const id = nextDownloadId++;
        downloadItems.set(id, {
          id,
          url: opts.url,
          filename: opts.filename,
          state: "in_progress",
          bytesReceived: 0,
          totalBytes: 1000
        });
        return id;
      }),
      search: vi.fn(async ({ id }: { id: number }) => {
        const item = downloadItems.get(id);
        return item ? [item] : [];
      }),
      cancel: vi.fn(async (id: number) => {
        const item = downloadItems.get(id);
        if (item) {
          item.state = "interrupted";
          item.error = "USER_CANCELED";
        }
      }),
      show: vi.fn(),
      onChanged: {
        addListener: (fn: ListenerFn) => onChangedListeners.push(fn)
      }
    },
    runtime: {
      onMessage: {
        addListener: (fn: ListenerFn) => onMessageListeners.push(fn)
      },
      onStartup: {
        addListener: (fn: ListenerFn) => onStartupListeners.push(fn)
      },
      onInstalled: {
        addListener: vi.fn()
      }
    }
  };

  async function sendMessage(msg: any): Promise<any> {
    return new Promise((resolve) => {
      onMessageListeners[0](msg, {}, resolve);
    });
  }

  return {
    storageData,
    downloadItems,
    onChangedListeners,
    onStartupListeners,
    sendMessage
  };
}

describe("Chrome Extension Shared Filenames & Service Worker", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("builds consistent sanitized relative paths for Chrome Downloads", () => {
    expect(
      buildEpisodeRelativePath("Love Is: A Dangerous Game?", 1, "1080p")
    ).toEqual({
      folder: "Love Is A Dangerous Game",
      filename: "Episode_001_1080p.mp4",
      relativePath: "Love Is A Dangerous Game/Episode_001_1080p.mp4"
    });
  });

  it("inspects URL, prevents duplicate downloads, tracks completion, and refreshes expired tokens", async () => {
    let playbackCount = 0;
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/series/")) {
        return new Response(
          JSON.stringify({
            series: {
              id: "ser-uuid",
              slug: "show-slug-12345678",
              title: "Test Show",
              episodeCount: 2,
              freeEpisodes: 2,
              posters: { vertical: "https://cdn.freedrama.ai/poster.jpg" }
            },
            episodes: [
              { id: "ep-1", ordinal: 1, title: "", durationS: 90, lock: "free" },
              { id: "ep-2", ordinal: 2, title: "", durationS: 95, lock: "free" }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/playback")) {
        playbackCount += 1;
        const expiresAt =
          playbackCount === 1
            ? Math.floor(Date.now() / 1000) - 10
            : Math.floor(Date.now() / 1000) + 300;
        return new Response(
          JSON.stringify({
            episodeId: "ep-1",
            seriesId: "ser-uuid",
            ordinal: 1,
            durationS: 90,
            renditions: [
              {
                height: 1920,
                width: 1080,
                mp4Url: `https://cdn.freedrama.ai/tok_${playbackCount}/video.mp4`,
                expiresAt
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const mock = setupChromeMock(mockFetch);
    await import("../extension/src/background/serviceWorker.js");

    const inspectRes = await mock.sendMessage({
      type: "INSPECT_URL",
      url: "https://freedrama.ai/en/show/show-slug-12345678/1"
    });
    expect(inspectRes.ok).toBe(true);
    expect(inspectRes.data.drama.title).toBe("Test Show");
    expect(inspectRes.data.currentRenditions[0].label).toBe("1080p");

    const enqueue1 = await mock.sendMessage({
      type: "ENQUEUE_DOWNLOADS",
      dramaTitle: "Test Show",
      seriesId: "ser-uuid",
      episodes: [{ episodeId: "ep-1", episodeNumber: 1 }],
      quality: 1920
    });
    expect(enqueue1.ok).toBe(true);
    expect(enqueue1.data.added).toBe(1);

    // Duplicate check while active
    const enqueueDup = await mock.sendMessage({
      type: "ENQUEUE_DOWNLOADS",
      dramaTitle: "Test Show",
      seriesId: "ser-uuid",
      episodes: [{ episodeId: "ep-1", episodeNumber: 1 }],
      quality: 1920
    });
    expect(enqueueDup.data.added).toBe(0);
    expect(enqueueDup.data.skippedDuplicates).toBe(1);

    // Wait for async queue resolution & chrome.downloads.download call
    for (let i = 0; i < 40; i++) {
      if ((globalThis as any).chrome.downloads.download.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 15));
    }

    expect((globalThis as any).chrome.downloads.download).toHaveBeenCalledTimes(1);
    const callArgs = (globalThis as any).chrome.downloads.download.mock.calls[0][0];
    expect(callArgs.filename).toBe("Test Show/Episode_001_1080p.mp4");
    expect(callArgs.url).toContain("tok_2"); // Expired tok_1 was refreshed!

    // Simulate Chrome completing download #100
    mock.downloadItems.get(100).state = "complete";
    mock.downloadItems.get(100).bytesReceived = 1000;
    mock.onChangedListeners[0]({ id: 100, state: { current: "complete" } });
    await new Promise((r) => setTimeout(r, 30));

    const stateRes = await mock.sendMessage({ type: "GET_STATE" });
    expect(stateRes.data.jobs[0].status).toBe("completed");
    expect(stateRes.data.jobs[0].progress).toBe(100);
  });
});
