import { NotAuthenticated } from '@agor/core/feathers';
import type { UserAuthMetadata } from '@agor/core/types';
import type { JwtPayload } from 'jsonwebtoken';

export const AUTH_TOKEN_ISSUED_AT_MS_CLAIM = 'auth_time_ms';

export type UserAuthTokenPayload = JwtPayload & {
  type?: string;
  [AUTH_TOKEN_ISSUED_AT_MS_CLAIM]?: unknown;
};

function dateToMillis(value: Date | string | number | undefined): number | null {
  if (value === undefined) return null;
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

export function getAuthTokenIssuedAtMs(payload: UserAuthTokenPayload | undefined): number | null {
  const authTimeMs = payload?.[AUTH_TOKEN_ISSUED_AT_MS_CLAIM];
  if (typeof authTimeMs === 'number' && Number.isFinite(authTimeMs)) {
    return authTimeMs;
  }
  if (typeof authTimeMs === 'string') {
    const parsed = Number(authTimeMs);
    if (Number.isFinite(parsed)) return parsed;
  }

  return typeof payload?.iat === 'number' && Number.isFinite(payload.iat)
    ? payload.iat * 1000
    : null;
}

export function assertUserTokenNotInvalidated(
  user: UserAuthMetadata,
  payload: UserAuthTokenPayload | undefined
): void {
  const validAfterMs = dateToMillis(user.tokens_valid_after);
  if (validAfterMs === null) return;

  const issuedAtMs = getAuthTokenIssuedAtMs(payload);
  if (issuedAtMs === null || issuedAtMs <= validAfterMs) {
    throw new NotAuthenticated('Session expired, please login again');
  }
}

export function authTokenIssuedAtClaim(
  now = Date.now(),
  user?: UserAuthMetadata
): Record<typeof AUTH_TOKEN_ISSUED_AT_MS_CLAIM, number> {
  const validAfterMs = dateToMillis(user?.tokens_valid_after);
  const issuedAtMs = validAfterMs !== null && now <= validAfterMs ? validAfterMs + 1 : now;
  return { [AUTH_TOKEN_ISSUED_AT_MS_CLAIM]: issuedAtMs };
}
