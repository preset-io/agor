/**
 * Per-session "turn" lock — single source of truth for "who's allowed to
 * transition `session.status: idle → running` right now" mutual exclusion.
 *
 * Acquired by every code path that decides between spawning an executor
 * immediately vs. queueing:
 *
 *   - `POST /sessions/:id/prompt` (idle branch) — create CREATED task + spawn,
 *     or fall through to queue if a concurrent caller already flipped the
 *     session to RUNNING while we waited for the lock.
 *   - `POST /tasks/:id/run` — claim a pre-existing CREATED task and spawn it.
 *   - The queue processor's drain loop (`processNextQueuedTask`) — pop the
 *     next QUEUED task and spawn it.
 *
 * Mutual exclusion is per-session-ID; different sessions never block each
 * other. Single-process only: multi-instance deployments would additionally
 * need a row-level DB lock or atomic conditional UPDATE on `sessions.status`.
 *
 * Both this helper and the queue processor share the same `Map<SessionID,
 * Promise<void>>` instance — that's what makes the "no two callers spawn
 * concurrently for the same session" invariant hold across all entry points.
 */
import type { SessionID } from '@agor/core/types';

export type SessionTurnLocks = Map<SessionID, Promise<void>>;

/**
 * Run `fn` while holding the session-turn lock for `sessionId`. Other
 * callers contending for the same session wait their turn (FIFO-ish — set
 * order through the Map). Errors thrown by `fn` propagate to the caller and
 * the lock is released either way.
 */
export async function withSessionTurnLock<T>(
  locks: SessionTurnLocks,
  sessionId: SessionID,
  fn: () => Promise<T>
): Promise<T> {
  // Drain any in-flight turns. The loop handles a chain of waiters: if A
  // holds the lock and B starts waiting, then C arrives, C waits on B's
  // observation of A's promise, then re-checks. Without the loop, two
  // waiters might both observe an empty map after A releases and both
  // proceed to acquire — defeating the mutual exclusion.
  while (locks.has(sessionId)) {
    // Swallow the awaited promise's rejection — the original caller already
    // received the error; waiters only care about lock ordering.
    await locks.get(sessionId)?.catch(() => undefined);
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
