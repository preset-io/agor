/**
 * JWT decode utilities (no signature verification).
 *
 * We read our own tokens to learn when WE think they expire — never to assert
 * trust. Opaque tokens (Slack `xoxe.…`, Notion `secret_…`, etc.) fail the
 * three-segment shape check and short-circuit cleanly with `null`.
 *
 * Browser-safe: uses `Buffer` when available (Node), `atob` otherwise (browser).
 *
 * Consumers:
 *   - `packages/core/src/tools/mcp/oauth-token-expiry.ts` (cascade step 5)
 *   - `packages/client/src/jwt.ts` (re-export → `@agor-live/client/jwt`),
 *     which is what the UI's `apps/agor-ui/src/utils/jwtExpiry.ts` uses.
 *     One implementation, no drift between server and browser.
 */

/**
 * Return the `exp` claim (Unix seconds) from a JWT, or null on any failure.
 * Never throws. Does not verify the signature.
 */
export function readJwtExpClaim(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payloadSegment = parts[1];
  if (!payloadSegment) return null;

  try {
    const decoded = base64UrlDecodeToString(payloadSegment);
    const parsed = JSON.parse(decoded) as unknown;
    if (parsed && typeof parsed === 'object' && 'exp' in parsed) {
      const exp = (parsed as { exp: unknown }).exp;
      if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) return exp;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Convenience wrapper: returns the `exp` claim in epoch milliseconds, or null.
 * Matches the API the UI's `jwtExpiry.ts` previously exposed.
 */
export function decodeJwtExpMs(token: string): number | null {
  const expSec = readJwtExpClaim(token);
  return expSec === null ? null : expSec * 1000;
}

/**
 * Milliseconds remaining until the JWT's `exp`, or null if no decodable `exp`.
 * Negative values mean already-expired.
 */
export function msUntilExpiry(token: string, now: number = Date.now()): number | null {
  const expMs = decodeJwtExpMs(token);
  return expMs === null ? null : expMs - now;
}

/**
 * True when the token expires within `bufferMs`, OR when no `exp` could be
 * decoded (treat-as-expiring is the safe default for the UI's pre-emptive
 * refresh path).
 */
export function isExpiringSoon(token: string, bufferMs: number): boolean {
  const ms = msUntilExpiry(token);
  if (ms === null) return true;
  return ms <= bufferMs;
}

/**
 * Decode a base64url string (no padding, `-`/`_` instead of `+`/`/`) to UTF-8.
 * Works in both Node and browser runtimes.
 */
function base64UrlDecodeToString(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf8');
  }
  // biome-ignore lint/suspicious/noExplicitAny: atob may not be typed in this env
  const bin = (globalThis as any).atob(padded) as string;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
