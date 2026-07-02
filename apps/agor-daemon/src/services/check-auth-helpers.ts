/**
 * Pure, dependency-free helpers for `check-auth.ts`, split out so they're
 * unit-testable without pulling in its Claude Agent SDK -> OpenTelemetry
 * import graph (which breaks under vitest's ESM resolution).
 */

/**
 * Whether an `AccountInfo` source field (`apiKeySource` / `tokenSource`)
 * indicates a real credential. The Claude Agent SDK signals "no source" with
 * the literal string `'none'` rather than omitting the field, so a plain
 * truthy check false-positives as authenticated.
 */
export function isRealAuthSource(value: string | undefined): boolean {
  return !!value && value.toLowerCase() !== 'none';
}
