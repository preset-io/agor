/**
 * Normalized data-map shape + the pure index/merge helpers that maintain it.
 *
 * Lives here (rather than in `useAgorData`) so BOTH the zustand store
 * (`agorStore` / `agorRealtimeActions`) and the hook's `fetchData` share the
 * exact same reducers — and so the store can import `EMPTY_MAPS` at module load
 * without an import cycle back through the hook (the hook imports the store).
 * Nothing here touches React or the store; these are reference-preserving
 * immutable updaters (incl. `buildSessionMaps`).
 */
import type {
  Artifact,
  Board,
  BoardComment,
  BoardEntityObject,
  Branch,
  CardType,
  CardWithType,
  GatewayChannel,
  MCPServer,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import { shallowEqualEntity } from '../utils/shallowEqual';

/**
 * All server-backed data maps held in a single state object.
 *
 * Adding a new map here + to `EMPTY_MAPS` is all that's required — resetting
 * the store covers every field automatically.
 */
export type DataMaps = {
  sessionById: Map<string, Session>;
  sessionsByBranch: Map<string, Session[]>;
  boardById: Map<string, Board>;
  boardObjectById: Map<string, BoardEntityObject>;
  boardObjectsByBoardId: Map<string, BoardEntityObject[]>;
  // Global placement lookup. Branch placements are unique because a branch can
  // only have one board-object row at a time.
  boardObjectByBranchId: Map<string, BoardEntityObject>;
  // Global placement lookup. Cards follow the same one-row-per-card service
  // contract as branches; callers needing board-scoped iteration should use
  // boardObjectsByBoardId instead.
  boardObjectByCardId: Map<string, BoardEntityObject>;
  commentById: Map<string, BoardComment>;
  cardById: Map<string, CardWithType>;
  cardTypeById: Map<string, CardType>;
  repoById: Map<string, Repo>;
  branchById: Map<string, Branch>;
  userById: Map<string, User>;
  mcpServerById: Map<string, MCPServer>;
  gatewayChannelById: Map<string, GatewayChannel>;
  artifactById: Map<string, Artifact>;
  sessionMcpServerIds: Map<string, string[]>;
  userAuthenticatedMcpServerIds: Set<string>;
};

export const EMPTY_MAPS: DataMaps = {
  sessionById: new Map(),
  sessionsByBranch: new Map(),
  boardById: new Map(),
  boardObjectById: new Map(),
  boardObjectsByBoardId: new Map(),
  boardObjectByBranchId: new Map(),
  boardObjectByCardId: new Map(),
  commentById: new Map(),
  cardById: new Map(),
  cardTypeById: new Map(),
  repoById: new Map(),
  branchById: new Map(),
  userById: new Map(),
  mcpServerById: new Map(),
  gatewayChannelById: new Map(),
  artifactById: new Map(),
  sessionMcpServerIds: new Map(),
  userAuthenticatedMcpServerIds: new Set(),
};

// The data-map keys, derived once from EMPTY_MAPS. Used by `pickMaps` and the
// store's `applyMaps` to iterate slices generically (and stays in lockstep
// with DataMaps automatically when a new map is added).
export const MAP_KEYS = Object.keys(EMPTY_MAPS) as (keyof DataMaps)[];

/**
 * Project the data-map slices out of a wider state object (the store holds the
 * maps as top-level fields alongside meta + actions). Returns a fresh DataMaps
 * object whose slice references are the store's current ones — so callers can
 * run the existing whole-DataMaps reducers and diff the result per-slice.
 */
export function pickMaps(state: DataMaps): DataMaps {
  const maps = {} as DataMaps;
  for (const key of MAP_KEYS) {
    maps[key] = state[key] as never;
  }
  return maps;
}

// Generic byId-map replacer used by the per-entity `*Patched` handlers below.
// Returns `prev` unchanged when the incoming entity is shallow-equal to what
// we already hold — combined with the wrapper-level no-op short-circuit in
// `setMapSlice`, idempotent server-side patches become true no-ops. The
// per-entity handlers stay responsible for archive / branch-migration /
// cross-map cleanup; this helper only covers the plain "replace one entry"
// case.
export function replaceIfChanged<T extends object>(
  prev: Map<string, T>,
  id: string,
  entity: T
): Map<string, T> {
  const existing = prev.get(id);
  if (existing && shallowEqualEntity(existing, entity)) return prev;
  const next = new Map(prev);
  next.set(id, entity);
  return next;
}

// Build a plain `byId` Map from a fetched list. Used by the background
// (non-gated) fetches whose results land via their own setter rather than the
// single atomic map-apply the essential gate performs.
export function buildById<T>(list: readonly T[], key: keyof T): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of list) {
    map.set(item[key] as unknown as string, item);
  }
  return map;
}

// Group session-MCP relationship rows by session_id.
export function buildSessionMcpMap(
  list: readonly { session_id: string; mcp_server_id: string }[]
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const relationship of list) {
    const ids = map.get(relationship.session_id);
    if (ids) ids.push(relationship.mcp_server_id);
    else map.set(relationship.session_id, [relationship.mcp_server_id]);
  }
  return map;
}

// Derived board-object index set, built once from a fetched list. Shared by
// the essential (board-scoped, first-paint) index build and the background
// full-hydration pass — single source of truth so the two can't diverge.
export function buildBoardObjectMaps(list: readonly BoardEntityObject[]): {
  boardObjectById: Map<string, BoardEntityObject>;
  boardObjectsByBoardId: Map<string, BoardEntityObject[]>;
  boardObjectByBranchId: Map<string, BoardEntityObject>;
  boardObjectByCardId: Map<string, BoardEntityObject>;
} {
  const boardObjectById = new Map<string, BoardEntityObject>();
  const boardObjectsByBoardId = new Map<string, BoardEntityObject[]>();
  const boardObjectByBranchId = new Map<string, BoardEntityObject>();
  const boardObjectByCardId = new Map<string, BoardEntityObject>();
  for (const boardObject of list) {
    boardObjectById.set(boardObject.object_id, boardObject);

    const bucket = boardObjectsByBoardId.get(boardObject.board_id);
    if (bucket) bucket.push(boardObject);
    else boardObjectsByBoardId.set(boardObject.board_id, [boardObject]);

    if (boardObject.branch_id) {
      boardObjectByBranchId.set(boardObject.branch_id, boardObject);
    }
    if (boardObject.card_id) {
      boardObjectByCardId.set(boardObject.card_id, boardObject);
    }
  }
  return { boardObjectById, boardObjectsByBoardId, boardObjectByBranchId, boardObjectByCardId };
}

// Build the session lookups (`sessionById` + branch-bucketed `sessionsByBranch`)
// from a flat session list. Shared by the bounded first-paint build and the
// background full-hydration pass so the two can't diverge. Mirrors the realtime
// handlers: archived sessions stay in `sessionById` (so a direct archived-link
// can open the drawer) but are kept OUT of the branch buckets (so they never
// reappear as branch/board cards). Cross-branch remote-created sessions are
// projected as muted surrogate children under the creating session's branch.
export function buildSessionMaps(sessionsList: readonly Session[]): {
  sessionById: Map<string, Session>;
  sessionsByBranch: Map<string, Session[]>;
} {
  const sessionsById = new Map<string, Session>();
  const sessionsByBranchId = new Map<string, Session[]>();

  for (const session of sessionsList) {
    sessionsById.set(session.session_id, session);
    if (session.archived) continue;
    const branchId = session.branch_id;
    if (!sessionsByBranchId.has(branchId)) sessionsByBranchId.set(branchId, []);
    sessionsByBranchId.get(branchId)!.push(session);
  }

  for (const sourceSession of sessionsList) {
    if (sourceSession.archived) continue;
    for (const relationship of sourceSession.remote_relationships?.as_source ?? []) {
      if (relationship.relationship_type !== 'remote_create') continue;

      const targetSession = sessionsById.get(relationship.target_session_id);
      if (!targetSession) continue;

      const sourceBranchSessions = sessionsByBranchId.get(sourceSession.branch_id) ?? [];
      if (sourceBranchSessions.some((session) => session.session_id === targetSession.session_id)) {
        continue;
      }

      const remoteSurrogate = createRemoteSurrogateSession(
        sourceSession,
        targetSession,
        relationship
      );
      if (!remoteSurrogate) continue;

      sessionsByBranchId.set(sourceSession.branch_id, [...sourceBranchSessions, remoteSurrogate]);
    }
  }

  return { sessionById: sessionsById, sessionsByBranch: sessionsByBranchId };
}

export function removeBoardObjectFromBoardBucket(
  buckets: Map<string, BoardEntityObject[]>,
  boardObject: BoardEntityObject
): Map<string, BoardEntityObject[]> {
  const bucket = buckets.get(boardObject.board_id);
  if (!bucket?.some((item) => item.object_id === boardObject.object_id)) return buckets;

  const next = new Map(buckets);
  const filtered = bucket.filter((item) => item.object_id !== boardObject.object_id);
  if (filtered.length > 0) next.set(boardObject.board_id, filtered);
  else next.delete(boardObject.board_id);
  return next;
}

export function upsertBoardObjectInMaps(
  prev: DataMaps,
  boardObject: BoardEntityObject,
  mode: 'create' | 'patch'
): DataMaps {
  const existing = prev.boardObjectById.get(boardObject.object_id);
  if (mode === 'create' && existing) return prev;
  if (mode === 'patch' && existing && shallowEqualEntity(existing, boardObject)) return prev;

  const boardObjectById = new Map(prev.boardObjectById);
  boardObjectById.set(boardObject.object_id, boardObject);

  let boardObjectsByBoardId = prev.boardObjectsByBoardId;
  if (existing && existing.board_id !== boardObject.board_id) {
    boardObjectsByBoardId = removeBoardObjectFromBoardBucket(boardObjectsByBoardId, existing);
  }

  const bucket = boardObjectsByBoardId.get(boardObject.board_id) ?? [];
  const bucketIndex = bucket.findIndex((item) => item.object_id === boardObject.object_id);
  if (
    bucketIndex === -1 ||
    bucket[bucketIndex] !== boardObject ||
    !shallowEqualEntity(bucket[bucketIndex], boardObject)
  ) {
    const nextBuckets = new Map(boardObjectsByBoardId);
    if (bucketIndex === -1) {
      nextBuckets.set(boardObject.board_id, [...bucket, boardObject]);
    } else {
      const updatedBucket = [...bucket];
      updatedBucket[bucketIndex] = boardObject;
      nextBuckets.set(boardObject.board_id, updatedBucket);
    }
    boardObjectsByBoardId = nextBuckets;
  }

  let boardObjectByBranchId = prev.boardObjectByBranchId;
  if (existing?.branch_id && existing.branch_id !== boardObject.branch_id) {
    boardObjectByBranchId = new Map(boardObjectByBranchId);
    boardObjectByBranchId.delete(existing.branch_id);
  }
  if (boardObject.branch_id) {
    const existingByBranch = boardObjectByBranchId.get(boardObject.branch_id);
    if (!existingByBranch || !shallowEqualEntity(existingByBranch, boardObject)) {
      boardObjectByBranchId =
        boardObjectByBranchId === prev.boardObjectByBranchId
          ? new Map(boardObjectByBranchId)
          : boardObjectByBranchId;
      boardObjectByBranchId.set(boardObject.branch_id, boardObject);
    }
  }

  let boardObjectByCardId = prev.boardObjectByCardId;
  if (existing?.card_id && existing.card_id !== boardObject.card_id) {
    boardObjectByCardId = new Map(boardObjectByCardId);
    boardObjectByCardId.delete(existing.card_id);
  }
  if (boardObject.card_id) {
    const existingByCard = boardObjectByCardId.get(boardObject.card_id);
    if (!existingByCard || !shallowEqualEntity(existingByCard, boardObject)) {
      boardObjectByCardId =
        boardObjectByCardId === prev.boardObjectByCardId
          ? new Map(boardObjectByCardId)
          : boardObjectByCardId;
      boardObjectByCardId.set(boardObject.card_id, boardObject);
    }
  }

  return {
    ...prev,
    boardObjectById,
    boardObjectsByBoardId,
    boardObjectByBranchId,
    boardObjectByCardId,
  };
}

export function removeBoardObjectFromMaps(
  prev: DataMaps,
  boardObject: BoardEntityObject
): DataMaps {
  const existing = prev.boardObjectById.get(boardObject.object_id);
  if (!existing) return prev;

  const boardObjectById = new Map(prev.boardObjectById);
  boardObjectById.delete(existing.object_id);

  let boardObjectByBranchId = prev.boardObjectByBranchId;
  if (
    existing.branch_id &&
    boardObjectByBranchId.get(existing.branch_id)?.object_id === existing.object_id
  ) {
    boardObjectByBranchId = new Map(boardObjectByBranchId);
    boardObjectByBranchId.delete(existing.branch_id);
  }

  let boardObjectByCardId = prev.boardObjectByCardId;
  if (
    existing.card_id &&
    boardObjectByCardId.get(existing.card_id)?.object_id === existing.object_id
  ) {
    boardObjectByCardId = new Map(boardObjectByCardId);
    boardObjectByCardId.delete(existing.card_id);
  }

  return {
    ...prev,
    boardObjectById,
    boardObjectsByBoardId: removeBoardObjectFromBoardBucket(prev.boardObjectsByBoardId, existing),
    boardObjectByBranchId,
    boardObjectByCardId,
  };
}

export function preserveSessionRelationshipFields(session: Session, existing?: Session): Session {
  if (!existing) return session;

  const remoteRelationships = session.remote_relationships ?? existing.remote_relationships;
  const remoteSurrogate = session.remote_surrogate ?? existing.remote_surrogate;

  if (
    remoteRelationships === session.remote_relationships &&
    remoteSurrogate === session.remote_surrogate
  ) {
    return session;
  }

  return {
    ...session,
    ...(remoteRelationships !== undefined && { remote_relationships: remoteRelationships }),
    ...(remoteSurrogate !== undefined && { remote_surrogate: remoteSurrogate }),
  };
}

export function createRemoteSurrogateSession(
  sourceSession: Session,
  targetSession: Session,
  relationship: NonNullable<NonNullable<Session['remote_relationships']>['as_source']>[number]
): Session | null {
  if (relationship.relationship_type !== 'remote_create') return null;
  if (targetSession.archived) return null;
  if (targetSession.branch_id === sourceSession.branch_id) return null;

  return {
    ...targetSession,
    branch_id: sourceSession.branch_id,
    genealogy: {
      ...(targetSession.genealogy ?? {}),
      parent_session_id: sourceSession.session_id,
    },
    remote_surrogate: {
      relationship,
      source_session_id: sourceSession.session_id,
      source_branch_id: sourceSession.branch_id,
      target_branch_id: targetSession.branch_id,
    },
  };
}

export function findSessionInBranchBuckets(
  sessionsByBranchId: Map<string, Session[]>,
  sessionId: string
): Session | undefined {
  for (const bucket of sessionsByBranchId.values()) {
    const session = bucket.find((candidate) => candidate.session_id === sessionId);
    if (session && !session.remote_surrogate) return session;
  }
  return undefined;
}
