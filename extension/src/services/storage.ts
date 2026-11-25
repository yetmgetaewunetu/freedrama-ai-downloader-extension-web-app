import type {
  ExtensionDownloadJob,
  InspectedDramaState
} from "../types/messages.js";

const JOBS_STORAGE_KEY = "freedrama_jobs_v1";
const INSPECTED_STORAGE_KEY = "freedrama_last_inspected_v1";

let lockChain: Promise<unknown> = Promise.resolve();

export function withJobsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lockChain.then(fn, fn);
  lockChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export async function loadJobs(): Promise<ExtensionDownloadJob[]> {
  const result = await chrome.storage.local.get(JOBS_STORAGE_KEY);
  const raw = result[JOBS_STORAGE_KEY];
  return Array.isArray(raw) ? (raw as ExtensionDownloadJob[]) : [];
}

export async function saveJobs(jobs: ExtensionDownloadJob[]): Promise<void> {
  await chrome.storage.local.set({ [JOBS_STORAGE_KEY]: jobs });
}

export async function loadLastInspected(): Promise<InspectedDramaState | null> {
  const result = await chrome.storage.local.get(INSPECTED_STORAGE_KEY);
  const raw = result[INSPECTED_STORAGE_KEY];
  return raw ? (raw as InspectedDramaState) : null;
}

export async function saveLastInspected(state: InspectedDramaState): Promise<void> {
  await chrome.storage.local.set({ [INSPECTED_STORAGE_KEY]: state });
}
