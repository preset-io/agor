/**
 * Pins: rows a mounted view displays, kept while it does even when no scope
 * holds them — the open session and its branch, route targets, rows read on
 * demand (`useEnsureRows`, search results, genealogy). Ref-counted by id: a
 * row stays pinned until every view that pinned it released it. Every replace
 * and eviction treats the pins as one more holder (`otherCommittedMembers`);
 * `retention.ts` evicts the rows a release leaves unheld.
 */
import type { MemberLookup } from './scopeMerge';

export type PinCollection = 'sessions' | 'branches';
/** Ids per collection to pin. */
export type PinnedIds = Partial<Record<PinCollection, Iterable<string>>>;

const counts: Record<PinCollection, Map<string, number>> = {
  sessions: new Map(),
  branches: new Map(),
};

/** The pinned ids, as a holder for `replaceScope`. */
export const pinnedMembers: MemberLookup = counts;

/** Pin `ids`; returns their unique ids per collection (pass them to `releasePins`). */
export function acquirePins(ids: PinnedIds): Record<PinCollection, Set<string>> {
  const pinned = { sessions: new Set(ids.sessions ?? []), branches: new Set(ids.branches ?? []) };
  for (const collection of ['sessions', 'branches'] as const) {
    for (const id of pinned[collection]) {
      counts[collection].set(id, (counts[collection].get(id) ?? 0) + 1);
    }
  }
  return pinned;
}

/** Release pins taken by `acquirePins`; returns the ids no pin holds any more. */
export function releasePins(
  pinned: Record<PinCollection, ReadonlySet<string>>
): Record<PinCollection, Set<string>> {
  const unpinned = { sessions: new Set<string>(), branches: new Set<string>() };
  for (const collection of ['sessions', 'branches'] as const) {
    for (const id of pinned[collection]) {
      const count = (counts[collection].get(id) ?? 0) - 1;
      if (count > 0) {
        counts[collection].set(id, count);
      } else {
        counts[collection].delete(id);
        unpinned[collection].add(id);
      }
    }
  }
  return unpinned;
}
