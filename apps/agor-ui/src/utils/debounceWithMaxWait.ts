/** Trailing delay that coalesces a burst of invalidations. */
export const SERVER_READ_DEBOUNCE_MS = 300;
/** A sustained burst still re-reads within this bound. */
export const SERVER_READ_MAX_WAIT_MS = 2000;

/** A trailing debounce that still fires within `maxWaitMs` of a burst's first request. */
export function debounceWithMaxWait(
  fn: () => void,
  debounceMs = SERVER_READ_DEBOUNCE_MS,
  maxWaitMs = SERVER_READ_MAX_WAIT_MS
): { request: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstRequestAt = 0;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const request = () => {
    const now = Date.now();
    if (timer === null) firstRequestAt = now;
    else clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = null;
        fn();
      },
      Math.max(0, Math.min(debounceMs, firstRequestAt + maxWaitMs - now))
    );
  };
  return { request, cancel };
}
