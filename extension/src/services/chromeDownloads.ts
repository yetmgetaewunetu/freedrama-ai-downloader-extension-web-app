export async function startChromeDownload(
  url: string,
  filename: string
): Promise<number> {
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });
  if (typeof downloadId !== "number") {
    throw new Error("Chrome did not return a download ID.");
  }
  return downloadId;
}

export async function findChromeDownload(
  downloadId: number
): Promise<chrome.downloads.DownloadItem | null> {
  const items = await chrome.downloads.search({ id: downloadId });
  return items[0] ?? null;
}

export async function cancelChromeDownload(downloadId: number): Promise<void> {
  try {
    await chrome.downloads.cancel(downloadId);
  } catch {
    // Ignore if already completed/cancelled in Chrome.
  }
}

export function showChromeDownload(downloadId: number): void {
  chrome.downloads.show(downloadId);
}
