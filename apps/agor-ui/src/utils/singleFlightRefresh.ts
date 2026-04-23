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
 * 2. {@link refreshAndReauthenticate} — the common "token expired → refresh
 *    → reauthenticate the socket client" sequence used by both the socket
 *    reconnect fallback in useAgorClient and the 401-retry hook on the
 *    same client. Extracted here so the two paths stay in lockstep.
 *
 * The single-flight helper also emits a `TOKENS_REFRESHED_EVENT` on `window`
 * after a successful refresh so that React state (useAuth) can sync even when
 * the refresh was initiated by a non-React code path (e.g. the Feathers hook).
 */

import type { AgorClient } from '@agor-live/client';
import { getStoredRefreshToken, type RefreshResult, refreshAndStoreTokens } from './tokenRefresh';

/** Custom DOM event fired after tokens have been successfully refreshed. */
export const TOKENS_REFRESHED_EVENT = 'agor:tokens-refreshed';

let inflight: Promise<RefreshResult> | null = null;

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
  if (inflight) return inflight;

  inflight = refreshAndStoreTokens(client, refreshToken)
    .then((result) => {
      // Notify listeners (useAuth) that tokens have rotated.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent<RefreshResult>(TOKENS_REFRESHED_EVENT, { detail: result })
        );
      }
      return result;
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
