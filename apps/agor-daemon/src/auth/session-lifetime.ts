import { NotAuthenticated } from '@agor/core/feathers';
import { getAuthTokenIssuedAtMs, type UserAuthTokenPayload } from './token-invalidation.js';

/** Original sign-in time (ms). Every token of one browser session carries the same value. */
export const AUTH_SESSION_STARTED_AT_MS_CLAIM = 'auth_session_started_ms';
/** External launch subject the session was signed in with; drives refresh revalidation. */
export const AUTH_LAUNCH_SUBJECT_CLAIM = 'auth_launch_sub';
/** Last time (ms) the launch issuer confirmed this session's membership. */
export const AUTH_REVALIDATED_AT_MS_CLAIM = 'auth_revalidated_ms';

/** Empty for sessions with no launch subject: those have no absolute lifetime. */
export interface BrowserSessionClaims {
  [AUTH_SESSION_STARTED_AT_MS_CLAIM]?: number;
  [AUTH_LAUNCH_SUBJECT_CLAIM]?: string;
  [AUTH_REVALIDATED_AT_MS_CLAIM]?: number;
}

/**
 * Original sign-in time of the session a verified token belongs to. Tokens
 * issued before the claim existed fall back to their own issue time, so an
 * upgrade grants at most one more full session lifetime.
 */
export function readSessionStartedAtMs(payload: UserAuthTokenPayload | undefined): number | null {
  const value = payload?.[AUTH_SESSION_STARTED_AT_MS_CLAIM];
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (value !== undefined) return null;
  return getAuthTokenIssuedAtMs(payload);
}

export function readRevalidatedAtMs(payload: UserAuthTokenPayload | undefined): number | null {
  const value = payload?.[AUTH_REVALIDATED_AT_MS_CLAIM];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function readLaunchSubject(payload: UserAuthTokenPayload | undefined): string | undefined {
  const value = payload?.[AUTH_LAUNCH_SUBJECT_CLAIM];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Deadline (epoch seconds) after which no token of this session may be valid. */
export function sessionDeadlineSeconds(startedAtMs: number, maxLifetimeSeconds: number): number {
  return Math.floor(startedAtMs / 1000) + maxLifetimeSeconds;
}

export interface BrowserSession {
  claims: BrowserSessionClaims;
  /** Deadline (epoch seconds) for a launched session; absent for every other session. */
  notAfterSeconds?: number;
}

/**
 * Session claims carried by a token re-issued from a verified browser token.
 * Only a launched session (one with a launch subject, from its token or from a
 * refresh-time revalidation) has an absolute lifetime; it fails closed when its
 * start is unreadable or past that lifetime. Other sessions carry no claims.
 */
export function continueBrowserSession(
  payload: UserAuthTokenPayload | undefined,
  maxLifetimeSeconds: number,
  nowMs = Date.now(),
  options: { launchSubject?: string } = {}
): BrowserSession {
  const launchSubject = options.launchSubject ?? readLaunchSubject(payload);
  if (!launchSubject) return { claims: {} };
  const startedAtMs = readSessionStartedAtMs(payload);
  if (startedAtMs === null) {
    throw new NotAuthenticated('Session expired, please login again');
  }
  const notAfterSeconds = sessionDeadlineSeconds(startedAtMs, maxLifetimeSeconds);
  if (Math.floor(nowMs / 1000) >= notAfterSeconds) {
    throw new NotAuthenticated('Session expired, please login again');
  }
  const revalidatedAtMs = readRevalidatedAtMs(payload);
  return {
    claims: {
      [AUTH_SESSION_STARTED_AT_MS_CLAIM]: startedAtMs,
      [AUTH_LAUNCH_SUBJECT_CLAIM]: launchSubject,
      ...(revalidatedAtMs ? { [AUTH_REVALIDATED_AT_MS_CLAIM]: revalidatedAtMs } : {}),
    },
    notAfterSeconds,
  };
}

/** Session claims and deadline for a brand-new sign-in; only a launch starts a capped session. */
export function startBrowserSession(
  maxLifetimeSeconds: number,
  options: { launchSubject?: string; nowMs?: number } = {}
): BrowserSession {
  if (!options.launchSubject) return { claims: {} };
  const startedAtMs = options.nowMs ?? Date.now();
  return {
    claims: {
      [AUTH_SESSION_STARTED_AT_MS_CLAIM]: startedAtMs,
      [AUTH_LAUNCH_SUBJECT_CLAIM]: options.launchSubject,
      [AUTH_REVALIDATED_AT_MS_CLAIM]: startedAtMs,
    },
    notAfterSeconds: sessionDeadlineSeconds(startedAtMs, maxLifetimeSeconds),
  };
}
