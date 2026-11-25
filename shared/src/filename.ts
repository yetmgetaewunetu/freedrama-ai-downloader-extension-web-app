const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9"
]);

export function sanitizePathSegment(input: string, fallback: string): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100);

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return fallback;
  }

  if (WINDOWS_RESERVED_NAMES.has(cleaned.toUpperCase())) {
    return `${cleaned}_dir`;
  }

  return cleaned;
}

export function buildEpisodeRelativePath(
  dramaTitle: string,
  ordinal: number,
  qualityLabel?: string
): { folder: string; filename: string; relativePath: string } {
  const safeFolder = sanitizePathSegment(dramaTitle, "FreeDrama_Series");
  const paddedEp = String(Math.max(1, ordinal)).padStart(3, "0");
  const rawFilename = qualityLabel
    ? `Episode_${paddedEp}_${qualityLabel}.mp4`
    : `Episode_${paddedEp}.mp4`;
  const safeFilename = sanitizePathSegment(rawFilename, `Episode_${paddedEp}.mp4`);
  return {
    folder: safeFolder,
    filename: safeFilename,
    relativePath: `${safeFolder}/${safeFilename}`
  };
}
