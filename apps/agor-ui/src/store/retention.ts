/**
 * Retention: a row stays while some scope or pin
 * (`rowPins.ts`) holds it. Rows leave at natural points only — a partition
 * evicted from the LRU (`boardPartitions.ts`), a pin released, the end of a
 * reconnect resync — never on a timer.
 *
 * An eviction is a `replaceScope` with an empty, complete snapshot over the
 * rows being released: every one of them that no remaining scope's committed
 * membership holds (`otherCommittedMembers`, stale lifetimes included: a
 * disconnect or an authority change must not free rows my scopes still
 * describe) leaves, in one store update with the coverage it drops. Rows
 * outside the released set are never swept.
 *
 * Rows enter by the same rule (`admitHeld`): an on-demand fill or a realtime
 * write inserts a row only when a pin or a scope that is loading or loaded
 * would hold it; any other row is never inserted.
 */
import { applySessionPatchToMaps, type DataMaps, removeBoardObjectFromMaps } from './agorMaps';
import { agorStore } from './agorStore';
import { isLoadLifetimeCurrent } from './loadLifetime';
import { acquirePins, type PinnedIds, pinnedMembers, releasePins } from './rowPins';
import {
  belongs,
  type Coverage,
  type CoverageCollection,
  isUserScopeKey,
  type LoadScope,
  replaceScope,
  type ScopeKey,
  type ScopeRows,
  type WrittenIds,
  withCoverage,
} from './scopeMerge';
import { joinableScopes, otherCommittedMembers, userScopeRunGeneration } from './userScope';

const NOTHING: ScopeRows = {
  branches: [],
  sessions: [],
  boardObjects: [],
  cards: [],
  complete: true,
};
const never = () => false;

type Claims = LoadScope['claims'];

/** Claims of any of `scopes`: a row any one of them claims. */
export function anyOf(scopes: readonly Pick<LoadScope, 'claims'>[]): Claims {
  const claims: Record<string, (row: never, maps: DataMaps) => boolean> = {};
  for (const collection of ['branches', 'sessions', 'boardObjects', 'cards'] as const) {
    const tests = scopes
      .map(
        (scope) => scope.claims[collection] as ((row: never, maps: DataMaps) => boolean) | undefined
      )
      .filter((test) => !!test);
    if (tests.length > 0) claims[collection] = (row, maps) => tests.some((test) => test(row, maps));
  }
  return claims as Claims;
}

const without = (coverage: Coverage, keys: readonly ScopeKey[]) =>
  keys.reduce<Coverage>((next, key) => withCoverage(next, key, null), coverage);

/**
 * Drop `dropKeys`' coverage and remove every row `claims` names that no
 * remaining scope holds, in one store update; a removed session's MCP links
 * and loaded mark follow it (`forgetAbsentSessions`).
 */
export function evictRows(claims: Claims, dropKeys: readonly ScopeKey[] = []): void {
  const state = agorStore.getState();
  const holders = otherCommittedMembers(
    { ...state, coverage: without(state.coverage, dropKeys) },
    undefined,
    { stale: true }
  );
  const before = state.sessionById;
  state.applyMaps(
    (prev) => replaceScope(prev, { claims }, NOTHING, never, holders, { evict: true }),
    (_maps, coverage) => without(coverage, dropKeys)
  );
  const after = agorStore.getState().sessionById;
  if (after !== before) forgetAbsentSessions([...before.keys()].filter((id) => !after.has(id)));
}

/**
 * Release every scope the settled load did not replace, once it has
 * settled: every scope of an earlier lifetime and, while `run` (the user
 * scope run the load started, `userScopeRunGeneration`) is still the current
 * one, every user-scope piece it did not commit — a plain reconnect keeps
 * the lifetime, so only the run tells its pieces apart. Their entries go,
 * with the rows only they held. Until then (disconnected, or while the
 * resync runs) they keep them (`evictRows` counts stale members); a piece
 * the load failed to read is unloaded rather than left complete over rows
 * it no longer holds.
 */
export function releaseStaleScopes(run?: number | null): void {
  const retireUnreplaced = run != null && userScopeRunGeneration() === run;
  const stale = [...agorStore.getState().coverage].filter(
    ([key, entry]) =>
      !isLoadLifetimeCurrent(entry) ||
      (retireUnreplaced && isUserScopeKey(key) && entry.generation !== run)
  );
  if (stale.length === 0) return;
  const member =
    (collection: CoverageCollection) =>
    (id: string): boolean =>
      stale.some(([, entry]) => !!entry.members?.[collection]?.has(id));
  const has = {
    branches: member('branches'),
    sessions: member('sessions'),
    boardObjects: member('boardObjects'),
    cards: member('cards'),
  };
  evictRows(
    {
      branches: (branch) => has.branches(branch.branch_id),
      sessions: (session) => has.sessions(session.session_id),
      boardObjects: (boardObject) => has.boardObjects(boardObject.object_id),
      cards: (card) => has.cards(card.card_id),
    },
    stale.map(([key]) => key)
  );
}

/**
 * Pin `ids` while a view displays them; returns the release function. A
 * release evicts the rows it unpinned that no scope or other pin holds.
 */
export function pinRows(ids: PinnedIds): () => void {
  const pinned = acquirePins(ids);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const unpinned = releasePins(pinned);
    if (unpinned.sessions.size === 0 && unpinned.branches.size === 0) return;
    evictRows({
      sessions: (session) => unpinned.sessions.has(session.session_id),
      branches: (branch) => unpinned.branches.has(branch.branch_id),
    });
    // Links of a pinned session that never loaded (`holdsSession`).
    forgetAbsentSessions(unpinned.sessions);
  };
}

/** Pins a consumer takes as rows arrive, all released together (search results, deep links). */
export interface RowHold {
  readonly released: boolean;
  /** Pin `ids` until `release`; a no-op once released. */
  pin(ids: PinnedIds): void;
  release(): void;
}

export function holdRows(): RowHold {
  const releases: (() => void)[] = [];
  let released = false;
  return {
    get released() {
      return released;
    },
    pin(ids) {
      if (!released) releases.push(pinRows(ids));
    },
    release() {
      if (released) return;
      released = true;
      for (const release of releases) release();
    },
  };
}

/**
 * `next` without the `written` rows that nothing holds after the write: no
 * pin, and no scope loading or loaded under the current lifetime that claims
 * them (`joinableScopes`). That is a row the write inserted, and a present
 * row it moved out of every scope (pass a moved branch's sessions too,
 * `withBranchSessions`). Drop the MCP state of the sessions it removed with
 * `forgetAbsentSessions`.
 */
export function admitHeld(prev: DataMaps, next: DataMaps, written: WrittenIds): DataMaps {
  if (next === prev) return next;
  let scopes: LoadScope[] | null = null;
  const held = (collection: CoverageCollection, id: string) => {
    if (pinnedMembers[collection]?.has(id)) return true;
    scopes ??= joinableScopes(agorStore.getState().coverage);
    return scopes.some((scope) => belongs(scope, collection, id, next));
  };
  const unheld = <T>(collection: CoverageCollection, rows: Map<string, T>) =>
    [...new Set(written[collection] ?? [])].flatMap((id) => {
      const row = rows.get(id);
      return row && !held(collection, id) ? [row] : [];
    });

  let maps = next;
  const branches = unheld('branches', next.branchById);
  if (branches.length > 0) {
    const branchById = new Map(maps.branchById);
    for (const branch of branches) branchById.delete(branch.branch_id);
    maps = { ...maps, branchById };
  }
  for (const session of unheld('sessions', next.sessionById)) {
    maps = applySessionPatchToMaps(maps, { ...session, archived: true });
  }
  for (const boardObject of unheld('boardObjects', next.boardObjectById)) {
    maps = removeBoardObjectFromMaps(maps, boardObject);
  }
  const cards = unheld('cards', next.cardById);
  if (cards.length > 0) {
    const cardById = new Map(maps.cardById);
    for (const card of cards) cardById.delete(card.card_id);
    maps = { ...maps, cardById };
  }
  return maps;
}

/** Drop the MCP links and loaded marks of `sessionIds` the store no longer holds. */
export function forgetAbsentSessions(sessionIds: Iterable<string>): void {
  const { sessionById, forgetSessionMcp } = agorStore.getState();
  const absent = [...new Set(sessionIds)].filter((id) => !sessionById.has(id));
  if (absent.length > 0) forgetSessionMcp(absent);
}

/**
 * Whether something holds session `id`, so its MCP links may enter: it is in
 * the store (admitted, `admitHeld`), or a pin holds it.
 */
export function holdsSession(id: string): boolean {
  return agorStore.getState().sessionById.has(id) || !!pinnedMembers.sessions?.has(id);
}
