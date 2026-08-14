/**
 * Bounded await for Claude Agent SDK control requests.
 *
 * Control requests (e.g. `getContextUsage()`) are answered by the CLI
 * subprocess over stdin/stdout and the SDK resolves them ONLY when a matching
 * `control_response` arrives — there is no built-in timeout. On the terminal
 * result path we deliberately hold the input stream open so the control request
 * can use stdin, which means a subprocess that never answers leaves the await
 * pending forever, the query generator never closes, and the Task never settles.
 *
 * `awaitWithTimeout` races the control request against a bounded timer so the
 * lifecycle can always converge: the caller gets the real value when the
 * subprocess answers in time, or the `AWAIT_TIMEOUT` sentinel so it can degrade
 * gracefully and finish settling the turn.
 */

/** Sentinel resolved when the awaited promise does not settle within the budget. */
export const AWAIT_TIMEOUT = Symbol('await-timeout');

export async function awaitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | typeof AWAIT_TIMEOUT> {
  // The losing promise stays pending (or rejects later when the transport
  // closes). Attach a no-op catch so a late rejection can't surface as an
  // unhandledRejection after we've already moved on.
  promise.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof AWAIT_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(AWAIT_TIMEOUT), timeoutMs);
        // Never let the safety timer keep the process alive on its own.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
