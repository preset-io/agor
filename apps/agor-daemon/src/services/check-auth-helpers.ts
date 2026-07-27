/**
 * Pure helpers split out of `check-auth.ts` so they're unit-testable without
 * its Claude SDK import graph (which breaks under vitest's ESM resolution).
 */

/**
 * Whether an `AccountInfo` source field indicates a real credential. The SDK
 * signals "no source" with the literal `'none'`, so a truthy check false-positives.
 */
export function isRealAuthSource(value: string | undefined): boolean {
  return !!value && value.toLowerCase() !== 'none';
}
