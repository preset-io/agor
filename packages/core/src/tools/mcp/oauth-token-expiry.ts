/**
 * MCP OAuth Token Expiry Resolution
 *
 * Replaces the previous `tokenResponse.expires_in ?? 3600` defaulting that
 * lived in two persist sites with different policies. See
 * `context/explorations/mcp-oauth-token-lifecycle.md` (Phase 3.5) for the
 * full rationale.
 *
 * The resolver walks a deterministic precedence cascade and returns the
 * first hit, or `null` ("unknown") if no source can supply a TTL. `null` is
 * a first-class state — callers persist it as `expires_at = NULL` and the
 * UI surfaces "expires in: unknown". Until the retry-on-401 transport shim
 * lands (tracked as a follow-up — see Phase 5 of the research doc), the
 * unknown case is operator-driven: the user can force a refresh from the
 * MCP pill if the token stops working.
 *
 * Cascade order:
 *   1. tokenResponse.expires_in        (RFC 6749 §5.1 — canonical)
 *   2. tokenResponse.expires_at        (absolute Unix seconds; some Auth0 / Spotify configs)
 *   3. tokenResponse.exp               (top-level JWT-style absolute claim)
 *   4. tokenResponse.ext_expires_in    (Microsoft / Azure AD extended expiry)
 *   5. JWT-decode access_token.exp     (only if token has JWT shape)
 *   6. (future) per-server config hint default_access_ttl_seconds
 *   7. null                            ("unknown")
 *
 * The cascade returns an absolute `Date` (or null). Storage takes that Date
 * verbatim — keeping OAuth-spec semantics out of the repository layer.
 *
 * Notes:
 * - We never speculate a hardcoded global default. The 1h default was the bug.
 * - Same resolver runs at both initial-auth persist and refresh persist —
 *   no asymmetry between the two sites.
 * - JWT decode is shape-gated and signature-free (see `@agor/core/utils/jwt`).
 */

import { readJwtExpClaim } from '../../utils/jwt';

/** Minimal token-response shape we need from any provider. */
export interface OAuthTokenResponseLike {
  access_token?: string;
  expires_in?: number;
  /** Absolute Unix-seconds expiry — alternative form some providers use. */
  expires_at?: number;
  /** Top-level JWT-style absolute expiry claim — rare but observed. */
  exp?: number;
  /** Microsoft / Azure AD extended expiry during outages. */
  ext_expires_in?: number;
  // Other fields (refresh_token, scope, etc.) are not relevant here.
}

/** Result of the cascade. `expiresAt === null` means "unknown — store NULL". */
export interface ResolvedTokenExpiry {
  /** Absolute expiry as a `Date`, or `null` if no source could supply one. */
  expiresAt: Date | null;
  /**
   * Which step of the cascade produced the answer. Useful for logging /
   * debugging when a provider behaves unexpectedly. `'unknown'` for null.
   */
  source:
    | 'expires_in'
    | 'expires_at'
    | 'exp'
    | 'ext_expires_in'
    | 'jwt_exp'
    | 'config_hint'
    | 'unknown';
}

/**
 * Sanity bound for absolute timestamps. Anything more than 10 years in the
 * future is treated as a units mistake (e.g., a provider returning
 * milliseconds where we expect seconds, which would resolve to year ~+58k).
 *
 * Relative TTLs (`expires_in`) are NOT bounded here — providers like
 * Atlassian advertise multi-hour-but-finite TTLs and some long-lived JWTs
 * legitimately span months. Only the absolute-timestamp branches use this.
 */
const ABSOLUTE_TIMESTAMP_SANITY_HORIZON_SEC = 10 * 365 * 24 * 60 * 60;

/**
 * Walk the precedence cascade and return the first usable expiry.
 *
 * @param tokenResponse - parsed JSON body from the OAuth token endpoint
 * @param accessToken - the access_token (only used for the JWT-decode step)
 * @param now - current epoch ms; injectable for tests
 */
export function resolveTokenExpiry(
  tokenResponse: OAuthTokenResponseLike,
  accessToken?: string,
  now: number = Date.now()
): ResolvedTokenExpiry {
  // Step 1 — RFC 6749 §5.1 standard
  if (isPositiveFiniteNumber(tokenResponse.expires_in)) {
    return {
      expiresAt: new Date(now + Math.floor(tokenResponse.expires_in) * 1000),
      source: 'expires_in',
    };
  }

  // Step 2 — absolute Unix-seconds variant
  const fromExpiresAt = absoluteSecondsToDate(tokenResponse.expires_at, now);
  if (fromExpiresAt !== null) {
    return { expiresAt: fromExpiresAt, source: 'expires_at' };
  }

  // Step 3 — top-level JWT-style claim leaked into the response
  const fromExp = absoluteSecondsToDate(tokenResponse.exp, now);
  if (fromExp !== null) {
    return { expiresAt: fromExp, source: 'exp' };
  }

  // Step 4 — Microsoft / Azure AD extended expiry
  if (isPositiveFiniteNumber(tokenResponse.ext_expires_in)) {
    return {
      expiresAt: new Date(now + Math.floor(tokenResponse.ext_expires_in) * 1000),
      source: 'ext_expires_in',
    };
  }

  // Step 5 — JWT-decode the access token if it has the JWT shape
  if (accessToken) {
    const jwtExp = readJwtExpClaim(accessToken);
    const fromJwt = absoluteSecondsToDate(jwtExp, now);
    if (fromJwt !== null) {
      return { expiresAt: fromJwt, source: 'jwt_exp' };
    }
  }

  // Step 6 (config_hint) is reserved for the per-server lifecycle config
  // (option G in the research doc). Not yet plumbed through to this resolver.

  return { expiresAt: null, source: 'unknown' };
}

/**
 * True for finite numbers strictly greater than zero. Rejects NaN, ±Infinity,
 * 0, negatives, strings, etc. — anything we wouldn't want to use as a TTL.
 */
function isPositiveFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Convert an absolute Unix-seconds timestamp to a `Date`. Returns null for
 * missing values, non-numbers, anything in the past, and anything beyond the
 * sanity horizon (likely a units mistake — see ABSOLUTE_TIMESTAMP_SANITY_HORIZON_SEC).
 */
function absoluteSecondsToDate(absSec: unknown, nowMs: number): Date | null {
  if (!isPositiveFiniteNumber(absSec)) return null;
  const nowSec = nowMs / 1000;
  const deltaSec = absSec - nowSec;
  if (deltaSec <= 0) return null;
  if (deltaSec > ABSOLUTE_TIMESTAMP_SANITY_HORIZON_SEC) return null;
  return new Date(Math.floor(absSec) * 1000);
}
