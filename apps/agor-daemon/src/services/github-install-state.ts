/**
 * GitHub App install state-nonce store.
 *
 * CSRF protection for the GitHub App install flow. When an admin initiates
 * an install via the UI (authenticated request), we issue a random one-time
 * state token bound to the admin's user_id and embed it in the GitHub App's
 * setup_url. GitHub forwards the state query param on the post-install
 * redirect; the callback route consumes the state once, which is what
 * proves the request originated from our authenticated initiation endpoint.
 *
 * The stored user_id is available via the `expectedUserId` parameter of
 * `consumeInstallState` but is not currently enforced at the callback —
 * the browser redirect back from GitHub has no way to re-authenticate
 * the caller. Possession of the state itself is the auth proof. The
 * user_id is retained so future flows (or audit logs) can compare the
 * bound user against whatever context they do have.
 *
 * Tradeoff: state is kept in an in-memory Map. Daemon restart between
 * initiation and GitHub redirect will drop the state and force the admin
 * to restart the install flow. A short-lived DB table would survive
 * restarts but the current blast-radius (10-min install window) is small
 * enough that in-memory is acceptable as a first pass.
 */

import { randomBytes } from 'node:crypto';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PURGE_INTERVAL_MS = 60 * 1000; // sweep expired entries every minute
const STATE_BYTES = 32; // 256 bits of entropy

interface PendingState {
  userId: string;
  expiresAt: number;
}

const pendingStates = new Map<string, PendingState>();

let purgeTimer: NodeJS.Timeout | null = null;

function ensurePurgeTimer(): void {
  if (purgeTimer) return;
  purgeTimer = setInterval(() => {
    const now = Date.now();
    for (const [state, entry] of pendingStates) {
      if (entry.expiresAt <= now) pendingStates.delete(state);
    }
  }, PURGE_INTERVAL_MS);
  // Don't keep the Node event loop alive just for this sweeper.
  if (typeof purgeTimer.unref === 'function') purgeTimer.unref();
}

/**
 * Issue a new one-time state token bound to the given user_id.
 * The token is only valid for a single `consumeInstallState` call
 * within the TTL window.
 */
export function issueInstallState(userId: string): string {
  if (!userId || typeof userId !== 'string') {
    throw new Error('issueInstallState requires a non-empty userId');
  }
  ensurePurgeTimer();
  const state = randomBytes(STATE_BYTES).toString('hex');
  pendingStates.set(state, {
    userId,
    expiresAt: Date.now() + STATE_TTL_MS,
  });
  return state;
}

export type ConsumeResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'missing' | 'unknown' | 'expired' | 'user-mismatch' };

/**
 * Consume a state token. One-shot: on any return value (ok or not),
 * the token is removed from the store.
 *
 * If `expectedUserId` is provided, the stored user_id must match or
 * the call returns `user-mismatch` (and the state is still consumed,
 * preventing retries).
 */
export function consumeInstallState(
  state: string | undefined,
  expectedUserId?: string
): ConsumeResult {
  if (!state || typeof state !== 'string') {
    return { ok: false, reason: 'missing' };
  }
  const entry = pendingStates.get(state);
  if (!entry) {
    return { ok: false, reason: 'unknown' };
  }
  // One-shot: always delete on any observation.
  pendingStates.delete(state);
  if (entry.expiresAt <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (expectedUserId !== undefined && entry.userId !== expectedUserId) {
    return { ok: false, reason: 'user-mismatch' };
  }
  return { ok: true, userId: entry.userId };
}

/**
 * Test-only helper: drop all pending state and reset the sweeper.
 * Not exported from any index file — tests import it directly.
 */
export function __resetInstallStateForTests(): void {
  pendingStates.clear();
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
}
