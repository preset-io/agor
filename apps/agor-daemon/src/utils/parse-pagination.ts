/**
 * Parse and validate last_message_truncation_length parameter.
 *
 * Feathers delivers query params as strings, so we parse to a number and
 * clamp to the [MIN, MAX] window. Out-of-range / non-finite / missing
 * inputs all fall back to DEFAULT.
 */
export function parseTruncationLength(value: unknown): number {
  const DEFAULT = 500;
  const MIN = 50;
  const MAX = 10000;

  if (value === undefined || value === null) {
    return DEFAULT;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed < MIN || parsed > MAX) {
    return DEFAULT;
  }

  return Math.floor(parsed);
}
