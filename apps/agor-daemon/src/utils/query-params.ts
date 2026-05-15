/**
 * Feathers query-param normalizers.
 *
 * Feathers delivers query params as strings; these helpers coerce them to
 * the expected type and fall back to a sensible default when the input is
 * missing, non-finite, or out of range. (They *do not* throw — invalid
 * input is treated as "use the default", which matches how the
 * sessions/worktrees services already handled this before the helper
 * was lifted.)
 */

/**
 * Parse the `last_message_truncation_length` query param.
 *
 * Used by `services/sessions.ts` and `services/worktrees.ts` to cap the
 * length of the embedded last-message payload returned with each row.
 * Bounds: [50, 10000]; default: 500.
 */
export function parseLastMessageTruncationLength(value: unknown): number {
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
