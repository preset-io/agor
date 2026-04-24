/**
 * Token refresh helpers shared across auth paths in the UI.
 *
 * Two operations live here:
 *
 * 1. {@link refreshTokensSingleFlight} — single-flight wrapper around
 *    `refreshAndStoreTokens`. Multiple code paths can trigger a refresh
 *    concurrently (the proactive timer in useAuth, the 401 retry hook on the
 *    socket client, the socket-reconnect fallback in useAgorClient). Without
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
 *
 * 2. {@link refreshAndReauthenticate} — the common "token expired → refresh
 *    → reauthenticate the socket client" sequence used by both the socket
 *    reconnect fallback in useAgorClient and the 401-retry hook on the
 *    same client. Extracted here so the two paths stay in lockstep.
 *
 * The single-flight helper also emits a `TOKENS_REFRESHED_EVENT` on `window`
 * after a successful refresh so that React state (useAuth) can sync even when
 * the refresh was initiated by a non-React code path (e.g. the Feathers hook).
 * On unrecoverable failure it emits `TOKENS_REFRESH_UNRECOVERABLE_EVENT` so
 * useAuth can clear tokens and bounce the user to login exactly once,
 * instead of every call site duplicating that cleanup.
 */

import type { AgorClient } from '@agor-live/client';
import { isDefiniteAuthFailure } from './authErrors';
import { getStoredRefreshToken, type RefreshResult, refreshAndStoreTokens } from './tokenRefresh';

/** Custom DOM event fired after tokens have been successfully refreshed. */
export const TOKENS_REFRESHED_EVENT = 'agor:tokens-refreshed';

/**
 * Custom DOM event fired when the refresh endpoint returned a definite auth
 * failure. Listeners (useAuth) should treat this as "session is dead" and
 * clear tokens + bounce to login.
 */
export const TOKENS_REFRESH_UNRECOVERABLE_EVENT = 'agor:tokens-refresh-unrecoverable';

let inflight: Promise<RefreshResult> | null = null;

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
 * Request a token refresh, deduplicating concurrent callers.
 *
 * @param client - REST or socket Feathers client capable of hitting
 *                 `authentication/refresh`.
 * @param refreshToken - Current refresh token.
 */
export function refreshTokensSingleFlight(
  client: AgorClient,
  refreshToken: string
): Promise<RefreshResult> {
  // Fast-fail if we already know the refresh token is dead. Without this,
  // every 401 surfaced by the around-hook would trigger a brand-new POST
  // to /authentication/refresh that also 401s, producing a tight loop as
  // components retry failing service calls. One latched failure is enough;
  // useAuth handles the cleanup (clearTokens + redirect to login).
  if (unrecoverable) {
    return Promise.reject(new RefreshUnrecoverableError());
  }

  if (inflight) return inflight;

  inflight = refreshAndStoreTokens(client, refreshToken)
    .then((result) => {
      // Successful refresh clears any prior unrecoverable state — e.g. if
      // the user logged out and back in, or a transient failure was
      // misclassified, resume normal operation.
      unrecoverable = false;
      // Notify listeners (useAuth) that tokens have rotated.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent<RefreshResult>(TOKENS_REFRESHED_EVENT, { detail: result })
        );
      }
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
      if (isDefiniteAuthFailure(err)) {
        unrecoverable = true;
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(TOKENS_REFRESH_UNRECOVERABLE_EVENT));
        }
        throw new RefreshUnrecoverableError(undefined, { cause: err });
      }
      throw err;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/**
 * Refresh the access token (single-flight) and re-authenticate the given
 * Feathers client with the freshly-issued access token via the JWT strategy.
 *
 * Used by both the socket-reconnect fallback and the 401-retry around hook
 * on the long-lived socket client. Returns null if no refresh token is
 * stored; throws if the refresh call or the subsequent `authenticate()` call
 * fails so callers can decide how to surface the failure.
 */
export async function refreshAndReauthenticate(client: AgorClient): Promise<RefreshResult | null> {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) return null;

  const refreshed = await refreshTokensSingleFlight(client, refreshToken);
  await client.authenticate({
    strategy: 'jwt',
    accessToken: refreshed.accessToken,
  });
  return refreshed;
}
