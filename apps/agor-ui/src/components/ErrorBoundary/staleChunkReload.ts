// A deploy replaces hashed chunks a long-lived tab still references (#2181); reloading loads the current build.

// Chromium, Firefox, Safari, and Vite's CSS preload failure, respectively.
const DYNAMIC_IMPORT_FAILURE_RE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export const STALE_CHUNK_RELOAD_KEY = 'agor:stale-chunk-reload';
export const STALE_CHUNK_RELOAD_WINDOW_MS = 10 * 60_000;
// A beforeunload prompt can cancel the reload; fall back to the crash screen rather than spin forever.
export const RELOAD_FALLBACK_MS = 5_000;

interface StaleChunkReloadRecord {
  message: string;
  at: number;
}

export function isDynamicImportFailure(error: unknown): boolean {
  return error instanceof Error && DYNAMIC_IMPORT_FAILURE_RE.test(error.message);
}

function readLastReload(): StaleChunkReloadRecord | null {
  const raw = window.sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StaleChunkReloadRecord>;
    return typeof parsed.message === 'string' && typeof parsed.at === 'number'
      ? { message: parsed.message, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

// The same failure surviving a reload means the chunk is really missing; Safari's message has no URL, so there one guard covers every chunk.
export function reloadForStaleChunk(error: Error, now: number = Date.now()): boolean {
  // Offline, a reload only swaps the crash screen for the browser's error page.
  if (!navigator.onLine) return false;
  try {
    const last = readLastReload();
    if (last?.message === error.message && Math.abs(now - last.at) < STALE_CHUNK_RELOAD_WINDOW_MS) {
      return false;
    }
    const record: StaleChunkReloadRecord = { message: error.message, at: now };
    window.sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, JSON.stringify(record));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
