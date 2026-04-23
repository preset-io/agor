/**
 * Single-flight wrapper around `refreshAndStoreTokens`.
 *
 * Multiple code paths can trigger a refresh concurrently (the proactive timer
 * in useAuth, the 401 retry hook on the socket client, the socket-reconnect
 * fallback in useAgorClient). Without deduping, a burst of 401s — say, five
 * parallel service calls on a stale token — produces five POSTs to
 * /authentication/refresh, each of which rotates the refresh token. Since the
 * server issues a fresh refresh token every time, the losers of the race hold
 * a stale refresh token and their next refresh cycle fails.
 *
 * This helper collapses concurrent refreshes into one in-flight request; all
 * callers resolve with the same `RefreshResult`.
 *
 * The helper also emits a `TOKENS_REFRESHED_EVENT` on `window` after a
 * successful refresh so that React state (useAuth) can sync even when the
 * refresh was initiated by a non-React code path (e.g. the Feathers hook).
 */

import type { AgorClient } from '@agor-live/client';
import { type RefreshResult, refreshAndStoreTokens } from './tokenRefresh';

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
