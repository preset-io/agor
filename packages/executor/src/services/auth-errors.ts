/**
 * Shared classification helpers for Feathers/HTTP auth errors.
 *
 * Mirrored from the UI's `apps/agor-ui/src/utils/authErrors.ts` (PR #1058) so
 * the executor's socket client classifies auth failures the same way the
 * browser client does. The two live in separate build graphs (UI app vs.
 * executor package) so the logic is duplicated rather than imported; keep them
 * in sync when either changes.
 *
 * Two classifiers:
 *
 * - {@link isDefiniteAuthFailure} — "the server rejected our credentials."
 *   Callers should attempt a single re-authentication and, if that also fails,
 *   surface the error rather than looping.
 * - {@link isTransientConnectionError} — "the server is unreachable or is
 *   temporarily failing." Callers should NOT treat this as an auth failure;
 *   the socket transport's own reconnect handles it. Definite auth failures are
 *   excluded so a true value is always safe to treat as "retry later, keep
 *   credentials."
 */

type FeathersLikeError = {
  name?: string;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  className?: string;
  message?: string;
};

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as FeathersLikeError;
  if (typeof e.code === 'number') return e.code;
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

/**
 * True when the error represents a definite auth failure: the credentials
 * were rejected (401 / 403), or Feathers explicitly raised NotAuthenticated.
 * The executor's 401-retry hook treats this as "the socket lost its auth —
 * try re-authenticating once with the still-valid session JWT."
 */
export function isDefiniteAuthFailure(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 401 || status === 403) return true;
  if (!err || typeof err !== 'object') return false;
  const e = err as FeathersLikeError;
  if (e.name === 'NotAuthenticated') return true;
  if (e.className === 'not-authenticated') return true;
  return false;
}

/**
 * True when the error looks like a transient connection/server issue
 * (network drop, 5xx, timeout, rate-limit) rather than a rejected
 * credential. Definite auth failures always return false so a true value
 * is safely "retry later without re-authenticating."
 */
export function isTransientConnectionError(err: unknown): boolean {
  if (isDefiniteAuthFailure(err)) return false;

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
