/**
 * Token refresh helpers shared across auth paths in the UI.
 *
 * {@link refreshTokensSingleFlight} is a single-flight wrapper around
 *    `refreshAndStoreTokens`. Multiple code paths can trigger a refresh
 *    concurrently (the proactive timer in useAuth, visibility recovery, and
 *    rejected-handshake recovery in useAgorClient). Without
 *    deduping, a burst of 401s — say, five parallel service calls on a stale
 *    token — produces five POSTs to /authentication/refresh, each of which
 *    rotates the refresh token. Since the server issues a fresh refresh token
 *    every time, the losers of the race hold a stale refresh token and their
 *    next refresh cycle fails. Collapsing concurrent callers into one
 *    in-flight request makes all of them resolve with the same
 *    `RefreshResult`.
 *
 *    This helper also latches an `unrecoverable` state once the refresh
 *    endpoint returns a definite auth failure (401 / NotAuthenticated).
 *    Once latched, every caller rejects immediately without hitting the
 *    server so that a dead refresh token cannot produce a reconnect/refresh
 *    loop as components retry failing service calls. The latch clears on
 *    the next successful refresh (e.g. after the user logs back in).
 * Successful token replacement emits `TOKENS_REFRESHED_EVENT` on `window` so
 * React state (useAuth), socket clients, and data hooks can sync even when the
 * token replacement was initiated by a different recovery path (for example,
 * a rejected Socket.IO handshake). Refresh failures that make the session unrecoverable emit
 * `TOKENS_REFRESH_UNRECOVERABLE_EVENT` so useAuth can clear tokens and bounce
 * the user to login exactly once, instead of every call site duplicating that
 * cleanup.
 */

import type { AuthenticatedAgorClient } from '@agor-live/client';
import { isDefiniteAuthFailure } from './authErrors';
import {
  captureTokenAuthority,
  getStoredRefreshToken,
  type RefreshResult,
  RefreshSupersededError,
  refreshAndStoreTokens,
  SupersededAuthenticationError,
} from './tokenRefresh';

/** Custom DOM event fired after tokens have been successfully refreshed. */
export const TOKENS_REFRESHED_EVENT = 'agor:tokens-refreshed';

/**
 * Notify long-lived clients and React listeners that the browser has fresh
 * auth tokens. Use this for every successful auth path that stores or rotates
 * tokens while the page may already have socket/service clients alive.
 */
export function dispatchTokensRefreshed(result: RefreshResult): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<RefreshResult>(TOKENS_REFRESHED_EVENT, { detail: result }));
}

/**
 * Custom DOM event fired when the refresh endpoint returned a definite auth
 * failure. Listeners (useAuth) should treat this as "session is dead" and
 * clear tokens + bounce to login.
 */
export const TOKENS_REFRESH_UNRECOVERABLE_EVENT = 'agor:tokens-refresh-unrecoverable';

/**
 * Custom DOM event asking useAuth to revalidate stored credentials. Fired by
 * clients that stood down because the credentials they were using vanished
 * (for example another tab signed out), so auth state settles instead of
 * leaving an idle disconnected client behind an "authenticated" UI.
 */
export const AUTH_REVALIDATE_REQUESTED_EVENT = 'agor:auth-revalidate-requested';

export function requestAuthRevalidation(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AUTH_REVALIDATE_REQUESTED_EVENT));
}

/**
 * In-flight refreshes keyed by the refresh token they were issued with. A
 * caller holding different (for example newer, rotated by another tab)
 * credentials must never join a refresh for an older token: it would receive
 * a result for credentials it does not hold, or inherit that refresh's failure.
 */
const inflight = new Map<string, Promise<RefreshResult>>();

/**
 * Latched once the refresh endpoint returns a definite auth failure. While
 * latched, `refreshTokensSingleFlight` fast-fails without hitting the server.
 * Cleared on any successful refresh.
 */
let unrecoverable = false;

/**
 * Sentinel rejection surfaced by {@link refreshTokensSingleFlight} on any
 * definite auth failure — both the first occurrence (where we latch and
 * broadcast) and subsequent fast-fail calls. Callers can `instanceof`-check
 * this to distinguish "the refresh token is dead, stop" from transient
 * errors that are safe to retry. The original transport error is attached
 * as `cause` for diagnostics.
 */
export class RefreshUnrecoverableError extends Error {
  constructor(message = 'Refresh token is invalid or expired', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RefreshUnrecoverableError';
  }
}

/**
 * Reset the unrecoverable latch. Called implicitly on any successful refresh
 * and exported so the login flow can reset it after a fresh successful login
 * (in case the user logs out and back in without a page reload).
 */
export function resetRefreshFailureState(): void {
  unrecoverable = false;
}

/**
 * True when the refresh endpoint has latched as unrecoverable. Exposed for
 * tests and for callers that want to avoid kicking off doomed retries.
 */
export function isRefreshUnrecoverable(): boolean {
  return unrecoverable;
}

/**
 * Mark browser authentication unrecoverable even when token refresh itself
 * succeeded. This covers a refreshed credential that the namespace still
 * rejects (for example tenant-claim drift) and shares the same one-shot logout
 * signal as a dead refresh token.
 */
export function markAuthenticationUnrecoverable(cause?: unknown): RefreshUnrecoverableError {
  const shouldBroadcast = !unrecoverable;
  unrecoverable = true;
  if (shouldBroadcast && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(TOKENS_REFRESH_UNRECOVERABLE_EVENT));
  }
  return new RefreshUnrecoverableError('Authentication could not be restored', { cause });
}

/**
 * Request a token refresh, deduplicating concurrent callers.
 *
 * @param client - REST Feathers client capable of hitting
 *                 `authentication/refresh`. Credential recovery must never
 *                 traverse the socket transport it may be repairing.
 * @param refreshToken - Current refresh token.
 */
export function refreshTokensSingleFlight(
  client: AuthenticatedAgorClient,
  refreshToken: string
): Promise<RefreshResult> {
  // Logout must not start a new refresh request.
  if (!getStoredRefreshToken()) return Promise.reject(new SupersededAuthenticationError());
  // Fast-fail if we already know the refresh token is dead. Without this,
  // every recovery caller would trigger a brand-new POST
  // to /authentication/refresh that also 401s, producing a tight loop as
  // components retry failing service calls. One latched failure is enough;
  // useAuth handles the cleanup (clearTokens + redirect to login).
  if (unrecoverable) {
    return Promise.reject(new RefreshUnrecoverableError());
  }

  const existing = inflight.get(refreshToken);
  if (existing) return existing;

  const isCurrent = captureTokenAuthority();
  const flight: Promise<RefreshResult> = refreshAndStoreTokens(client, refreshToken)
    .then((result) => {
      if (!isCurrent()) throw new SupersededAuthenticationError();
      // Successful refresh clears any prior unrecoverable state — e.g. if
      // the user logged out and back in, or a transient failure was
      // misclassified, resume normal operation.
      unrecoverable = false;
      // Notify listeners (useAuth, socket clients, data hooks) that tokens
      // have rotated.
      dispatchTokensRefreshed(result);
      return result;
    })
    .catch((err) => {
      // Distinguish dead-refresh-token (latch + broadcast, break the loop)
      // from transient failures (propagate; the caller will retry on its
      // own cadence and the next attempt may succeed).
      //
      // On definite failure, throw RefreshUnrecoverableError rather than the
      // original auth error — otherwise the first caller's catch would see a
      // plain 401 and fall through to its retry path, racing the
      // unrecoverable-event listener that just cleared tokens. Wrapping with
      // `cause` preserves diagnostics. Subsequent callers fast-fail with the
      // same type via the `unrecoverable` guard above.
      if (!isCurrent()) throw new SupersededAuthenticationError();
      if (isDefiniteAuthFailure(err)) {
        // A rejection of a refresh token that is no longer the stored one
        // (rotated by another tab, replaced by a newer sign-in, or cleared by
        // logout) says nothing about the credentials now in force. It must
        // neither latch nor broadcast, or it would sign out a user who has
        // since authenticated with newer tokens.
        if (getStoredRefreshToken() !== refreshToken) throw new RefreshSupersededError();
        throw markAuthenticationUnrecoverable(err);
      }
      throw err;
    })
    .finally(() => {
      if (inflight.get(refreshToken) === flight) inflight.delete(refreshToken);
    });

  inflight.set(refreshToken, flight);
  return flight;
}
