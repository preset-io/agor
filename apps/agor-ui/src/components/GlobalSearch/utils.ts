/**
 * Shared utilities for the global-search feature. Kept feature-local so the
 * navbar hooks don't reach into a generic utilities bucket for one-call helpers.
 */

/**
 * Coerce a timestamp (string ISO or Date) to a millisecond number for sorting.
 * Returns 0 for missing/invalid values so they sort to the end of a DESC list.
 */
export function tsValue(ts: string | Date | undefined | null): number {
  if (!ts) return 0;
  if (ts instanceof Date) return ts.getTime();
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Generic timestamp-DESC sort comparator. Each entity has its own timestamp
 * field name and type (Session uses `last_updated`, Board has `last_updated`,
 * MCPServer uses Date objects), so callers pass an accessor.
 */
export function byTimestamp<T>(
  getTs: (item: T) => string | Date | undefined | null
): (a: T, b: T) => number {
  return (a, b) => tsValue(getTs(b)) - tsValue(getTs(a));
}
