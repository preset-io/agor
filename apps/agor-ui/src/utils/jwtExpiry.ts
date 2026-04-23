/**
 * Client-side JWT expiry helpers.
 *
 * We decode (NOT verify) the payload purely to learn when the token will be
 * rejected by the server, so we can schedule a proactive refresh. The server
 * is still the only party that validates signatures.
 */

/**
 * Extract the `exp` claim from a JWT, in milliseconds since epoch.
 *
 * Returns null if the token is malformed or has no numeric `exp`.
 */
export function decodeJwtExpMs(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // base64url → base64
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // atob is available in all browser targets we support
    const json = atob(base64);
    const payload = JSON.parse(json) as { exp?: unknown };

    if (typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/**
 * Milliseconds until the token expires. Negative if already expired.
 * Null if we cannot decode the token.
 */
export function msUntilExpiry(token: string, now: number = Date.now()): number | null {
  const expMs = decodeJwtExpMs(token);
  return expMs === null ? null : expMs - now;
}

/**
 * True if the token is expired or will expire within `bufferMs`.
 *
 * If the token cannot be decoded, returns `true` so callers refresh
 * defensively rather than ride a bad token.
 */
export function isExpiringSoon(token: string, bufferMs: number): boolean {
  const ms = msUntilExpiry(token);
  if (ms === null) return true;
  return ms <= bufferMs;
}
