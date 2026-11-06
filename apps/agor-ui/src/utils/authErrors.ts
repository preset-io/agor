/**
 * Shared classification helpers for Feathers/HTTP auth errors.
 *
 * Consolidates logic that was previously duplicated across useAuth,
 * singleFlightRefresh, and useAgorClient handshake recovery — those diverged on
 * 403 / 429 / 500 handling over time, which is exactly the kind of drift
 * that produces reconnect/refresh loops.
 *
 * Three classifiers:
 *
 * - {@link isDefiniteAuthFailure} — "the server rejected our credentials."
 *   Callers should clear tokens and bounce to login.
 * - {@link isTransientConnectionError} — "the server is unreachable or is
 *   temporarily failing." Callers should keep tokens and retry on their
 *   own cadence. Definite auth failures are excluded so a true value is
 *   always safe to treat as "retryable."
 * - {@link isTenantRestrictedError} — "this workspace is closed"; keep tokens and do not retry.
 */

import { TENANT_RESTRICTED_ERROR_CODE } from '@agor/core/types';

type FeathersLikeError = {
  name?: string;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  className?: string;
  message?: string;
  data?: unknown;
};

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as FeathersLikeError;
  if (typeof e.code === 'number') return e.code;
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  if (e.data && typeof e.data === 'object') return statusOf(e.data);
  return undefined;
}

/**
 * True when the error represents a definite auth failure: the credentials
 * were rejected with 401, or Feathers explicitly raised NotAuthenticated.
 * Callers should treat this as "session is dead" — clear tokens, bounce
 * to login, fast-fail pending refreshes. A coded restriction 401 is excluded: the credential itself is fine.
 */
export function isDefiniteAuthFailure(err: unknown): boolean {
  if (isTenantRestrictedError(err)) return false;
  const status = statusOf(err);
  if (status === 401) return true;
  if (!err || typeof err !== 'object') return false;
  const e = err as FeathersLikeError;
  if (e.name === 'NotAuthenticated') return true;
  if (e.className === 'not-authenticated') return true;
  if (e.data && typeof e.data === 'object') return isDefiniteAuthFailure(e.data);
  return false;
}

/** True only for the daemon's stable restriction code in `data` (401 or 403); message text and 503s never qualify. */
export function isTenantRestrictedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const data = (err as FeathersLikeError).data;
  if (!data || typeof data !== 'object') return false;
  return (data as { code?: unknown }).code === TENANT_RESTRICTED_ERROR_CODE;
}

/** The daemon's handshake answer when it cannot read the credential generation: keep tokens, reconnect with backoff. */
export function isUnavailableHandshakeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const data = (err as FeathersLikeError).data as { code?: unknown; className?: unknown } | null;
  return data?.code === 503 && data.className === 'unavailable';
}

/**
 * True when the error looks like a transient connection/server issue
 * (network drop, 5xx, timeout, rate-limit) rather than a rejected
 * credential. Definite auth failures always return false so a true value
 * is safely retryable without clearing tokens.
 */
export function isTransientConnectionError(err: unknown): boolean {
  if (isDefiniteAuthFailure(err)) return false;
  // A restricted tenant is a durable decision; retrying it on the transient cadence would storm.
  if (isTenantRestrictedError(err)) return false;

  const status = statusOf(err);
  if (status === 0 || status === 408 || status === 429) return true;
  if (status !== undefined && status >= 500) return true;

  if (!err || typeof err !== 'object') return false;
  const e = err as FeathersLikeError;
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  const name = err instanceof Error ? err.constructor.name : '';

  if (name === 'TypeError' && message.includes('fetch')) return true;

  return (
    message.includes('connection') ||
    message.includes('timeout') ||
    message.includes('websocket') ||
    message.includes('transport') ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network error') ||
    message.includes('load failed') ||
    name === 'TransportError' ||
    name === 'WebSocketError'
  );
}
