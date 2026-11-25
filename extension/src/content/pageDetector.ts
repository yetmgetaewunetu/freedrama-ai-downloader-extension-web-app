import { parseFreeDramaUrl } from "../../../shared/src/url.js";
import type { PageContext, RuntimeRequest } from "../types/messages.js";

function extractJsonLdSeries(): { name?: string; image?: string } | null {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || "");
      if (data && data["@type"] === "TVSeries") {
        return {
          name: typeof data.name === "string" ? data.name : undefined,
          image: typeof data.image === "string" ? data.image : undefined
        };
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }
  return null;
}

function getMetaContent(property: string): string | undefined {
  const el = document.querySelector(`meta[property="${property}"]`);
  const content = el?.getAttribute("content")?.trim();
  return content || undefined;
}

function detectCurrentPage(): PageContext {
  const url = window.location.href;
  const ldSeries = extractJsonLdSeries();
  const rawTitle =
    ldSeries?.name ||
    getMetaContent("og:title") ||
    document.title.replace(/\s*\|\s*FreeDrama.*$/i, "").trim() ||
    undefined;
  const thumbnail = ldSeries?.image || getMetaContent("og:image") || null;

  try {
    const parsed = parseFreeDramaUrl(url);
    if (parsed.kind === "episode") {
      return {
        supported: true,
        kind: "episode",
        url,
        slug: parsed.slug,
        episodeNumber: parsed.ordinal,
        title: rawTitle,
        thumbnail
      };
    }

    return {
      supported: true,
      kind: "drama",
      url,
      slug: parsed.slug,
      title: rawTitle,
      thumbnail
    };
  } catch {
    return {
      supported: false,
      kind: "other",
      url,
      title: rawTitle,
      thumbnail
    };
  }
}

chrome.runtime.onMessage.addListener(
  (message: RuntimeRequest, _sender, sendResponse) => {
    if (message?.type === "GET_PAGE_CONTEXT") {
      sendResponse({ ok: true, data: detectCurrentPage() });
    }
    return false;
  }
);
