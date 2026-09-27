import { NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticationUserAuthMetadata, UserAuthMetadata } from '@agor/core/types';
import type { JwtPayload } from 'jsonwebtoken';

export const AUTH_FORMAT_CLAIM = 'auth_format';
export const AUTH_FORMAT_VERSION = 1;
export const SOURCE_API_KEY_CLAIM = 'source_api_key_id';

export function assertUserAccessEnabled(user: { access_disabled?: boolean }): void {
  if (user.access_disabled === true) throw new NotAuthenticated('User access is disabled');
}

export function sourceApiKeyClaims(
  payload: Record<string, unknown> | undefined
): Record<string, string> {
  const id = payload?.[SOURCE_API_KEY_CLAIM];
  if (id === undefined) return {};
  if (typeof id !== 'string' || !id || id.length > 128)
    throw new NotAuthenticated('Invalid source key');
  return { [SOURCE_API_KEY_CLAIM]: id };
}

export const AUTH_TOKEN_ISSUED_AT_MS_CLAIM = 'auth_time_ms';
export const AUTH_CREDENTIAL_GENERATION_CLAIM = 'auth_credential_generation';

export type UserAuthTokenPayload = JwtPayload & {
  type?: string;
  [AUTH_TOKEN_ISSUED_AT_MS_CLAIM]?: unknown;
  [AUTH_CREDENTIAL_GENERATION_CLAIM]?: unknown;
};

function credentialGeneration(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

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
): asserts user is AuthenticationUserAuthMetadata {
  assertAuthenticationUserAuthMetadata(user);
  if (payload?.[AUTH_FORMAT_CLAIM] !== AUTH_FORMAT_VERSION) {
    throw new NotAuthenticated('Session expired, please login again');
  }
  const currentGeneration = user.credential_generation;
  const tokenGeneration = credentialGeneration(payload?.[AUTH_CREDENTIAL_GENERATION_CLAIM]);

  // Tokens issued before credential generations were introduced are generation
  // zero. They remain valid across the upgrade, but the first password change
  // increments the row and invalidates them without relying on replica clocks.
  if ((tokenGeneration ?? 0) !== currentGeneration) {
    throw new NotAuthenticated('Session expired, please login again');
  }

  const validAfterMs = dateToMillis(user.tokens_valid_after);
  if (validAfterMs === null) return;

  const issuedAtMs = getAuthTokenIssuedAtMs(payload);
  if (issuedAtMs === null || issuedAtMs <= validAfterMs) {
    throw new NotAuthenticated('Session expired, please login again');
  }
}

export function assertAuthenticationUserAuthMetadata(
  user: UserAuthMetadata
): asserts user is AuthenticationUserAuthMetadata {
  assertUserAccessEnabled(user);
  if (credentialGeneration(user.credential_generation) === null) {
    throw new NotAuthenticated('Authentication credential metadata unavailable');
  }
}

export function authCredentialGenerationClaim(
  user: AuthenticationUserAuthMetadata
): Record<typeof AUTH_CREDENTIAL_GENERATION_CLAIM, number> {
  // Retain runtime validation at the credential boundary even though callers
  // must now supply the structurally required authentication-user type.
  assertAuthenticationUserAuthMetadata(user);
  return {
    [AUTH_CREDENTIAL_GENERATION_CLAIM]: user.credential_generation,
  };
}

export function authTokenIssuedAtClaim(
  now = Date.now(),
  user?: UserAuthMetadata
): Record<typeof AUTH_TOKEN_ISSUED_AT_MS_CLAIM, number> {
  const validAfterMs = dateToMillis(user?.tokens_valid_after);
  const issuedAtMs = validAfterMs !== null && now <= validAfterMs ? validAfterMs + 1 : now;
  return { [AUTH_TOKEN_ISSUED_AT_MS_CLAIM]: issuedAtMs };
}
