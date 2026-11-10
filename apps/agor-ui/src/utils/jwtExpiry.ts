/**
 * Client-side JWT expiry helpers.
 *
 * Thin re-export of `@agor-live/client/jwt`, which itself re-exports the
 * shared decoder from `@agor/core/utils/jwt`. The daemon-side
 * `resolveTokenExpiry` cascade uses the same implementation, so there is
 * exactly one decoder in the tree — no drift between client and server.
 *
 * We decode (NOT verify) the payload purely to learn when the token will be
 * rejected by the server, so we can schedule a proactive refresh. The server
 * is still the only party that validates signatures.
 */

export { decodeJwtExpMs, isExpiringSoon, msUntilExpiry } from '@agor-live/client/jwt';

const AUTO_REFRESH_BUFFER_MS = 60_000;
const AUTO_REFRESH_MIN_DELAY_MS = 1_000;
const AUTO_REFRESH_FALLBACK_DELAY_MS = 5 * 60_000;
const AUTO_REFRESH_RETRY_BASE_MS = 5_000;
const AUTO_REFRESH_RETRY_MAX_MS = 5 * 60_000;

/**
 * Delay before the next auto-refresh. A refresh that returned the same `exp` (a server-capped
 * token) waits for that expiry instead of refreshing every second until it passes.
 */
export function autoRefreshDelayMs(
  untilExpMs: number | null,
  lastRefreshDidNotExtend: boolean
): number {
  if (untilExpMs === null) return AUTO_REFRESH_FALLBACK_DELAY_MS;
  return Math.max(
    AUTO_REFRESH_MIN_DELAY_MS,
    lastRefreshDidNotExtend ? untilExpMs : untilExpMs - AUTO_REFRESH_BUFFER_MS
  );
}

/** Delay before retrying a transiently failed auto-refresh: doubles from 5s, capped at 5 minutes. */
export function autoRefreshRetryDelayMs(attempt: number): number {
  return Math.min(
    AUTO_REFRESH_RETRY_MAX_MS,
    AUTO_REFRESH_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1)
  );
}
