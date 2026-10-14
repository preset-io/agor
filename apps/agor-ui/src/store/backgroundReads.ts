/**
 * Foreground priority for background reads. Every service call shares one
 * WebSocket, so a background partition's session pages sent first delay the
 * open session's transcript behind them (head-of-line). Foreground reads —
 * the open session's first transcript page, the displayed board's partition —
 * hold background partition loads until they settle. Each background read
 * waits at most one bound from when it began (`backgroundReadsClear`), however
 * many holds overlap meanwhile, so a stream of foreground reads never starves
 * it; a hold that never settles is dropped after the same bound.
 */
/** The bound, like the boot transcript prefetch's priority timeout. */
export const FOREGROUND_HOLD_TIMEOUT_MS = 10_000;

const holds = new Set<Promise<void>>();

/** Hold background reads until `ready` settles (or `timeoutMs` passes). */
export function holdBackgroundReads(
  ready: Promise<unknown>,
  timeoutMs = FOREGROUND_HOLD_TIMEOUT_MS
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const hold: Promise<void> = Promise.race([
    ready.then(
      () => undefined,
      () => undefined
    ),
    timedOut,
  ]).then(() => {
    clearTimeout(timer);
    holds.delete(hold);
  });
  holds.add(hold);
}

/**
 * Settles once no foreground read holds background reads (holds added
 * meanwhile included), or `FOREGROUND_HOLD_TIMEOUT_MS` after it was called.
 */
export async function backgroundReadsClear(): Promise<void> {
  if (holds.size === 0) return;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve();
    }, FOREGROUND_HOLD_TIMEOUT_MS);
  });
  try {
    while (holds.size > 0 && !expired) await Promise.race([Promise.all(holds), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
