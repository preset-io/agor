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
 * UI surfaces "expires in: unknown". The retry-on-401 transport shim
 * (tracked as a follow-up) is the safety net for the unknown case.
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
 * Notes:
 * - We never speculate a hardcoded global default. The 1h default was the bug.
 * - Same resolver runs at both initial-auth persist and refresh persist —
 *   no asymmetry between the two sites.
 * - JWT decode is shape-gated and signature-free: we are reading our own
 *   token to learn when WE think it expires, not validating it. Any decode
 *   failure quietly falls through to the next step.
 */

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

/** Result of the cascade. `seconds === null` means "unknown — store NULL". */
export interface ResolvedTokenExpiry {
  /** Seconds-from-now until expiry, or `null` if no source could supply one. */
  seconds: number | null;
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
    return { seconds: Math.floor(tokenResponse.expires_in), source: 'expires_in' };
  }

  // Step 2 — absolute Unix-seconds variant
  const fromExpiresAt = absoluteSecondsToRelative(tokenResponse.expires_at, now);
  if (fromExpiresAt !== null) {
    return { seconds: fromExpiresAt, source: 'expires_at' };
  }

  // Step 3 — top-level JWT-style claim leaked into the response
  const fromExp = absoluteSecondsToRelative(tokenResponse.exp, now);
  if (fromExp !== null) {
    return { seconds: fromExp, source: 'exp' };
  }

  // Step 4 — Microsoft / Azure AD extended expiry
  if (isPositiveFiniteNumber(tokenResponse.ext_expires_in)) {
    return { seconds: Math.floor(tokenResponse.ext_expires_in), source: 'ext_expires_in' };
  }

  // Step 5 — JWT-decode the access token if it has the JWT shape
  if (accessToken) {
    const jwtExp = readJwtExpClaim(accessToken);
    const fromJwt = absoluteSecondsToRelative(jwtExp, now);
    if (fromJwt !== null) {
      return { seconds: fromJwt, source: 'jwt_exp' };
    }
  }

  // Step 6 (config_hint) is reserved for the per-server lifecycle config
  // (option G in the research doc). Not yet plumbed through to this resolver.

  return { seconds: null, source: 'unknown' };
}

/**
 * True for finite numbers strictly greater than zero. Rejects NaN, ±Infinity,
 * 0, negatives, strings, etc. — anything we wouldn't want to use as a TTL.
 */
function isPositiveFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Convert an absolute Unix-seconds timestamp to a positive seconds-from-now
 * delta. Returns null for missing values, non-numbers, and any timestamp
 * already in the past (which would yield a non-positive TTL).
 */
function absoluteSecondsToRelative(absSec: unknown, nowMs: number): number | null {
  if (!isPositiveFiniteNumber(absSec)) return null;
  const deltaSec = Math.floor(absSec - nowMs / 1000);
  return deltaSec > 0 ? deltaSec : null;
}

/**
 * Best-effort JWT decode: returns the `exp` claim (Unix seconds) if the input
 * has the three-segment JWT shape AND the payload base64url-decodes to JSON
 * containing a numeric `exp`. Returns null on any failure — never throws.
 *
 * No signature verification: we are reading our own token to learn when WE
 * think it expires, not asserting trust. Opaque tokens (Slack `xoxe.`,
 * Notion `secret_…`, etc.) fail the shape check and short-circuit cleanly.
 */
function readJwtExpClaim(token: string): number | null {
  // JWT shape: header.payload.signature — three segments, all base64url.
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payloadSegment = parts[1];
  if (!payloadSegment) return null;

  try {
    const decoded = base64UrlDecodeToString(payloadSegment);
    const parsed = JSON.parse(decoded) as unknown;
    if (parsed && typeof parsed === 'object' && 'exp' in parsed) {
      const exp = (parsed as { exp: unknown }).exp;
      if (isPositiveFiniteNumber(exp)) return exp;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode a base64url string (no padding, `-`/`_` instead of `+`/`/`) to UTF-8.
 * Works in both Node and browser-ish runtimes — we use Buffer where available
 * and fall back to atob otherwise.
 */
function base64UrlDecodeToString(input: string): string {
  // Convert base64url → base64 and pad to a multiple of 4.
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf8');
  }
  // Browser fallback. atob returns a "binary string"; convert to UTF-8.
  // biome-ignore lint/suspicious/noExplicitAny: atob may not be typed in this env
  const bin = (globalThis as any).atob(padded) as string;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
