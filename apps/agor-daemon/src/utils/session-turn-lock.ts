/**
 * Per-session process-local turn coalescer.
 *
 * Used by code paths that prepare or drain one Session turn:
 *
 *   - `POST /sessions/:id/prompt` — durably enqueue, then attempt the queue-head
 *     dispatch claim.
 *   - `POST /tasks/:id/run` — claim a pre-existing CREATED task and spawn it.
 *   - The queue processor's drain loop (`processNextQueuedTask`) — inspect the
 *     next QUEUED task and attempt its dispatch claim.
 *
 * Mutual exclusion is per-session-ID; different sessions never block each
 * other. This Map is intentionally not correctness state: every daemon owns a
 * different Map and process death erases it. Durable queue-position admission
 * and the Session-first Task dispatch claim provide cross-daemon correctness.
 *
 * Both this helper and the queue processor share one local Map only to reduce
 * redundant preparation and noisy claim losses. Tests for this helper pin
 * coalescing behavior, not the one-active-turn invariant.
 */
import type { SessionID } from '@agor/core/types';

export type SessionTurnLocks = Map<SessionID, Promise<void>>;

/**
 * Run `fn` while holding the session-turn lock for `sessionId`. Other
 * callers contending for the same session wait their turn (FIFO-ish — set
 * order through the Map). Errors thrown by `fn` propagate to the caller and
 * the lock is released either way.
 *
 * Pass `options.waiterTimeoutMs` to limit how long this call waits for the
 * lock. If the timeout fires before the lock is available, throws an Error.
 * Use this on HTTP request handlers so a stuck lock holder (broken DB
 * connection, etc.) does not hang the request indefinitely.
 */
export async function withSessionTurnLock<T>(
  locks: SessionTurnLocks,
  sessionId: SessionID,
  fn: () => Promise<T>,
  options?: { waiterTimeoutMs?: number }
): Promise<T> {
  const waiterTimeoutMs = options?.waiterTimeoutMs;
  const waitStart = waiterTimeoutMs !== undefined ? Date.now() : 0;

  // Drain any in-flight turns. The loop handles a chain of waiters: if A
  // holds the lock and B starts waiting, then C arrives, C waits on B's
  // observation of A's promise, then re-checks. Without the loop, two
  // waiters might both observe an empty map after A releases and both
  // proceed to acquire — defeating the mutual exclusion.
  while (locks.has(sessionId)) {
    const existingLock = locks.get(sessionId);

    if (waiterTimeoutMs !== undefined) {
      const remaining = waiterTimeoutMs - (Date.now() - waitStart);
      if (remaining <= 0) {
        throw new Error(
          `Session turn lock acquisition timed out after ${waiterTimeoutMs}ms (session ${sessionId})`
        );
      }
      const outcome = await Promise.race([
        // Swallow the awaited promise's rejection — the original caller already
        // received the error; waiters only care about lock ordering.
        existingLock?.catch(() => undefined).then(() => 'released' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
      ]);
      if (outcome === 'timeout') {
        throw new Error(
          `Session turn lock acquisition timed out after ${waiterTimeoutMs}ms (session ${sessionId})`
        );
      }
    } else {
      // Swallow the awaited promise's rejection — the original caller already
      // received the error; waiters only care about lock ordering.
      await existingLock?.catch(() => undefined);
    }
  }

  let resolveLock!: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    resolveLock = resolve;
  });
  locks.set(sessionId, lockPromise);

  try {
    return await fn();
  } finally {
    locks.delete(sessionId);
    resolveLock();
  }
}
