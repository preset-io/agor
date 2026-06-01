/**
 * Shared utilities for the global-search feature. Kept feature-local so the
 * navbar hooks don't reach into a generic utilities bucket for one-call helpers.
 */

import {
  type ResultsByType,
  SECTION_ORDER,
  type SearchCounts,
  type SearchResultItem,
} from './types';

/**
 * Coerce a timestamp (string ISO or Date) to a millisecond number for sorting.
 * File-private — callers should use `byTimestamp()` instead of comparing
 * directly.
 */
function tsValue(ts: string | Date | undefined | null): number {
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

/** True when any section in a `ResultsByType` has at least one row. */
export function hasAnyEntries(results: ResultsByType): boolean {
  return SECTION_ORDER.some((t) => results[t].length > 0);
}

/** Flatten sectioned results into a single array in `SECTION_ORDER` order —
 * the canonical sequence used by keyboard navigation. The cast widens each
 * per-section narrow variant back to the union — TS otherwise tries to unify
 * the heterogeneous `flatMap` callback returns against the first variant. */
export function flattenResults(results: ResultsByType): SearchResultItem[] {
  return SECTION_ORDER.flatMap((t) => results[t] as SearchResultItem[]);
}

/** Total match count across all entity types. */
export function sumCounts(counts: SearchCounts): number {
  return SECTION_ORDER.reduce((sum, t) => sum + counts[t], 0);
}

/**
 * Cumulative section offsets for keyboard cursor index alignment — each entry
 * is the count of rows that come before that section in `SECTION_ORDER`. Used
 * by the dropdown renderer to translate a `(section, indexInSection)` pair to
 * the flat index that matches `flattenResults`.
 */
export function sectionOffsets(results: ResultsByType): Map<SearchResultItem['type'], number> {
  const offsets = new Map<SearchResultItem['type'], number>();
  let running = 0;
  for (const type of SECTION_ORDER) {
    offsets.set(type, running);
    running += results[type].length;
  }
  return offsets;
}
