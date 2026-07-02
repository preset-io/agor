/**
 * Pure, dependency-free helpers for `check-auth.ts`. Kept in a separate
 * module (rather than inline) so they're unit-testable without pulling in
 * `check-auth.ts`'s full import graph (Claude Agent SDK -> OpenTelemetry),
 * which breaks under vitest's ESM resolution when imported directly.
 */

/**
 * Whether an `AccountInfo` source field (`apiKeySource` / `tokenSource`)
 * indicates a real credential. The Claude Agent SDK signals "no source"
 * with the literal string `'none'` rather than omitting the field
 * (confirmed live against a genuinely credential-less container:
 * `accountInfo()` resolved with `tokenSource: 'none'`), so a plain truthy
 * check on the raw string false-positives as authenticated.
 */
export function isRealAuthSource(value: string | undefined): boolean {
  return !!value && value.toLowerCase() !== 'none';
}
