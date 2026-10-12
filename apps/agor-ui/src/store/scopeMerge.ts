/**
 * Load scopes, their coverage, and the two reducers that apply a scope's
 * snapshot (`context/concepts/user-first-scoped-hydration.md`).
 *
 * A scope is a set of rows one load is authoritative for: one board's
 * partition or a piece of the caller's user scope. Both reducers are fenced
 * per id: a row that a live event wrote since the load began keeps its live
 * value, or its absence.
 *
 * - `applyEntityFill` (`agorMaps.ts`) inserts absent rows and never
 *   overwrites a present one (I2). It cannot remove anything, so it is not
 *   reconciliation; on-demand reads use it.
 * - `replaceScope` reconciles: it also overwrites present rows with the
 *   snapshot, and removes rows the scope claims that the snapshot no longer
 *   returns (deleted, moved out, or no longer visible) — only when the read
 *   was complete, and only when no other scope's committed membership holds them.
 *   Every board partition load and every reconnect applies with it.
 *
 * Each scope's state is one `ScopeCoverage` entry in the store's `coverage`
 * map: its status, lifetime and generation, and, once loaded, its committed
 * membership and whether its read was complete. Membership starts as the ids
 * the read returned, corrected for rows realtime wrote while it was in flight
 * (`settledMembers`), and then follows realtime (`liveMembership`): a row
 * written live joins every current loaded scope that claims it and leaves the
 * ones that no longer do. A scope's own replace finds candidates with a
 * predicate on the CURRENT row (`LoadScope`); another scope keeps a row only
 * through its membership, so a loading or failed scope keeps nothing alive,
 * and two scopes whose reads both omit a row converge instead of each
 * deferring to the other's predicate.
 */
import { isTeammate } from '@agor/core/types';
import type { Board, BoardEntityObject, Branch, CardWithType, Session } from '@agor-live/client';
import { boardIdForSession } from '../utils/boardIdForSession';
import { shallowEqualEntity } from '../utils/shallowEqual';
import {
  applySessionPatchToMaps,
  buildSessionMaps,
  type DataMaps,
  isOnRemovedBranch,
  type PartitionTouched,
  removeBoardObjectFromMaps,
  upsertBoardObjectInMaps,
} from './agorMaps';
import type { LoadLifetime } from './loadLifetime';

/** Rows of one scope's snapshot; an omitted collection is not part of the load. */
export interface ScopeRows {
  branches?: readonly Branch[];
  sessions?: readonly Session[];
  /** `null`: not read (a global viewer cannot read board objects). */
  boardObjects?: readonly BoardEntityObject[] | null;
  cards?: readonly CardWithType[];
  /** The scope's full board record; replaces the lean row unless touched. */
  board?: Board | null;
  /**
   * `false` for a capped read: it lists only part of the scope, so a row it
   * omits may still exist and is never removed.
   */
  complete?: boolean;
}

export const BOARD_SCOPE_PREFIX = 'board:';
export const boardScopeKey = (boardId: string): `board:${string}` =>
  `${BOARD_SCOPE_PREFIX}${boardId}`;

/** Coverage keys of the user scope's pieces (`userScope.ts`). */
export const USER_SCOPE_KEYS = {
  /** All of my active sessions (U1, or a complete gated page). */
  sessions: 'user:sessions',
  /** My branches (U2). */
  branches: 'user:branches',
  /** Teammate branches I can view (U3, capped). */
  teammates: 'user:teammates',
  /** Branches my sessions and comment threads reference (U5, by id). */
  references: 'user:references',
} as const;

export type UserScopeKey = (typeof USER_SCOPE_KEYS)[keyof typeof USER_SCOPE_KEYS];
/** Whether coverage key `key` is a piece of the user scope. */
export const isUserScopeKey = (key: string): key is UserScopeKey =>
  (Object.values(USER_SCOPE_KEYS) as string[]).includes(key);
/** A coverage key: one board's partition or one piece of the user scope. */
export type ScopeKey = `board:${string}` | UserScopeKey;

/** Which current store rows a scope claims. A missing predicate claims none. */
export interface LoadScope {
  key: ScopeKey;
  claims: {
    branches?: (branch: Branch, maps: DataMaps) => boolean;
    sessions?: (session: Session, maps: DataMaps) => boolean;
    boardObjects?: (boardObject: BoardEntityObject, maps: DataMaps) => boolean;
    cards?: (card: CardWithType, maps: DataMaps) => boolean;
  };
}

export type CoverageCollection = keyof LoadScope['claims'];

/** Row ids per collection that belong to a loaded scope. */
export type CoverageMembers = Readonly<Partial<Record<CoverageCollection, ReadonlySet<string>>>>;
/** What a replace asks of another scope's members: only `has`. */
export type MemberLookup = Readonly<
  Partial<Record<CoverageCollection, Pick<ReadonlySet<string>, 'has'>>>
>;

/**
 * One scope's coverage: where its load is, under which lifetime and
 * generation, and its membership. Presence of rows never implies completeness
 * (I1); a `loaded` entry does. An entry from another lifetime is stale: it may
 * still drive readiness flags, but its members keep no row alive.
 */
export interface ScopeCoverage extends LoadLifetime {
  status: 'loading' | 'loaded' | 'error';
  /**
   * The load that owns the entry, kept from `loading` to `loaded` (or
   * `error`): only that load may settle or release it, and only a new load
   * (an unload and reload) changes it. Membership updates keep it.
   */
  generation: number;
  /** The caller a user-scope piece belongs to (its claims compare `created_by`). */
  userId?: string;
  error?: string;
  /** Rows that belong to the loaded scope, per collection read (references derive theirs). */
  members?: CoverageMembers;
  /** `false`: the committed read was capped, so `members` is part of the scope. */
  complete?: boolean;
}

/** The store's coverage map, by scope key. */
export type Coverage = ReadonlyMap<ScopeKey, ScopeCoverage>;
/** A coverage change published in the same store update as a maps change. */
export type CoverageUpdate = (maps: DataMaps, coverage: Coverage) => Coverage;

/** `coverage` with `key` set (or cleared, with `null`); itself when nothing changes. */
export function withCoverage(
  coverage: Coverage,
  key: ScopeKey,
  entry: ScopeCoverage | null
): Coverage {
  const existing = coverage.get(key);
  if (entry === null ? !existing : existing && shallowEqualEntity(existing, entry)) return coverage;
  const next = new Map(coverage);
  if (entry === null) next.delete(key);
  else next.set(key, entry);
  return next;
}

/** `coverage` without its board partitions, but the `keep` boards'; itself when nothing changes. */
export function withoutBoardPartitions(coverage: Coverage, keep: readonly string[] = []): Coverage {
  const kept = new Set<ScopeKey>(keep.map(boardScopeKey));
  let next: Map<ScopeKey, ScopeCoverage> | null = null;
  for (const key of coverage.keys()) {
    if (!key.startsWith(BOARD_SCOPE_PREFIX) || kept.has(key)) continue;
    next ??= new Map(coverage);
    next.delete(key);
  }
  return next ?? coverage;
}

/**
 * The ids of a read's rows that belong to its scope: branches and sessions
 * that are not archived (archived rows are never listed), and every board
 * object and card — archived cards included: a card archives in place and
 * stays on its board.
 */
export function scopeMembers(rows: ScopeRows): CoverageMembers {
  const live = <T extends { archived?: boolean }>(list: readonly T[], id: (row: T) => string) =>
    new Set(list.filter((row) => !row.archived).map(id));
  return {
    ...(rows.branches ? { branches: live(rows.branches, (b) => b.branch_id) } : {}),
    ...(rows.sessions ? { sessions: live(rows.sessions, (r) => r.session_id) } : {}),
    ...(rows.boardObjects
      ? { boardObjects: new Set(rows.boardObjects.map((o) => o.object_id)) }
      : {}),
    ...(rows.cards ? { cards: new Set(rows.cards.map((c) => c.card_id)) } : {}),
  };
}

/** One board's partition: its branches, sessions, board objects and cards. */
export function boardPartitionScope(boardId: string): LoadScope {
  return {
    key: boardScopeKey(boardId),
    claims: {
      branches: (branch) => branch.board_id === boardId,
      sessions: (session, maps) => boardIdForSession(session, maps.branchById) === boardId,
      boardObjects: (boardObject) => boardObject.board_id === boardId,
      cards: (card) => card.board_id === boardId,
    },
  };
}

/**
 * One piece of the caller's user scope (`userScope.ts`), with its own narrow
 * claim: replacing my branches never reconciles teammates. The referenced
 * branches claim nothing here: their membership is derived from the current
 * references (`referenceMembers` in `userScope.ts`), however their rows loaded.
 */
export function userScopePiece(key: UserScopeKey, userId: string): LoadScope {
  switch (key) {
    case USER_SCOPE_KEYS.sessions:
      return {
        key,
        claims: { sessions: (session) => !session.archived && session.created_by === userId },
      };
    case USER_SCOPE_KEYS.branches:
      return { key, claims: { branches: (branch) => branch.created_by === userId } };
    case USER_SCOPE_KEYS.teammates:
      return { key, claims: { branches: (branch) => isTeammate(branch) } };
    case USER_SCOPE_KEYS.references:
      return { key, claims: {} };
  }
}

/** The scope a coverage entry describes; `null` for a user piece without its caller. */
function scopeOf(key: ScopeKey, entry: ScopeCoverage): LoadScope | null {
  if (key.startsWith(BOARD_SCOPE_PREFIX)) {
    return boardPartitionScope(key.slice(BOARD_SCOPE_PREFIX.length));
  }
  return entry.userId ? userScopePiece(key as UserScopeKey, entry.userId) : null;
}

const ROWS: Record<CoverageCollection, (maps: DataMaps) => ReadonlyMap<string, object>> = {
  branches: (maps) => maps.branchById,
  sessions: (maps) => maps.sessionById,
  boardObjects: (maps) => maps.boardObjectById,
  cards: (maps) => maps.cardById,
};

/**
 * Row `id` of `collection` when it is present and could belong to a scope:
 * an archived branch or session never does, an archived card can (see
 * `scopeMembers`).
 */
function liveRow(collection: CoverageCollection, id: string, maps: DataMaps): object | undefined {
  const row = ROWS[collection](maps).get(id) as { archived?: boolean } | undefined;
  return row && (collection === 'cards' || !row.archived) ? row : undefined;
}

/** Whether row `id` of `collection` is live (`liveRow`) and `scope` claims it. */
export function belongs(
  scope: LoadScope,
  collection: CoverageCollection,
  id: string,
  maps: DataMaps
): boolean {
  const row = liveRow(collection, id, maps);
  const claim = scope.claims[collection] as ((row: object, maps: DataMaps) => boolean) | undefined;
  return !!row && !!claim?.(row, maps);
}

/** Ids per collection that live events wrote (or that a read raced). */
export type WrittenIds = Partial<Record<CoverageCollection, Iterable<string>>>;

/** `written` plus the sessions on its branches now: a session's board is its branch's. */
export function withBranchSessions(written: WrittenIds, maps: DataMaps): WrittenIds {
  const sessions = new Set(written.sessions ?? []);
  for (const branchId of written.branches ?? []) {
    for (const session of maps.sessionsByBranch.get(branchId) ?? [])
      sessions.add(session.session_id);
  }
  return sessions.size > 0 ? { ...written, sessions } : written;
}

/**
 * The membership a read commits: the ids it returned (`scopeMembers`) that
 * realtime left alone, kept while still present — the server's filter is the
 * authority for them — and the rows realtime wrote while it was in flight
 * (`raced`, from `touchedIdsSince`, with the sessions of raced branches), kept
 * exactly when they are present and the scope claims them now. `maps` is the
 * store after the read applied.
 */
export function settledMembers(
  scope: LoadScope,
  rows: ScopeRows,
  maps: DataMaps,
  raced: (collection: CoverageCollection) => Iterable<string>
): CoverageMembers {
  const members: Partial<Record<CoverageCollection, Set<string>>> = {};
  const racedSessions = withBranchSessions({ branches: raced('branches') }, maps).sessions ?? [];
  for (const [collection, ids] of Object.entries(scopeMembers(rows)) as [
    CoverageCollection,
    ReadonlySet<string>,
  ][]) {
    const touched = new Set(raced(collection));
    if (collection === 'sessions') for (const id of racedSessions) touched.add(id);
    const kept = new Set<string>();
    for (const id of ids) if (!touched.has(id) && liveRow(collection, id, maps)) kept.add(id);
    for (const id of touched) if (belongs(scope, collection, id, maps)) kept.add(id);
    members[collection] = kept;
  }
  return members;
}

/**
 * Keep membership in step with a live write: every `written` row joins each
 * current (`isCurrent`), loaded scope that claims it and leaves each one that
 * no longer does (deleted, archived, moved out). A write that moves a branch
 * passes its sessions too (`withBranchSessions`). A value-only patch
 * changes nothing and returns `coverage` itself; so does a write no loaded
 * scope tracks.
 */
export function liveMembership(
  coverage: Coverage,
  maps: DataMaps,
  written: WrittenIds,
  isCurrent: (entry: ScopeCoverage) => boolean
): Coverage {
  const ids = Object.entries(written) as [CoverageCollection, Iterable<string>][];
  if (ids.length === 0) return coverage;
  let next: Map<ScopeKey, ScopeCoverage> | null = null;
  for (const [key, entry] of coverage) {
    if (entry.status !== 'loaded' || !entry.members || !isCurrent(entry)) continue;
    const scope = scopeOf(key, entry);
    if (!scope) continue;
    let members: Partial<Record<CoverageCollection, ReadonlySet<string>>> | null = null;
    for (const [collection, rowIds] of ids) {
      const current: ReadonlySet<string> | undefined = (members ?? entry.members)[collection];
      if (!current) continue;
      let updated: Set<string> | null = null;
      for (const id of rowIds) {
        const member = belongs(scope, collection, id, maps);
        if (member === (updated ?? current).has(id)) continue;
        updated ??= new Set(current);
        if (member) updated.add(id);
        else updated.delete(id);
      }
      if (updated) members = { ...(members ?? entry.members), [collection]: updated };
    }
    if (!members) continue;
    next ??= new Map(coverage);
    next.set(key, { ...entry, members });
  }
  return next ?? coverage;
}

/**
 * Whether a snapshot row equals the store row. The daemon reserializes nested
 * fields (positions, configs, board objects), so a shallow compare would
 * rewrite — and re-render — every row on each replace; compare the JSON when
 * the shallow check fails.
 */
function sameRow(a: object | undefined, b: object): boolean {
  if (!a) return false;
  return shallowEqualEntity(a, b) || JSON.stringify(a) === JSON.stringify(b);
}

/** Above this many session upserts and removals, rebuild the session maps once. */
const INCREMENTAL_SESSION_LIMIT = 64;

/**
 * Reconciling apply of `scope`'s snapshot, for every collection present in
 * `rows`:
 *
 * - every untouched snapshot row is inserted or overwrites the store row;
 * - when the read was complete, every untouched store row the scope claims
 *   but the snapshot omits is removed, unless one of `others` (the committed
 *   memberships of the other loaded scopes) holds it;
 * - touched rows keep their live value or absence (a session also when its
 *   branch was touched), and snapshot rows on a branch removed live during
 *   the load are skipped.
 *
 * An archived session (a deep link's target, filled for display) is outside
 * every list, so a list's replace keeps it; a retention eviction (`evict`,
 * `retention.ts`) removes it like any other row nothing holds.
 *
 * Returns `prev` unchanged when nothing changed. Never bumps revisions.
 */
export function replaceScope(
  prev: DataMaps,
  scope: Pick<LoadScope, 'claims'>,
  rows: ScopeRows,
  touched: PartitionTouched,
  others: readonly MemberLookup[],
  { evict = false }: { evict?: boolean } = {}
): DataMaps {
  let maps = prev;
  const claims: LoadScope['claims'] = rows.complete === false ? {} : scope.claims;
  const claimedElsewhere = (collection: CoverageCollection, id: string) =>
    others.some((other) => other[collection]?.has(id));

  if (rows.branches) {
    const returned = new Map<string, Branch>();
    for (const branch of rows.branches) {
      if (!branch.archived) returned.set(branch.branch_id, branch);
    }
    let branchById = maps.branchById;
    const write = () => {
      if (branchById === maps.branchById) branchById = new Map(branchById);
      return branchById;
    };
    for (const [id, branch] of returned) {
      if (touched('branches', id)) continue;
      if (!sameRow(branchById.get(id), branch)) write().set(id, branch);
    }
    const claim = claims.branches;
    if (claim) {
      for (const [id, branch] of maps.branchById) {
        if (returned.has(id) || touched('branches', id) || !claim(branch, maps)) continue;
        if (claimedElsewhere('branches', id)) continue;
        write().delete(id);
      }
    }
    if (branchById !== maps.branchById) maps = { ...maps, branchById };
  }

  if (rows.sessions) {
    const returned = new Map<string, Session>();
    for (const session of rows.sessions) {
      if (!session.archived) returned.set(session.session_id, session);
    }
    const upserts: Session[] = [];
    for (const [id, session] of returned) {
      if (touched('sessions', id) || isOnRemovedBranch(maps, session.branch_id, touched)) continue;
      if (!sameRow(maps.sessionById.get(id), session)) upserts.push(session);
    }
    const removals: Session[] = [];
    const claim = claims.sessions;
    if (claim) {
      for (const [id, session] of maps.sessionById) {
        // A session whose branch was written live (moved onto the scope) is
        // judged by that write, not by a read that predates it.
        if ((session.archived && !evict) || returned.has(id) || touched('sessions', id)) continue;
        if (session.branch_id && touched('branches', session.branch_id)) continue;
        if (!claim(session, maps) || claimedElsewhere('sessions', id)) continue;
        removals.push(session);
      }
    }
    if (upserts.length + removals.length > INCREMENTAL_SESSION_LIMIT) {
      const removed = new Set(removals.map((session) => session.session_id));
      const next = new Map(maps.sessionById);
      for (const id of removed) next.delete(id);
      for (const session of upserts) next.set(session.session_id, session);
      const rebuilt = buildSessionMaps([...next.values()], {
        sessionById: maps.sessionById,
        sessionsByBranch: maps.sessionsByBranch,
      });
      maps = { ...maps, ...rebuilt };
    } else {
      // Archiving removes a session from `sessionById` and every bucket.
      for (const session of removals) {
        maps = applySessionPatchToMaps(maps, { ...session, archived: true });
      }
      // Remote-create sources after their targets, as in `applyEntityFill`.
      upserts.sort(
        (a, b) =>
          Number(!!a.remote_relationships?.as_source?.length) -
          Number(!!b.remote_relationships?.as_source?.length)
      );
      for (const session of upserts) maps = applySessionPatchToMaps(maps, session);
    }
  }

  if (rows.boardObjects) {
    const returned = new Map<string, BoardEntityObject>();
    for (const boardObject of rows.boardObjects) returned.set(boardObject.object_id, boardObject);
    for (const [id, boardObject] of returned) {
      if (touched('boardObjects', id) || isOnRemovedBranch(maps, boardObject.branch_id, touched))
        continue;
      if (sameRow(maps.boardObjectById.get(id), boardObject)) continue;
      maps = upsertBoardObjectInMaps(maps, boardObject, 'patch');
    }
    const claim = claims.boardObjects;
    if (claim) {
      for (const [id, boardObject] of maps.boardObjectById) {
        if (returned.has(id) || touched('boardObjects', id) || !claim(boardObject, maps)) continue;
        if (claimedElsewhere('boardObjects', id)) continue;
        maps = removeBoardObjectFromMaps(maps, boardObject);
      }
    }
  }

  if (rows.cards) {
    const returned = new Map<string, CardWithType>();
    for (const card of rows.cards) returned.set(card.card_id, card);
    let cardById = maps.cardById;
    const write = () => {
      if (cardById === maps.cardById) cardById = new Map(cardById);
      return cardById;
    };
    for (const [id, card] of returned) {
      if (touched('cards', id)) continue;
      if (!sameRow(cardById.get(id), card)) write().set(id, card);
    }
    const claim = claims.cards;
    if (claim) {
      for (const [id, card] of maps.cardById) {
        if (returned.has(id) || touched('cards', id) || !claim(card, maps)) continue;
        if (claimedElsewhere('cards', id)) continue;
        write().delete(id);
      }
    }
    if (cardById !== maps.cardById) maps = { ...maps, cardById };
  }

  const board = rows.board;
  if (board && !touched('boards', board.board_id)) {
    if (!sameRow(maps.boardById.get(board.board_id), board)) {
      maps = { ...maps, boardById: new Map(maps.boardById).set(board.board_id, board) };
    }
  }

  return maps;
}

/** One board's partition as fetched by `loadBoardPartition`. */
export interface BoardPartitionSnapshot extends ScopeRows {
  boardId: string;
  branches: readonly Branch[];
  sessions: readonly Session[];
  boardObjects: readonly BoardEntityObject[] | null;
  cards: readonly CardWithType[];
  board: Board | null;
  /** Explicit: the reducer and the coverage commit read the same answer. */
  complete: boolean;
}
