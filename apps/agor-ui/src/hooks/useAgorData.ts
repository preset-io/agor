// @ts-nocheck - Complex WebSocket event handling with dynamic types
/**
 * React hook for fetching and subscribing to Agor data
 *
 * Manages sessions, tasks, boards with real-time WebSocket updates
 */

import type {
  AgorClient,
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
import { ENTITY_PATH_SEGMENTS, findByShortIdPrefix, PAGINATION } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createInitialLoadDebugTimer, isInitialLoadDebugEnabled } from '../utils/initialLoadDebug';
import { shallowEqualEntity } from '../utils/shallowEqual';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';
import {
  resolveBoardFromUrlPure,
  resolveBranchFromShortIdPure,
  resolveSessionFromShortIdPure,
} from '../utils/urlResolution';

// Canonical list of initial-load items tracked by the loading checklist —
// the ESSENTIAL set the first-paint gate blocks on. Internal only; consumers
// receive the derived `initialLoadItems` array (each entry carries
// label/done/count) rather than the raw key list.
//
// The first paint only needs what's required to render the canvas (branch
// cards, their sessions, cards, comments, zones). Collections that aren't
// needed to paint — mcp-servers, session-mcp-servers, gateway-channels,
// artifacts, and the oauth-status probe — are fetched in the BACKGROUND
// (see `fetchData`) and intentionally absent here so the gate never waits on
// them. Their realtime subscriptions are still attached immediately in the
// subscribe effect, so live updates land even before their fetch resolves.
const INITIAL_LOAD_ITEMS = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'boards', label: 'Boards' },
  { key: 'board-objects', label: 'Board objects' },
  { key: 'board-comments', label: 'Board comments' },
  { key: 'branches', label: 'Branches' },
  { key: 'repos', label: 'Repos' },
  { key: 'users', label: 'Users' },
  { key: 'cards', label: 'Cards' },
  { key: 'card-types', label: 'Card types' },
] as const;

export type InitialLoadItemKey = (typeof INITIAL_LOAD_ITEMS)[number]['key'];

// Skip-apply-on-race background hydration retry schedule. A hydration applies
// its full-set snapshot ONLY if no live write to the target collection(s)
// raced the fetch (proven via the per-collection `liveRevisionsRef` counters);
// if one did, the snapshot is DISCARDED and refetched from a fresh revision
// baseline — never overlaid/reconciled.
//
// It retries UNTIL it lands a quiet window, and NEVER gives up: skipping the
// apply forever would leave Home empty/incomplete indefinitely on a busy
// workspace, because live subscriptions deliver only CHANGES, not a backfill of
// existing rows (board switching doesn't refetch, and a reconnect may never
// fire). The first few retries are immediate (the race window is ~one fetch RTT,
// so a single transient race converges instantly), then capped exponential
// backoff lets a sustained live-write burst settle without busy-looping. Each
// retry RE-snapshots the revision and RE-fetches; a racy snapshot is never
// force-applied. Per-collection quiet windows are short, so this converges fast
// (branches almost immediately; sessions once their write churn quiets).
//
// Delays PRECEDE the attempt they guard (the delay for attempt N runs before
// fetch N, not after it). Loops are cancelled — not abandoned mid-flight — via
// the per-collection generation tokens (`hydrationGenerationRef`): a newer
// hydration (reconnect) or an unmount/reset supersedes older loops so they stop
// retrying and never apply a stale snapshot or leak a timer.
const HYDRATION_IMMEDIATE_RETRIES = 4;
const HYDRATION_BACKOFF_BASE_MS = 200;
const HYDRATION_BACKOFF_CAP_MS = 5000;

// Hydrated collections that the background hydration replaces wholesale. Each
// has its own live-write revision counter (`liveRevisionsRef`) so a write to
// one collection never blocks another's hydration from applying.
type HydratedCollection =
  | 'sessions'
  | 'branches'
  | 'boardObjects'
  | 'cards'
  | 'comments'
  | 'mcpServers'
  | 'sessionMcp'
  | 'gatewayChannels'
  | 'artifacts'
  | 'oauth';

// First-paint bound for the global (non-board-scoped) sessions slice. Covers
// Home's "My Sessions" + "Team activity" feeds (both show only recent items)
// and seeds enough of `sessionById` to resolve `/s/<id>` deep links. The FULL
// session set is background-hydrated a beat later (see `fetchData`), so
// genealogy / GlobalSearch / per-board counts converge without blocking the
// gate. Sessions are the unbounded-with-activity collection, so this is the
// single most important cap for first-paint latency on a busy workspace.
const RECENT_SESSIONS_LIMIT = 50;

// One row in the loading checklist. `count` is captured atomically with
// `done` when each tracked fetch resolves — readers never see a green row
// with a stale 0.
export interface InitialLoadItem {
  key: InitialLoadItemKey;
  label: string;
  done: boolean;
  count: number;
}

export type InitialLoadingStage = 'idle' | 'fetching' | 'indexing';

/**
 * All server-backed data maps held in a single state object.
 *
 * Adding a new map here + to EMPTY_MAPS is all that's required —
 * `setMaps(EMPTY_MAPS)` in the reset effect covers every field automatically.
 */
type DataMaps = {
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

const EMPTY_MAPS: DataMaps = {
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

interface UseAgorDataResult extends DataMaps {
  initialLoadItems: InitialLoadItem[];
  initialLoadComplete: boolean;
  loadingStage: InitialLoadingStage;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

// Generic byId-map replacer used by the per-entity `*Patched` handlers below.
// Returns `prev` unchanged when the incoming entity is shallow-equal to what
// we already hold — combined with the wrapper-level no-op short-circuit in
// `setMapSlice`, idempotent server-side patches become true no-ops. The
// per-entity handlers stay responsible for archive / branch-migration /
// cross-map cleanup; this helper only covers the plain "replace one entry"
// case.
function replaceIfChanged<T extends object>(
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
// single atomic setMaps the essential gate performs.
function buildById<T>(list: readonly T[], key: keyof T): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of list) {
    map.set(item[key] as unknown as string, item);
  }
  return map;
}

// Group session-MCP relationship rows by session_id.
function buildSessionMcpMap(
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
function buildBoardObjectMaps(list: readonly BoardEntityObject[]): {
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
function buildSessionMaps(sessionsList: readonly Session[]): {
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

// Parse the leading entity segment out of the current pathname, e.g.
// `/ui/b/my-board/` → { kind: 'board', token: 'my-board' }. The regex is
// built from ENTITY_PATH_SEGMENTS so it stays in lockstep with the route
// table and tolerates the optional `/ui` basename. Returns null for Home (`/`)
// or any non-entity path.
const ENTITY_PATH_RE = new RegExp(
  `/(${ENTITY_PATH_SEGMENTS.board}|${ENTITY_PATH_SEGMENTS.session}|${ENTITY_PATH_SEGMENTS.branch}|${ENTITY_PATH_SEGMENTS.artifact})/([^/]+)`
);
type ParsedEntityPath = { kind: 'board' | 'session' | 'branch' | 'artifact'; token: string } | null;
function parseEntityPath(pathname: string): ParsedEntityPath {
  const match = pathname.match(ENTITY_PATH_RE);
  if (!match) return null;
  const [, segment, token] = match;
  const kind =
    segment === ENTITY_PATH_SEGMENTS.board
      ? 'board'
      : segment === ENTITY_PATH_SEGMENTS.session
        ? 'session'
        : segment === ENTITY_PATH_SEGMENTS.branch
          ? 'branch'
          : 'artifact';
  return { kind, token };
}

// Resolve the board the app will ACTUALLY display on first paint from the
// current URL, reusing the same slug/short-id resolvers `useUrlState` uses.
// First-paint scoping MUST target this board (never the stored one) so the
// displayed board renders fully. Returns null → caller falls back to a GLOBAL
// (unscoped) first paint, which is always correct:
//   - Home (`/`) or any non-entity path: no board shown.
//   - `/a/<artifact>/`: artifacts aren't in the gated light batch (they load
//     in the background), so the board can't be resolved synchronously here.
//   - Unresolvable / ambiguous short id or a board_id we can't chain to.
function resolveDisplayedBoardId(
  pathname: string,
  boardById: Map<string, { board_id: string; slug?: string }>,
  branchById: Map<string, { branch_id: string; board_id?: string | null }>,
  sessionById: Map<
    string,
    { session_id: string; branch_id?: string; branch_board_id?: string | null }
  >
): string | null {
  const parsed = parseEntityPath(pathname);
  if (!parsed) return null;

  switch (parsed.kind) {
    case 'board':
      return resolveBoardFromUrlPure(parsed.token, boardById);
    case 'session': {
      const sessionId = resolveSessionFromShortIdPure(parsed.token, sessionById);
      if (!sessionId) return null;
      const session = sessionById.get(sessionId);
      if (!session) return null;
      // Prefer the board id carried on the session itself (`branch_board_id`,
      // populated from the branch join server-side). First-paint only holds a
      // bounded `branchById`, so the session's branch may not be present yet —
      // but the session row always knows its board. Fall back to the branch
      // lookup for older payloads that predate the field.
      if (session.branch_board_id) return session.branch_board_id;
      const branchId = session.branch_id;
      return branchId ? (branchById.get(branchId)?.board_id ?? null) : null;
    }
    case 'branch': {
      const branchId = resolveBranchFromShortIdPure(parsed.token, branchById);
      return branchId ? (branchById.get(branchId)?.board_id ?? null) : null;
    }
    default:
      return null;
  }
}

function removeBoardObjectFromBoardBucket(
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

function upsertBoardObjectInMaps(
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

function removeBoardObjectFromMaps(prev: DataMaps, boardObject: BoardEntityObject): DataMaps {
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

function hasIdMatchingPrefix<T>(
  prefix: string,
  entries: Iterable<T>,
  getId: (entry: T) => string
): boolean {
  return (
    findByShortIdPrefix(
      prefix,
      Array.from(entries, (entry) => ({ id: getId(entry) }))
    ).length > 0
  );
}

/**
 * Fetch and subscribe to Agor data from daemon
 *
 * @param client - Agor client instance
 * @param options - Optional configuration
 * @param options.enabled - Whether to enable data fetching (default: true). Set to false to skip
 *                          all data fetching (useful when user needs to change password first).
 * @param options.directSessionId - Optional session short/full ID from a direct URL. If the
 *                                  active-list query omits it because it is archived, fetch it by ID.
 * @returns Sessions, boards, loading state, and refetch function
 */

function preserveSessionRelationshipFields(session: Session, existing?: Session): Session {
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

function createRemoteSurrogateSession(
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

function findSessionInBranchBuckets(
  sessionsByBranchId: Map<string, Session[]>,
  sessionId: string
): Session | undefined {
  for (const bucket of sessionsByBranchId.values()) {
    const session = bucket.find((candidate) => candidate.session_id === sessionId);
    if (session && !session.remote_surrogate) return session;
  }
  return undefined;
}

export function useAgorData(
  client: AgorClient | null,
  options?: { enabled?: boolean; directSessionId?: string | null }
): UseAgorDataResult {
  const enabled = options?.enabled ?? true;
  const directSessionId = options?.directSessionId ?? null;
  // Single state for all server-backed maps — reset is setMaps(EMPTY_MAPS), one call, can't miss a field.
  const [maps, setMaps] = useState<DataMaps>(EMPTY_MAPS);

  // Per-field setter factory. Returns a setter with the same functional-update
  // API as `useState`, with a no-op short-circuit: when the inner update
  // returns the same reference for its slice, we preserve the outer `maps`
  // reference too. Without this, `{ ...m, key: same }` would always allocate
  // a fresh `maps` and force every `useAppLiveData()` / `useAppRepoData()`
  // consumer to re-render on socket events the handler decided to discard.
  const setMapSlice =
    <K extends keyof DataMaps>(key: K) =>
    (value: DataMaps[K] | ((prev: DataMaps[K]) => DataMaps[K])) =>
      setMaps((prev) => {
        const next =
          typeof value === 'function'
            ? (value as (p: DataMaps[K]) => DataMaps[K])(prev[key])
            : value;
        return Object.is(next, prev[key]) ? prev : { ...prev, [key]: next };
      });
  const setSessionById = setMapSlice('sessionById');
  const setSessionsByBranch = setMapSlice('sessionsByBranch');
  const setBoardById = setMapSlice('boardById');
  const setCommentById = setMapSlice('commentById');
  const setCardById = setMapSlice('cardById');
  const setCardTypeById = setMapSlice('cardTypeById');
  const setRepoById = setMapSlice('repoById');
  const setBranchById = setMapSlice('branchById');
  const setUserById = setMapSlice('userById');
  const setMcpServerById = setMapSlice('mcpServerById');
  const setGatewayChannelById = setMapSlice('gatewayChannelById');
  const setArtifactById = setMapSlice('artifactById');
  const setSessionMcpServerIds = setMapSlice('sessionMcpServerIds');
  const setUserAuthenticatedMcpServerIds = setMapSlice('userAuthenticatedMcpServerIds');
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState<InitialLoadingStage>('idle');
  const [error, setError] = useState<string | null>(null);
  // Per-item counts captured at fetch-resolution time. Presence in this
  // record means the item is "done"; the value is the size of the fetched
  // list. Done flag and count flip atomically so a row never shows a green
  // ✓ next to a stale 0 (the byId maps below are only populated after the
  // full Promise.all resolves).
  const [itemCounts, setItemCounts] = useState<Partial<Record<InitialLoadItemKey, number>>>({});

  // Track if we've done initial fetch. The initial fetch happens once on mount;
  // socket reconnects after that re-trigger fetchData() to recover any events
  // that fired while disconnected (Feathers real-time events are fire-and-forget
  // — there's no replay log, so a reconnect with no re-fetch leaves the byId
  // maps stale until manual page refresh).
  const [hasInitiallyFetched, setHasInitiallyFetched] = useState(false);

  // Single-flight guard for reconnect-triggered refetches. Prevents stampedes
  // when the socket flaps (e.g. waking from sleep on a flaky network) — the
  // around-hook on the socket client already single-flights the underlying
  // auth refresh, but we also don't want to issue 14 parallel service calls
  // multiple times in a row.
  const refetchInflightRef = useRef(false);

  // Tracks whether the most recent silent refetch failed. Set by the silent
  // catch branch in `fetchData`, cleared on success. Read by the
  // TOKENS_REFRESHED_EVENT listener below so a token replacement that lands
  // AFTER a failed reconnect refetch (auth race during socket re-auth) gets to
  // retry — without this, the byId maps would stay stale until the next
  // physical reconnect or page refresh. We use a ref rather than state since
  // we only consume it in event handlers, never in render.
  const lastSilentFetchFailedRef = useRef(false);

  // Per-collection live-write revision counters — the core of the
  // skip-apply-on-race background hydration. EVERY realtime handler that
  // mutates one of these collection Maps bumps the matching counter
  // (created / patched / removed, INCLUDING cascade removes such as branch
  // eviction dropping its sessions, the deep-link-healing effect, and
  // reconnect-driven writes). A background hydration snapshots the counters for
  // the collections it replaces, fetches the full set, then applies the
  // snapshot WHOLESALE only if those counters are unchanged when the fetch
  // resolves — proving no live write raced. If any raced, the snapshot is
  // discarded and refetched (never overlaid/reconciled). This makes a wholesale
  // apply provably unable to clobber a live write OR resurrect a removed entity:
  // a remove would have bumped the counter, so no apply happens. A ref (not
  // state): only touched by async fetch code + event handlers, never in render.
  const liveRevisionsRef = useRef<Record<HydratedCollection, number>>({
    sessions: 0,
    branches: 0,
    boardObjects: 0,
    cards: 0,
    comments: 0,
    mcpServers: 0,
    sessionMcp: 0,
    gatewayChannels: 0,
    artifacts: 0,
    oauth: 0,
  });
  // Stable bump helper (identity never changes — only mutates the ref) so it's
  // safe to reference from the subscribe effect's handlers without churning deps.
  const bumpRevision = useCallback((collection: HydratedCollection) => {
    liveRevisionsRef.current[collection] += 1;
  }, []);

  // Per-collection hydration generation tokens. Each `runHydration` call bumps
  // the generation for the collection(s) it owns and captures it; its retry loop
  // stops (without applying a snapshot or scheduling another timer) the moment a
  // newer hydration supersedes it (a reconnect-triggered refetch), the component
  // unmounts, or a logout reset fires — all of which bump these counters. This
  // is CANCELLATION, not race reconciliation: clobber-safety still comes entirely
  // from the quiet-window check against `liveRevisionsRef`.
  const hydrationGenerationRef = useRef<Record<HydratedCollection, number>>({
    sessions: 0,
    branches: 0,
    boardObjects: 0,
    cards: 0,
    comments: 0,
    mcpServers: 0,
    sessionMcp: 0,
    gatewayChannels: 0,
    artifacts: 0,
    oauth: 0,
  });

  // Fetch all data
  //
  // `silent: true` is used by background refetches (e.g. socket reconnect) that
  // must not flip the global `loading` / `error` state — those are wired to the
  // fullscreen "Connecting to daemon..." spinner and "Failed to load data"
  // alert in App.tsx, which would be wildly disruptive if a transient
  // reconnect-time 401 (auth race with the re-auth handler in useAgorClient)
  // bubbled up. Silent failures are logged for observability; the UI continues
  // to render whatever byId state was last successfully fetched, and the next
  // reconnect or token replacement gets another shot.
  const fetchData = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!client || !enabled) {
        return;
      }

      const debugTimer =
        !silent && isInitialLoadDebugEnabled()
          ? createInitialLoadDebugTimer(INITIAL_LOAD_ITEMS)
          : null;
      let debugFinishStatus: 'success' | 'error' | null = null;
      let debugFinishError: unknown;

      try {
        if (!silent) {
          setLoading(true);
          setLoadingStage('fetching');
          debugTimer?.markStage('fetching');
          setError(null);
          setItemCounts({});
        }

        // Marks a tracked item complete (and captures its count from the
        // resolved list length) when its promise resolves. No-ops on
        // silent (reconnect) refetches so initial-load progress isn't mutated.
        const track = <T extends ReadonlyArray<unknown>>(
          key: InitialLoadItemKey,
          p: Promise<T>
        ): Promise<T> => {
          const timedPromise = debugTimer?.track(key, p) ?? p;
          return timedPromise.then((r) => {
            if (!silent) setItemCounts((prev) => ({ ...prev, [key]: r.length }));
            return r;
          });
        };

        // Run a BACKGROUND (non-gated) hydration with skip-apply-on-race. The
        // fetched full-set snapshot is applied WHOLESALE only if no live write
        // to any of `collections` raced the fetch — proven by snapshotting each
        // collection's revision counter before the fetch and re-checking after.
        // If a write raced, the (potentially stale) snapshot is DISCARDED and
        // refetched from a fresh baseline; we NEVER overlay or reconcile a racy
        // snapshot. It retries until it lands a quiet window — a few immediate
        // retries then capped exponential backoff — and never gives up (skipping
        // forever could leave Home empty/incomplete indefinitely; live events
        // only deliver changes, not backfill). The loop is cancelled — not
        // abandoned — on supersession (reconnect), unmount, or logout reset.
        const runHydration = async <T>(
          label: string,
          collections: readonly HydratedCollection[],
          fetchFn: () => Promise<T>,
          apply: (result: T) => void
        ): Promise<void> => {
          // Supersede any older loop for these collections and capture our
          // generation token. The loop bails the instant a newer hydration
          // (reconnect), an unmount, or a logout reset bumps the generation — so
          // it never applies a stale snapshot or schedules another timer after
          // it's been cancelled.
          const myGeneration = collections.map((c) => (hydrationGenerationRef.current[c] += 1));
          const isCurrent = () =>
            collections.every((c, i) => hydrationGenerationRef.current[c] === myGeneration[i]);
          // Delay PRECEDING attempt N: the first HYDRATION_IMMEDIATE_RETRIES
          // attempts fire back-to-back (delay 0) so a single transient race
          // converges instantly; after that, capped exponential backoff lets a
          // sustained write burst settle.
          const delayBeforeAttempt = (attempt: number) =>
            attempt < HYDRATION_IMMEDIATE_RETRIES
              ? 0
              : Math.min(
                  HYDRATION_BACKOFF_BASE_MS * 2 ** (attempt - HYDRATION_IMMEDIATE_RETRIES),
                  HYDRATION_BACKOFF_CAP_MS
                );

          // Retry until a quiet-window apply SUCCEEDS (or the loop is cancelled).
          // We never force-apply a racy snapshot — we just keep re-snapshotting
          // and re-fetching until no live write races a fetch.
          for (let attempt = 0; ; attempt++) {
            const delayMs = delayBeforeAttempt(attempt);
            if (delayMs > 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
              if (!isCurrent()) return; // superseded while waiting
            }
            const before = collections.map((c) => liveRevisionsRef.current[c]);
            let result: T;
            try {
              result = await fetchFn();
            } catch (err) {
              console.warn(`[useAgorData] background ${label} fetch failed:`, err);
              if (!isCurrent()) return; // superseded while fetching
              // A failed fetch leaves the collection un-hydrated; retrying (with
              // backoff) is exactly what keeps Home from staying empty forever.
              continue;
            }
            if (!isCurrent()) return; // superseded while fetching
            const raced = collections.some((c, i) => liveRevisionsRef.current[c] !== before[i]);
            if (!raced) {
              apply(result);
              return;
            }
            // A live write to one of these collections raced the fetch — discard
            // this snapshot and retry from a fresh revision baseline (the next
            // iteration's delay precedes its fetch).
          }
        };

        // ── Background (non-gated) fetches ──────────────────────────────
        // These collections are NOT needed to paint the canvas, so they must
        // never block the first-paint gate. Fire-and-forget: each populates its
        // own map slice on resolve. Their realtime subscriptions are attached in
        // the subscribe effect BEFORE this fetch runs, so live events land even
        // while these fetches are in flight — and `runHydration` only applies a
        // snapshot when no live write to that collection raced (else it refetches
        // a fresh one). We deliberately do NOT `track()` them — they're absent
        // from INITIAL_LOAD_ITEMS, so the loading checklist / `initialLoadComplete`
        // gate ignores them. We apply through the stable `setMaps` (not the
        // per-render setMapSlice setters, which would destabilize this
        // useCallback's deps and re-fire the subscribe effect).
        void runHydration(
          'mcp-servers',
          ['mcpServers'],
          () =>
            client.service('mcp-servers').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          (list) =>
            setMaps((prev) => ({ ...prev, mcpServerById: buildById(list, 'mcp_server_id') }))
        );
        void runHydration(
          'session-mcp-servers',
          ['sessionMcp'],
          () =>
            client
              .service('session-mcp-servers')
              .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          (list) => setMaps((prev) => ({ ...prev, sessionMcpServerIds: buildSessionMcpMap(list) }))
        );
        void runHydration(
          'gateway-channels',
          ['gatewayChannels'],
          () =>
            client
              .service('gateway-channels')
              .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          (list) => setMaps((prev) => ({ ...prev, gatewayChannelById: buildById(list, 'id') }))
        );
        void runHydration(
          'artifacts',
          ['artifacts'],
          () =>
            client.service('artifacts').findAll({
              query: {
                $limit: PAGINATION.DEFAULT_LIMIT,
                $select: [
                  'artifact_id',
                  'branch_id',
                  'source_session_id',
                  'board_id',
                  'name',
                  'description',
                  'path',
                  'template',
                  'build_status',
                  'build_errors',
                  'content_hash',
                  'public',
                  'created_by',
                  'created_at',
                  'updated_at',
                  'archived',
                  'archived_at',
                  'fullscreen_url',
                  'url',
                ],
              },
            }),
          (list) => setMaps((prev) => ({ ...prev, artifactById: buildById(list, 'artifact_id') }))
        );
        void runHydration(
          'oauth-status',
          ['oauth'],
          () => client.service('mcp-servers/oauth-status').find(),
          (res) => {
            const ids =
              (res as { authenticated_server_ids?: string[] })?.authenticated_server_ids ?? [];
            setMaps((prev) => ({ ...prev, userAuthenticatedMcpServerIds: new Set(ids) }));
          }
        );

        // ── Essential gated fetches — LIGHT batch ───────────────────────
        // Tiny global collections (boards / users / repos / card-types stay
        // global — bounded and small) plus a BOUNDED recent slice of sessions.
        // Awaited first so we can resolve the first-paint board scope BEFORE the
        // board-scoped heavy batch. Sessions and branches are the two that scale
        // (sessions unbounded with activity; hundreds of branches on a real
        // workspace), so they are NOT fetched in full here: sessions are capped
        // at recent-N, branches are deferred to the board-scoped heavy batch, and
        // BOTH full sets are background-hydrated after the gate opens.
        debugTimer?.startFetchPhase();
        const [sessionsList, boardsList, cardTypesList, reposList, usersList] = await Promise.all([
          track(
            'sessions',
            silent
              ? // Reconnect resyncs must fully repopulate every board, so they stay
                // GLOBAL/full (mirrors the heavy + hydration paths below).
                client.service('sessions').findAll({
                  query: {
                    archived: false,
                    $limit: PAGINATION.DEFAULT_LIMIT,
                    $sort: { updated_at: -1 },
                  },
                })
              : // Bounded recent slice for first paint. Use find() (a SINGLE page),
                // NOT findAll(): findAll loops until it has `total` rows, so a small
                // $limit would still walk the whole table and defeat the cap. The
                // daemon orders by `updated_at` in SQL (findPage), so this is the
                // genuinely most-recent N. The FULL set is hydrated below.
                client
                  .service('sessions')
                  .find({
                    query: {
                      archived: false,
                      $limit: RECENT_SESSIONS_LIMIT,
                      $sort: { updated_at: -1 },
                    },
                  })
                  .then((result) => (Array.isArray(result) ? result : result.data))
          ),
          track(
            'boards',
            client.service('boards').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } })
          ),
          track(
            'card-types',
            client.service('card-types').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } })
          ),
          track(
            'repos',
            client.service('repos').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } })
          ),
          track(
            'users',
            client.service('users').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } })
          ),
        ]);

        // Branches healed into first paint by a direct deep link — the URL
        // session's branch, or a `/w/<id>` branch link. They seed `branchById`
        // ahead of the board-scoped branch fetch so the displayed board can be
        // resolved and its target card paints immediately.
        const healedBranches: Branch[] = [];

        // Direct /s/<id>/ opens should work for archived sessions without broadening
        // the recent-session slice. If it missed the URL target, fetch just that
        // session by ID/short ID. Its branch is only hydrated when it is still
        // active; adding archived branches to `branchById` would make board-object
        // joins render archived cards back onto active boards.
        if (
          directSessionId &&
          !hasIdMatchingPrefix(directSessionId, sessionsList, (s) => s.session_id)
        ) {
          try {
            const directSession = (await client
              .service('sessions')
              .get(directSessionId)) as Session;
            if (!sessionsList.some((s) => s.session_id === directSession.session_id)) {
              sessionsList.push(directSession);
            }
            if (!directSession.archived && directSession.branch_id) {
              try {
                const directBranch = (await client
                  .service('branches')
                  .get(directSession.branch_id)) as Branch;
                if (!directBranch.archived) {
                  healedBranches.push(directBranch);
                }
              } catch {
                // The session can still open; it just won't be able to switch/recenter
                // if the branch is inaccessible or gone.
              }
            }
          } catch {
            // Leave normal URL resolution to report/not-heal unresolved session links.
          }
        }

        // The board the app will ACTUALLY display, resolved from the current URL
        // with the same slug/short-id resolvers `useUrlState` uses (NOT
        // localStorage — the displayed board can differ from the stored one, e.g.
        // a `/b/<other>/` deep link). undefined → GLOBAL (unscoped) first paint,
        // always correct: Home, `/a/` artifact links, or any unresolvable target.
        // Silent reconnect refetches always go GLOBAL so they fully resync.
        const pathname = typeof window !== 'undefined' ? window.location.pathname : '';

        // Direct /w/<id>/ branch opens: heal that branch so the board chains
        // through it (branch → board_id). Sessions carry `branch_board_id` so
        // session links resolve without this, but a branch link has nothing else
        // to chain from until the board-scoped branch fetch (which needs the board
        // we're trying to resolve — hence the targeted get here).
        if (!silent) {
          const parsedPath = parseEntityPath(pathname);
          if (
            parsedPath?.kind === 'branch' &&
            !hasIdMatchingPrefix(parsedPath.token, healedBranches, (b) => b.branch_id)
          ) {
            try {
              const directBranch = (await client
                .service('branches')
                .get(parsedPath.token)) as Branch;
              if (!directBranch.archived) healedBranches.push(directBranch);
            } catch {
              // Unresolvable branch link → fall back to a GLOBAL first paint.
            }
          }
        }

        // Build the light global Maps + interim session/branch lookups used to
        // resolve the board scope. `interimBranchById` holds only healed branches;
        // the board-scoped set lands in the heavy batch below.
        const boardsMap = new Map<string, Board>();
        for (const board of boardsList) {
          boardsMap.set(board.board_id, board);
        }
        const cardTypesMap = new Map<string, CardType>();
        for (const cardType of cardTypesList) {
          cardTypesMap.set(cardType.card_type_id, cardType);
        }
        const reposMap = new Map<string, Repo>();
        for (const repo of reposList) {
          reposMap.set(repo.repo_id, repo);
        }
        const usersMap = new Map<string, User>();
        for (const user of usersList) {
          usersMap.set(user.user_id, user);
        }

        const interimBranchById = new Map<string, Branch>();
        for (const branch of healedBranches) {
          interimBranchById.set(branch.branch_id, branch);
        }
        const interimSessionById = buildSessionMaps(sessionsList).sessionById;

        const boardScope = silent
          ? undefined
          : (resolveDisplayedBoardId(pathname, boardsMap, interimBranchById, interimSessionById) ??
            undefined);

        // ── Essential gated fetches — HEAVY + board-scoped batch ────────
        // Scoped to the first-paint board when resolved (board_id pushes to SQL
        // for sessions / board-objects / board-comments; cards filter it
        // server-side). On a real workspace this trims thousands of rows to one
        // board's. Silent reconnect (boardScope undefined) fetches branches
        // GLOBAL/full to resync; sessions were already fetched full in the silent
        // light batch above, so the extra board-session fetch is skipped there.
        const [branchesList, boardSessionsList, boardObjectsList, commentsList, cardsList] =
          await Promise.all([
            track(
              'branches',
              silent
                ? client.service('branches').findAll({
                    query: { archived: false, $limit: PAGINATION.DEFAULT_LIMIT },
                  })
                : boardScope
                  ? client.service('branches').findAll({
                      query: {
                        archived: false,
                        board_id: boardScope,
                        $limit: PAGINATION.DEFAULT_LIMIT,
                      },
                    })
                  : Promise.resolve([] as Branch[])
            ),
            // Board-scoped sessions: only when a board is displayed and we didn't
            // already fetch the full set (silent path). Merged with the recent
            // slice below. Not tracked — not part of the loading checklist.
            !silent && boardScope
              ? client.service('sessions').findAll({
                  query: {
                    archived: false,
                    board_id: boardScope,
                    $limit: PAGINATION.DEFAULT_LIMIT,
                    $sort: { updated_at: -1 },
                  },
                })
              : Promise.resolve([] as Session[]),
            track(
              'board-objects',
              client.service('board-objects').findAll({
                query: {
                  $limit: PAGINATION.DEFAULT_LIMIT,
                  ...(boardScope ? { board_id: boardScope } : {}),
                },
              })
            ),
            track(
              'board-comments',
              client.service('board-comments').findAll({
                query: {
                  $limit: PAGINATION.DEFAULT_LIMIT,
                  ...(boardScope ? { board_id: boardScope } : {}),
                },
              })
            ),
            track(
              'cards',
              client.service('cards').findAll({
                query: {
                  $limit: PAGINATION.DEFAULT_LIMIT,
                  ...(boardScope ? { board_id: boardScope } : {}),
                },
              })
            ),
          ]);
        debugTimer?.endFetchPhase();

        if (!silent) {
          setLoadingStage('indexing');
          debugTimer?.markStage('indexing');
          debugTimer?.startIndexing();
          // Give the browser one paint opportunity so large instances can
          // visibly advance from "loading lists" to "indexing workspace data"
          // before the synchronous Map construction below.
          await new Promise<void>((resolve) => {
            if (
              typeof window === 'undefined' ||
              typeof window.requestAnimationFrame !== 'function'
            ) {
              resolve();
              return;
            }
            window.requestAnimationFrame(() => resolve());
          });
        }

        // Build board object Maps for efficient lookups (shared with the
        // background full-hydration pass so the two index builds stay identical)
        const {
          boardObjectById: boardObjectsMap,
          boardObjectsByBoardId: boardObjectsByBoardMap,
          boardObjectByBranchId: boardObjectByBranchMap,
          boardObjectByCardId: boardObjectByCardMap,
        } = buildBoardObjectMaps(boardObjectsList);
        // Build comment Map for efficient lookups
        const commentsMap = new Map<string, BoardComment>();
        for (const comment of commentsList) {
          commentsMap.set(comment.comment_id, comment);
        }
        // Build card Map for efficient lookups
        const cardsMap = new Map<string, CardWithType>();
        for (const card of cardsList) {
          cardsMap.set(card.card_id, card);
        }

        // Merge the recent session slice with the board-scoped sessions (dedup by
        // id) for first paint, then build both session lookups (incl. remote
        // surrogates). The FULL session set is background-hydrated below.
        const firstPaintSessions = new Map<string, Session>();
        for (const session of sessionsList) {
          firstPaintSessions.set(session.session_id, session);
        }
        for (const session of boardSessionsList) {
          if (!firstPaintSessions.has(session.session_id)) {
            firstPaintSessions.set(session.session_id, session);
          }
        }
        const { sessionById: sessionsById, sessionsByBranch: sessionsByBranchId } =
          buildSessionMaps([...firstPaintSessions.values()]);

        // Branch map for first paint: the board-scoped (or silent-global) set,
        // plus any deep-link-healed branches. The FULL set is hydrated below.
        const branchesMap = new Map<string, Branch>();
        for (const branch of branchesList) {
          branchesMap.set(branch.branch_id, branch);
        }
        for (const branch of healedBranches) {
          if (!branchesMap.has(branch.branch_id)) {
            branchesMap.set(branch.branch_id, branch);
          }
        }

        // Merge the essential slices in one atomic update. We spread `prev`
        // (rather than replacing the whole object) so the BACKGROUND-managed
        // slices — mcpServerById / gatewayChannelById / artifactById /
        // sessionMcpServerIds / userAuthenticatedMcpServerIds — survive even if
        // their fire-and-forget fetches resolved before this gate did. Those
        // slices are owned by their background setters + realtime handlers.
        setMaps((prev) => ({
          ...prev,
          sessionById: sessionsById,
          sessionsByBranch: sessionsByBranchId,
          boardById: boardsMap,
          boardObjectById: boardObjectsMap,
          boardObjectsByBoardId: boardObjectsByBoardMap,
          boardObjectByBranchId: boardObjectByBranchMap,
          boardObjectByCardId: boardObjectByCardMap,
          commentById: commentsMap,
          cardById: cardsMap,
          cardTypeById: cardTypesMap,
          repoById: reposMap,
          branchById: branchesMap,
          userById: usersMap,
        }));
        // This wholesale replace is NOT a `runHydration` apply, so it must bump
        // the revisions of every collection it overwrites — exactly like the
        // per-mutation realtime handlers do. Critical on the SILENT reconnect
        // resync: an in-flight hydration whose snapshot predates the disconnect
        // would otherwise pass its quiet check and clobber this newer reconnect
        // snapshot (resurrecting data that changed while we were disconnected).
        // The background hydrations kicked off below re-snapshot AFTER this bump,
        // so they're unaffected.
        for (const c of ['sessions', 'branches', 'boardObjects', 'cards', 'comments'] as const) {
          liveRevisionsRef.current[c] += 1;
        }
        debugTimer?.endIndexing();
        debugFinishStatus = 'success';

        // ── Background full hydration (skip-apply-on-race) ──────────────
        // First paint is now open with ONLY the recent sessions + the displayed
        // board's branches/sessions/objects/cards/comments. Pull the FULL sets so
        // per-board counts, the board switcher, GlobalSearch, the branch-list
        // drawer, facepiles and session genealogy (which can span boards) see
        // everything a beat later.
        //
        // Correctness: this runs WHILE the app is interactive, so a realtime
        // create/patch/remove can land during a global fetch. `runHydration`
        // applies the fetched snapshot WHOLESALE only when no live write to the
        // listed collection(s) raced the fetch (revision counters unchanged) —
        // a wholesale apply of a quiet snapshot can neither clobber a live
        // create/patch (none happened) nor resurrect a live remove (a remove
        // would have bumped the counter → no apply). If a write raced, the
        // snapshot is discarded and refetched; we never overlay a racy snapshot.

        // Sessions + branches: now ALWAYS bounded at first paint (recent-N /
        // board-scoped), so hydrate them on every non-silent load (silent
        // reconnect already fetched them full above). repos / users / boards /
        // card-types stay global at first paint, so they need no top-up.
        //
        // Sessions and branches hydrate on INDEPENDENT loops (separate fetches,
        // separate revision guards, separate generation tokens). They were
        // previously coupled in one runHydration, which meant high-frequency
        // session-write churn (common when agents stream) could starve the
        // branch apply indefinitely — and on Home, branches start empty and are
        // filled ONLY by this hydration, so coupling could leave the board empty
        // forever. Decoupled, branches apply on their own quiet window (almost
        // immediately) regardless of session churn.
        if (!silent) {
          void runHydration(
            'sessions',
            ['sessions'],
            () =>
              client.service('sessions').findAll({
                query: {
                  archived: false,
                  $limit: PAGINATION.DEFAULT_LIMIT,
                  $sort: { updated_at: -1 },
                },
              }),
            (allSessions) =>
              setMaps((prev) => {
                // The hydration fetches active sessions only. Deep-link-healed
                // archived sessions (added to `sessionById` so a direct /s/<id>
                // archived link can open the drawer) are OUT of that query's
                // domain — never in branch buckets, so they don't affect board
                // rendering — so carry them over rather than dropping them. This
                // is domain-completion, NOT race reconciliation: the race
                // correctness comes entirely from the quiet-window guarantee.
                const sessions = new Map<string, Session>();
                for (const session of allSessions) sessions.set(session.session_id, session);
                for (const [id, session] of prev.sessionById) {
                  if (session.archived && !sessions.has(id)) sessions.set(id, session);
                }
                const { sessionById, sessionsByBranch } = buildSessionMaps([...sessions.values()]);
                return { ...prev, sessionById, sessionsByBranch };
              })
          );
          void runHydration(
            'branches',
            ['branches'],
            () =>
              client
                .service('branches')
                .findAll({ query: { archived: false, $limit: PAGINATION.DEFAULT_LIMIT } }),
            (allBranches) =>
              // Quiet window proven by runHydration → apply wholesale. Branches
              // are active-only (the snapshot query is archived:false and the
              // handlers never keep an archived branch), so a wholesale replace
              // is complete.
              setMaps((prev) => ({ ...prev, branchById: buildById(allBranches, 'branch_id') }))
          );
        }

        // Board objects / cards / comments: only board-scoped at first paint when
        // a board was resolved (`boardScope` set, non-silent only — silent
        // reconnect already refetches everything global). Top up to the global set.
        //
        // Board objects / cards / comments also hydrate on INDEPENDENT loops so
        // churn in one (e.g. rapid card moves) can't starve another's apply. Each
        // global snapshot is a superset of its board-scoped first-paint slice, so
        // no overlay is needed; the quiet-window guard prevents clobber/resurrect.
        if (boardScope) {
          void runHydration(
            'board-objects',
            ['boardObjects'],
            () =>
              client
                .service('board-objects')
                .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
            (allBoardObjects) =>
              setMaps((prev) => {
                const base = buildBoardObjectMaps(allBoardObjects);
                return {
                  ...prev,
                  boardObjectById: base.boardObjectById,
                  boardObjectsByBoardId: base.boardObjectsByBoardId,
                  boardObjectByBranchId: base.boardObjectByBranchId,
                  boardObjectByCardId: base.boardObjectByCardId,
                };
              })
          );
          void runHydration(
            'cards',
            ['cards'],
            () => client.service('cards').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
            (allCards) => setMaps((prev) => ({ ...prev, cardById: buildById(allCards, 'card_id') }))
          );
          void runHydration(
            'board-comments',
            ['comments'],
            () =>
              client
                .service('board-comments')
                .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
            (allComments) =>
              setMaps((prev) => ({ ...prev, commentById: buildById(allComments, 'comment_id') }))
          );
        }

        // Silent refetch succeeded — clear the retry flag so future token
        // refreshes don't trigger another wasted re-fetch.
        if (silent) {
          lastSilentFetchFailedRef.current = false;
        }
      } catch (err) {
        if (silent) {
          // Background refetch failed (e.g. transient 401 racing the socket
          // re-auth, or a 5xx). Don't escalate to the fullscreen error overlay —
          // we still have last-known good byId state on screen. Latch the
          // failure so the next TOKENS_REFRESHED_EVENT (or reconnect) retries.
          console.warn('[useAgorData] silent refetch failed:', err);
          lastSilentFetchFailedRef.current = true;
        } else {
          debugFinishStatus = 'error';
          debugFinishError = err;
          setError(err instanceof Error ? err.message : 'Failed to fetch data');
        }
      } finally {
        if (!silent) {
          setLoading(false);
          setLoadingStage('idle');
          debugTimer?.markStage('idle');
          if (debugFinishStatus) {
            debugTimer?.finish(debugFinishStatus, debugFinishError);
          }
        }
      }
    },
    [client, directSessionId, enabled]
  );

  // Clear all data when client goes away (logout / token revocation).
  //
  // IMPORTANT: this fires when `client` is null — which must NOT be the case
  // during a transient socket disconnect. The caller (App.tsx) passes the
  // client reference straight through; useAgorClient only nulls its ref on
  // logout, not on a socket drop. If a future caller re-introduces a gate
  // like `connected ? client : null`, every transient drop will wipe the
  // board (and downstream, the URL) — see the comment on the useAgorData
  // call in App.tsx for the full failure chain.
  //
  // EMPTY_MAPS covers every field — adding a new map to DataMaps automatically
  // includes it here without any extra code.
  useEffect(() => {
    if (client) return;
    // Cancel every in-flight hydration loop (bump generations) AND fail any
    // quiet check it might still reach (bump revisions) so an unresolved
    // hydration can't repopulate the Maps AFTER logout (post-logout data leak).
    // Bumping the generation is the real stop — without it, a revision bump alone
    // would only make the loop discard-and-RE-FETCH from the stale client and
    // eventually apply into freshly-cleared Maps. Same lynchpin as the
    // per-mutation revision bumps.
    for (const c of Object.keys(liveRevisionsRef.current) as HydratedCollection[]) {
      hydrationGenerationRef.current[c] += 1;
      liveRevisionsRef.current[c] += 1;
    }
    setMaps(EMPTY_MAPS);
    setHasInitiallyFetched(false);
  }, [client]);

  // On unmount, supersede every in-flight per-collection hydration loop so it
  // stops retrying and never applies a snapshot (or schedules another timer)
  // after teardown. Generation bump = cancellation; see `runHydration`.
  useEffect(() => {
    const generations = hydrationGenerationRef.current;
    return () => {
      for (const c of Object.keys(generations) as HydratedCollection[]) {
        generations[c] += 1;
      }
    };
  }, []);

  // If the user navigates to /s/<id>/ after the initial active-session fetch,
  // load that one session by ID as well. This keeps direct links to archived
  // sessions openable without changing the default list query.
  useEffect(() => {
    if (!client || !enabled || !hasInitiallyFetched || !directSessionId) return;
    if (maps.sessionById.has(directSessionId)) return;
    if (hasIdMatchingPrefix(directSessionId, maps.sessionById.values(), (s) => s.session_id)) {
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const directSession = (await client.service('sessions').get(directSessionId)) as Session;
        if (cancelled) return;

        // This is a live write to the sessions maps — bump so a sessions
        // hydration in flight discards its (session-missing) snapshot rather
        // than clobbering this deep-link heal.
        bumpRevision('sessions');
        setSessionById((prev) => {
          if (prev.has(directSession.session_id)) return prev;
          const next = new Map(prev);
          next.set(directSession.session_id, directSession);
          return next;
        });
        if (!directSession.archived) {
          setSessionsByBranch((prev) => {
            const branchSessions = prev.get(directSession.branch_id) || [];
            if (branchSessions.some((s) => s.session_id === directSession.session_id)) return prev;
            const next = new Map(prev);
            next.set(directSession.branch_id, [...branchSessions, directSession]);
            return next;
          });
        }

        if (
          !directSession.archived &&
          directSession.branch_id &&
          !maps.branchById.has(directSession.branch_id)
        ) {
          try {
            const directBranch = (await client
              .service('branches')
              .get(directSession.branch_id)) as Branch;
            if (cancelled) return;
            bumpRevision('branches');
            setBranchById((prev) => {
              if (directBranch.archived) return prev;
              if (prev.has(directBranch.branch_id)) return prev;
              const next = new Map(prev);
              next.set(directBranch.branch_id, directBranch);
              return next;
            });
          } catch {
            // Session can still be selected if its branch is inaccessible/gone.
          }
        }
      } catch {
        // Keep unresolved session URLs sticky; the normal URL resolver will
        // avoid self-healing until a matching session exists.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    bumpRevision,
    client,
    directSessionId,
    enabled,
    hasInitiallyFetched,
    maps.branchById,
    maps.sessionById,
    setBranchById,
    setSessionById,
    setSessionsByBranch,
  ]);

  // Subscribe to real-time updates
  // biome-ignore lint/correctness/useExhaustiveDependencies: setter helpers only close over stable setMaps; listing them would add noise without preventing stale closures
  useEffect(() => {
    if (!client || !enabled) {
      // No client or disabled = not ready for data fetch, set loading to false
      setLoading(false);
      setLoadingStage('idle');
      return;
    }

    // Subscribe to session events
    const sessionsService = client.service('sessions');
    const handleSessionCreated = (session: Session) => {
      // Bump the sessions revision so an in-flight sessions hydration discards
      // its snapshot and refetches instead of clobbering this write.
      bumpRevision('sessions');
      if (session.archived) return;

      // Update sessionById - only create new Map if session doesn't exist
      setSessionById((prev) => {
        if (prev.has(session.session_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(session.session_id, session);
        return next;
      });

      // Update sessionsByBranch - only create new Map when adding new session
      setSessionsByBranch((prev) => {
        const branchSessions = prev.get(session.branch_id) || [];
        // Check if session already exists in this branch (duplicate event)
        if (branchSessions.some((s) => s.session_id === session.session_id)) return prev;

        const next = new Map(prev);
        next.set(session.branch_id, [...branchSessions, session]);
        return next;
      });
    };
    const handleSessionPatched = (session: Session) => {
      // Patch (incl. archive, which removes the session from the active maps)
      // counts as a live write — bump so an in-flight sessions hydration can't
      // clobber it or resurrect an archive with a pre-archive snapshot.
      bumpRevision('sessions');
      const isArchived = session.archived === true;
      // Track old branch_id for migration detection
      let oldBranchId: string | null = null;

      // Update sessionById - add/update active sessions, remove archived sessions
      setSessionById((prev) => {
        const existing = prev.get(session.session_id);

        // Capture old branch_id before updating
        oldBranchId = existing?.branch_id || null;

        if (isArchived) {
          if (!existing) return prev;
          const next = new Map(prev);
          next.delete(session.session_id);
          return next;
        }

        const mergedSession = preserveSessionRelationshipFields(session, existing);

        // Bail out on no-op patches. Feathers always emits a fresh object so
        // `existing === session` never holds, but the daemon does emit
        // idempotent patches (e.g. callback bookkeeping that lands at the same
        // status). Shallow-equal misses nested fields the daemon reserializes
        // — that's a safe false negative.
        if (existing && shallowEqualEntity(existing, mergedSession)) return prev;

        const next = new Map(prev);
        next.set(session.session_id, mergedSession);
        return next;
      });

      // Update sessionsByBranch - keep active sessions only
      setSessionsByBranch((prev) => {
        let changed = false;
        const next = new Map(prev);
        const newBranchId = session.branch_id;

        const removeFromBranch = (branchId: string) => {
          const bucket = next.get(branchId) || [];
          const filtered = bucket.filter((s) => s.session_id !== session.session_id);
          if (filtered.length !== bucket.length) {
            changed = true;
            if (filtered.length > 0) {
              next.set(branchId, filtered);
            } else {
              next.delete(branchId);
            }
          }
        };

        if (isArchived) {
          for (const [branchId, bucket] of next) {
            if (bucket.some((item) => item.session_id === session.session_id)) {
              removeFromBranch(branchId);
            }
          }
          return changed ? next : prev;
        }

        // Session moved between branches - remove from old bucket first
        const branchMigrated = oldBranchId && oldBranchId !== newBranchId;
        if (branchMigrated) {
          removeFromBranch(oldBranchId!);
        }

        const branchSessions = next.get(newBranchId) || [];
        const index = branchSessions.findIndex((s) => s.session_id === session.session_id);
        let sourceSessionForRemoteProjection = session;

        if (index === -1) {
          next.set(newBranchId, [...branchSessions, session]);
        } else {
          const mergedSession = preserveSessionRelationshipFields(session, branchSessions[index]);
          sourceSessionForRemoteProjection = mergedSession;

          // Bail out when the session is content-equal to what we already hold.
          // Mirrors the sessionById bailout above so an idempotent patch doesn't
          // produce a fresh branch-bucket array (which would invalidate
          // `data.sessions === n.sessions` in BranchNode's custom areEqual and
          // re-render every BranchCard on the affected branch).
          if (
            branchSessions[index] === mergedSession ||
            shallowEqualEntity(branchSessions[index], mergedSession)
          ) {
            return changed ? next : prev;
          }

          const updatedSessions = [...branchSessions];
          updatedSessions[index] = mergedSession;
          next.set(newBranchId, updatedSessions);

          // Also update any remote/surrogate projections of this session that
          // live in source-branch buckets. Preserve their local tree placement
          // while refreshing status/callback_config/etc. from the canonical row.
          for (const [branchId, bucket] of next) {
            if (branchId === newBranchId) continue;

            let bucketChanged = false;
            const refreshedBucket = bucket.map((item) => {
              if (item.session_id !== session.session_id) return item;
              bucketChanged = true;
              return {
                ...preserveSessionRelationshipFields(session, item),
                branch_id: item.branch_id,
                genealogy: item.genealogy,
                remote_surrogate: item.remote_surrogate,
              };
            });

            if (bucketChanged) {
              next.set(branchId, refreshedBucket);
            }
          }
        }

        // Remote relationships are created after the canonical target session
        // row. The daemon then emits a patched source session with
        // remote_relationships.as_source populated. Project that single source
        // row into muted remote-surrogate children now, instead of doing any
        // expensive relationship work during render.
        for (const relationship of sourceSessionForRemoteProjection.remote_relationships
          ?.as_source ?? []) {
          if (relationship.relationship_type !== 'remote_create') continue;

          const targetSession = findSessionInBranchBuckets(next, relationship.target_session_id);
          if (!targetSession) continue;

          const sourceBranchSessions = next.get(sourceSessionForRemoteProjection.branch_id) ?? [];
          if (
            sourceBranchSessions.some(
              (candidate) => candidate.session_id === targetSession.session_id
            )
          ) {
            continue;
          }

          const remoteSurrogate = createRemoteSurrogateSession(
            sourceSessionForRemoteProjection,
            targetSession,
            relationship
          );
          if (!remoteSurrogate) continue;

          next.set(sourceSessionForRemoteProjection.branch_id, [
            ...sourceBranchSessions,
            remoteSurrogate,
          ]);
        }

        return next;
      });
    };
    const handleSessionRemoved = (session: Session) => {
      bumpRevision('sessions');
      // Update sessionById — bail out when the id isn't tracked so the
      // wrapper short-circuit prevents the spurious `maps` update.
      setSessionById((prev) => {
        if (!prev.has(session.session_id)) return prev;
        const next = new Map(prev);
        next.delete(session.session_id);
        return next;
      });

      // Update sessionsByBranch — same bail when the session isn't in the
      // branch's bucket.
      setSessionsByBranch((prev) => {
        const branchSessions = prev.get(session.branch_id);
        if (!branchSessions?.some((s) => s.session_id === session.session_id)) {
          return prev;
        }
        const next = new Map(prev);
        const filtered = branchSessions.filter((s) => s.session_id !== session.session_id);
        if (filtered.length > 0) {
          next.set(session.branch_id, filtered);
        } else {
          // Clean up empty arrays
          next.delete(session.branch_id);
        }
        return next;
      });
    };

    sessionsService.on('created', handleSessionCreated);
    sessionsService.on('patched', handleSessionPatched);
    sessionsService.on('updated', handleSessionPatched);
    sessionsService.on('removed', handleSessionRemoved);

    // Subscribe to board events
    const boardsService = client.service('boards');
    const handleBoardCreated = (board: Board) => {
      setBoardById((prev) => {
        if (prev.has(board.board_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(board.board_id, board);
        return next;
      });
    };
    const handleBoardPatched = (board: Board) => {
      setBoardById((prev) => replaceIfChanged(prev, board.board_id, board));
    };
    const handleBoardRemoved = (board: Board) => {
      setBoardById((prev) => {
        if (!prev.has(board.board_id)) return prev; // Doesn't exist, nothing to remove
        const next = new Map(prev);
        next.delete(board.board_id);
        return next;
      });
    };

    boardsService.on('created', handleBoardCreated);
    boardsService.on('patched', handleBoardPatched);
    boardsService.on('updated', handleBoardPatched);
    boardsService.on('removed', handleBoardRemoved);

    // Subscribe to board object events
    const boardObjectsService = client.service('board-objects');
    const handleBoardObjectCreated = (boardObject: BoardEntityObject) => {
      bumpRevision('boardObjects');
      setMaps((prev) => upsertBoardObjectInMaps(prev, boardObject, 'create'));
    };
    const handleBoardObjectPatched = (boardObject: BoardEntityObject) => {
      bumpRevision('boardObjects');
      setMaps((prev) => upsertBoardObjectInMaps(prev, boardObject, 'patch'));
    };
    const handleBoardObjectRemoved = (boardObject: BoardEntityObject) => {
      bumpRevision('boardObjects');
      setMaps((prev) => removeBoardObjectFromMaps(prev, boardObject));
    };

    boardObjectsService.on('created', handleBoardObjectCreated);
    boardObjectsService.on('patched', handleBoardObjectPatched);
    boardObjectsService.on('updated', handleBoardObjectPatched);
    boardObjectsService.on('removed', handleBoardObjectRemoved);

    // Subscribe to repo events
    const reposService = client.service('repos');
    const handleRepoCreated = (repo: Repo) => {
      setRepoById((prev) => {
        if (prev.has(repo.repo_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(repo.repo_id, repo);
        return next;
      });
    };
    const handleRepoPatched = (repo: Repo) => {
      setRepoById((prev) => replaceIfChanged(prev, repo.repo_id, repo));
    };
    const handleRepoRemoved = (repo: Repo) => {
      setRepoById((prev) => {
        if (!prev.has(repo.repo_id)) return prev; // Doesn't exist, nothing to remove
        const next = new Map(prev);
        next.delete(repo.repo_id);
        return next;
      });
    };

    reposService.on('created', handleRepoCreated);
    reposService.on('patched', handleRepoPatched);
    reposService.on('updated', handleRepoPatched);
    reposService.on('removed', handleRepoRemoved);

    // Subscribe to branch events
    const branchesService = client.service('branches');
    const handleBranchCreated = (branch: Branch) => {
      // Bump the branches revision so an in-flight branches hydration can't
      // clobber this write (mirrors the session handlers).
      bumpRevision('branches');
      if (branch.archived) return;

      setBranchById((prev) => {
        if (prev.has(branch.branch_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(branch.branch_id, branch);
        return next;
      });
    };
    // Drop a branch from `branchById` and prune every session that lived on
    // it from `sessionById` / `sessionsByBranch`. Shared between the
    // `archived: true` patch path and the hard-delete `removed` path —
    // either way we never want an orphan session card to linger.
    const evictBranchAndSessions = (branchId: string) => {
      // This cascade mutates BOTH the branches map (caller already bumped) and
      // the sessions maps, so bump the sessions revision too — otherwise a
      // sessions hydration in flight could resurrect the evicted sessions with a
      // pre-eviction snapshot.
      bumpRevision('sessions');
      setBranchById((prev) => {
        if (!prev.has(branchId)) return prev;
        const next = new Map(prev);
        next.delete(branchId);
        return next;
      });
      setSessionsByBranch((prev) => {
        if (!prev.has(branchId)) return prev;
        const next = new Map(prev);
        next.delete(branchId);
        return next;
      });
      setSessionById((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [sessionId, session] of prev.entries()) {
          if (session.branch_id === branchId) {
            next.delete(sessionId);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };

    const handleBranchPatched = (branch: Branch) => {
      bumpRevision('branches');
      if (branch.archived) {
        evictBranchAndSessions(branch.branch_id);
        return;
      }

      setBranchById((prev) => replaceIfChanged(prev, branch.branch_id, branch));
    };
    const handleBranchRemoved = (branch: Branch) => {
      bumpRevision('branches');
      // Mirror the archive path: a hard delete should also evict any
      // sessions we still track on that branch.
      evictBranchAndSessions(branch.branch_id);
    };

    branchesService.on('created', handleBranchCreated);
    branchesService.on('patched', handleBranchPatched);
    branchesService.on('updated', handleBranchPatched);
    branchesService.on('removed', handleBranchRemoved);

    // Subscribe to user events
    const usersService = client.service('users');
    const handleUserCreated = (user: User) => {
      setUserById((prev) => {
        if (prev.has(user.user_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(user.user_id, user);
        return next;
      });
    };
    const handleUserPatched = (user: User) => {
      setUserById((prev) => replaceIfChanged(prev, user.user_id, user));
    };
    const handleUserRemoved = (user: User) => {
      setUserById((prev) => {
        if (!prev.has(user.user_id)) return prev; // Doesn't exist, nothing to remove
        const next = new Map(prev);
        next.delete(user.user_id);
        return next;
      });
    };

    usersService.on('created', handleUserCreated);
    usersService.on('patched', handleUserPatched);
    usersService.on('updated', handleUserPatched);
    usersService.on('removed', handleUserRemoved);

    // Subscribe to MCP server events
    const mcpServersService = client.service('mcp-servers');
    const handleMCPServerCreated = (server: MCPServer) => {
      bumpRevision('mcpServers');
      setMcpServerById((prev) => {
        if (prev.has(server.mcp_server_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(server.mcp_server_id, server);
        return next;
      });
    };
    const handleMCPServerPatched = (server: MCPServer) => {
      bumpRevision('mcpServers');
      setMcpServerById((prev) => replaceIfChanged(prev, server.mcp_server_id, server));
    };
    const handleMCPServerRemoved = (server: MCPServer) => {
      bumpRevision('mcpServers');
      setMcpServerById((prev) => {
        if (!prev.has(server.mcp_server_id)) return prev; // Doesn't exist, nothing to remove
        const next = new Map(prev);
        next.delete(server.mcp_server_id);
        return next;
      });
    };

    mcpServersService.on('created', handleMCPServerCreated);
    mcpServersService.on('patched', handleMCPServerPatched);
    mcpServersService.on('updated', handleMCPServerPatched);
    mcpServersService.on('removed', handleMCPServerRemoved);

    // Subscribe to gateway channel events
    const gatewayChannelsService = client.service('gateway-channels');
    const handleGatewayChannelCreated = (channel: GatewayChannel) => {
      bumpRevision('gatewayChannels');
      setGatewayChannelById((prev) => {
        if (prev.has(channel.id)) return prev;
        const next = new Map(prev);
        next.set(channel.id, channel);
        return next;
      });
    };
    const handleGatewayChannelPatched = (channel: GatewayChannel) => {
      bumpRevision('gatewayChannels');
      setGatewayChannelById((prev) => replaceIfChanged(prev, channel.id, channel));
    };
    const handleGatewayChannelRemoved = (channel: GatewayChannel) => {
      bumpRevision('gatewayChannels');
      setGatewayChannelById((prev) => {
        if (!prev.has(channel.id)) return prev;
        const next = new Map(prev);
        next.delete(channel.id);
        return next;
      });
    };

    gatewayChannelsService.on('created', handleGatewayChannelCreated);
    gatewayChannelsService.on('patched', handleGatewayChannelPatched);
    gatewayChannelsService.on('updated', handleGatewayChannelPatched);
    gatewayChannelsService.on('removed', handleGatewayChannelRemoved);

    // Subscribe to card events
    const cardsService = client.service('cards');
    const handleCardCreated = (card: CardWithType) => {
      bumpRevision('cards');
      setCardById((prev) => {
        if (prev.has(card.card_id)) return prev; // Duplicate event — bail.
        const next = new Map(prev);
        next.set(card.card_id, card);
        return next;
      });
    };
    const handleCardPatched = (card: CardWithType) => {
      bumpRevision('cards');
      setCardById((prev) => replaceIfChanged(prev, card.card_id, card));
    };
    const handleCardRemoved = (card: CardWithType) => {
      bumpRevision('cards');
      setCardById((prev) => {
        if (!prev.has(card.card_id)) return prev;
        const next = new Map(prev);
        next.delete(card.card_id);
        return next;
      });
    };

    cardsService.on('created', handleCardCreated);
    cardsService.on('patched', handleCardPatched);
    cardsService.on('updated', handleCardPatched);
    cardsService.on('removed', handleCardRemoved);

    // Subscribe to card type events
    const cardTypesService = client.service('card-types');
    const handleCardTypeCreated = (cardType: CardType) => {
      setCardTypeById((prev) => {
        if (prev.has(cardType.card_type_id)) return prev; // Duplicate event — bail.
        const next = new Map(prev);
        next.set(cardType.card_type_id, cardType);
        return next;
      });
    };
    const handleCardTypePatched = (cardType: CardType) => {
      setCardTypeById((prev) => replaceIfChanged(prev, cardType.card_type_id, cardType));
    };
    const handleCardTypeRemoved = (cardType: CardType) => {
      setCardTypeById((prev) => {
        if (!prev.has(cardType.card_type_id)) return prev;
        const next = new Map(prev);
        next.delete(cardType.card_type_id);
        return next;
      });
    };

    cardTypesService.on('created', handleCardTypeCreated);
    cardTypesService.on('patched', handleCardTypePatched);
    cardTypesService.on('updated', handleCardTypePatched);
    cardTypesService.on('removed', handleCardTypeRemoved);

    // Subscribe to artifact events
    const artifactsService = client.service('artifacts');
    const handleArtifactCreated = (artifact: Artifact) => {
      bumpRevision('artifacts');
      setArtifactById((prev) => {
        if (prev.has(artifact.artifact_id)) return prev;
        const next = new Map(prev);
        next.set(artifact.artifact_id, artifact);
        return next;
      });
    };
    const handleArtifactPatched = (artifact: Artifact) => {
      bumpRevision('artifacts');
      setArtifactById((prev) => replaceIfChanged(prev, artifact.artifact_id, artifact));
      // Notify ArtifactNode components that payload may have changed. The
      // consumer (apps/agor-ui/src/components/SessionCanvas/canvas/ArtifactNode.tsx)
      // already filters by `contentHash !== lastHashRef.current`, so an
      // idempotent dispatch is a cheap no-op there — no need to mirror the
      // shallow-equal bailout from a state-updater side effect (which would
      // not be pure under StrictMode anyway).
      window.dispatchEvent(
        new CustomEvent('agor:artifact-patched', {
          detail: { artifactId: artifact.artifact_id, contentHash: artifact.content_hash },
        })
      );
    };
    const handleArtifactRemoved = (artifact: Artifact) => {
      bumpRevision('artifacts');
      setArtifactById((prev) => {
        if (!prev.has(artifact.artifact_id)) return prev;
        const next = new Map(prev);
        next.delete(artifact.artifact_id);
        return next;
      });
    };

    artifactsService.on('created', handleArtifactCreated);
    artifactsService.on('patched', handleArtifactPatched);
    artifactsService.on('updated', handleArtifactPatched);
    artifactsService.on('removed', handleArtifactRemoved);

    // Agent-driven runtime queries: daemon emits when an MCP tool wants to
    // introspect the iframe DOM. ArtifactNode components listen for the
    // re-dispatched window event and filter by artifactId — the only one
    // currently rendering this artifact answers, anyone else ignores.
    const handleAgorQuery = (event: {
      request_id: string;
      artifact_id: string;
      requested_by_user_id: string;
      kind: string;
      args: Record<string, unknown>;
    }) => {
      window.dispatchEvent(new CustomEvent('agor:artifact-runtime-query', { detail: event }));
    };
    artifactsService.on('agor-query', handleAgorQuery);

    // Subscribe to session-MCP server relationship events
    const sessionMcpService = client.service('session-mcp-servers');
    const handleSessionMcpCreated = (relationship: {
      session_id: string;
      mcp_server_id: string;
    }) => {
      bumpRevision('sessionMcp');
      setSessionMcpServerIds((prev) => {
        const sessionMcpIds = prev.get(relationship.session_id) || [];
        // Check if relationship already exists (duplicate event)
        if (sessionMcpIds.includes(relationship.mcp_server_id)) return prev;

        const next = new Map(prev);
        next.set(relationship.session_id, [...sessionMcpIds, relationship.mcp_server_id]);
        return next;
      });
    };
    const handleSessionMcpRemoved = (relationship: {
      session_id: string;
      mcp_server_id: string;
    }) => {
      bumpRevision('sessionMcp');
      setSessionMcpServerIds((prev) => {
        const sessionMcpIds = prev.get(relationship.session_id) || [];
        const filtered = sessionMcpIds.filter((id) => id !== relationship.mcp_server_id);

        // No change if MCP server wasn't in the list
        if (filtered.length === sessionMcpIds.length) return prev;

        const next = new Map(prev);
        if (filtered.length > 0) {
          next.set(relationship.session_id, filtered);
        } else {
          // Clean up empty arrays
          next.delete(relationship.session_id);
        }
        return next;
      });
    };

    sessionMcpService.on('created', handleSessionMcpCreated);
    sessionMcpService.on('removed', handleSessionMcpRemoved);

    // Subscribe to board comment events
    const commentsService = client.service('board-comments');
    const handleCommentCreated = (comment: BoardComment) => {
      bumpRevision('comments');
      setCommentById((prev) => {
        if (prev.has(comment.comment_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(comment.comment_id, comment);
        return next;
      });
    };
    const handleCommentPatched = (comment: BoardComment) => {
      bumpRevision('comments');
      setCommentById((prev) => replaceIfChanged(prev, comment.comment_id, comment));
    };
    const handleCommentRemoved = (comment: BoardComment) => {
      bumpRevision('comments');
      setCommentById((prev) => {
        if (!prev.has(comment.comment_id)) return prev; // Doesn't exist, nothing to remove
        const next = new Map(prev);
        next.delete(comment.comment_id);
        return next;
      });
    };

    commentsService.on('created', handleCommentCreated);
    commentsService.on('patched', handleCommentPatched);
    commentsService.on('updated', handleCommentPatched);
    commentsService.on('removed', handleCommentRemoved);

    // Listen for OAuth completion events to update per-user token state in real-time.
    // Only update the per-user set when oauth_mode is 'per_user' (or unset, which defaults
    // to per_user). Shared-mode completions update the server record itself and don't need
    // per-user tracking — and shared events ARE broadcast to all sockets on purpose, since
    // every tab needs to refetch. Per-user events are scoped to the originating socket or
    // the user's per-user room on the daemon side (see register-services.ts oauth callback),
    // so we never receive another user's per_user completion here.
    const handleOAuthCompleted = async (event: {
      state: string;
      success: boolean;
      mcp_server_id?: string;
      oauth_mode?: string;
    }) => {
      if (!event.success || !event.mcp_server_id) return;
      bumpRevision('oauth');
      const mode = event.oauth_mode || 'per_user';
      if (mode === 'per_user') {
        setUserAuthenticatedMcpServerIds((prev) => {
          if (prev.has(event.mcp_server_id!)) return prev;
          const next = new Set(prev);
          next.add(event.mcp_server_id!);
          return next;
        });
      }

      // Refetch the server so the daemon's `injectPerUserOAuthTokens` find-hook
      // re-hydrates `auth.oauth_access_token` / `oauth_token_expires_at` from the
      // freshly-persisted token row. Without this, `mcpServerById` keeps the stale
      // (often-expired) auth fields and `mcpServerNeedsAuth` keeps returning true —
      // chip stays orange and the above-prompt auth banner stays up until the user
      // reloads. The hook is registered for both `find` and `get` (see
      // `apps/agor-daemon/src/register-hooks.ts`), so a single `get` is enough.
      try {
        const fresh = (await client.service('mcp-servers').get(event.mcp_server_id)) as MCPServer;
        bumpRevision('mcpServers');
        setMcpServerById((prev) => replaceIfChanged(prev, fresh.mcp_server_id, fresh));
      } catch (err) {
        console.warn('[OAuth] Failed to refetch MCP server after re-auth:', err);
      }
    };
    client.io.on('oauth:completed', handleOAuthCompleted);

    // Mirror of `oauth:completed`: when a user disconnects OAuth from Settings,
    // the daemon emits `oauth:disconnected` so every tab flips the pill to
    // "needs auth" immediately instead of staying purple until the next page
    // reload.
    const handleOAuthDisconnected = async (event: { mcp_server_id: string }) => {
      if (!event.mcp_server_id) return;
      bumpRevision('oauth');
      bumpRevision('mcpServers');
      setUserAuthenticatedMcpServerIds((prev) => {
        if (!prev.has(event.mcp_server_id)) return prev;
        const next = new Set(prev);
        next.delete(event.mcp_server_id);
        return next;
      });

      // Optimistically strip the token from the local server object so
      // `mcpServerNeedsAuth` flips to true immediately. Without this, the
      // stale `oauth_access_token` in mcpServerById short-circuits the
      // `userAuthenticatedMcpServerIds` check — and for tokens with no
      // expiry (e.g. Notion), `isExpired` is always false, so the pill
      // stays purple forever even though the Set was updated above.
      setMcpServerById((prev) => {
        const existing = prev.get(event.mcp_server_id);
        if (!existing?.auth?.oauth_access_token) return prev;
        const next = new Map(prev);
        next.set(event.mcp_server_id, {
          ...existing,
          auth: {
            ...existing.auth,
            oauth_access_token: undefined,
            oauth_token_expires_at: undefined,
          },
        });
        return next;
      });

      // Still refetch to get the canonical server state from the daemon.
      try {
        const fresh = (await client.service('mcp-servers').get(event.mcp_server_id)) as MCPServer;
        setMcpServerById((prev) => replaceIfChanged(prev, fresh.mcp_server_id, fresh));
      } catch (err) {
        console.warn('[OAuth] Failed to refetch MCP server after disconnect:', err);
      }
    };
    client.io.on('oauth:disconnected', handleOAuthDisconnected);

    // Re-fetch the global byId maps on every socket reconnect after the
    // initial mount. Feathers real-time events (`created`/`patched`/`removed`)
    // that fired while we were disconnected are gone — the daemon doesn't
    // keep a per-subscriber replay log — so without this, the app keeps
    // showing stale state (vanished branches still on the board, missed new
    // sessions, etc.) until the user refreshes the page.
    //
    // We skip the very first connect: the initial fetch above (gated on
    // `hasInitiallyFetched`) is already running or has just completed, and
    // re-running it would just be wasted bandwidth at startup.
    //
    // `silent: true` so a transient failure (e.g. racing the re-auth handler
    // in useAgorClient on reconnect, then 401-ing once before the around-hook
    // refresh lands) doesn't blank the whole app via App.tsx's `dataError`
    // path — see the silent branch in `fetchData`.
    const refetchSilently = async () => {
      if (!hasInitiallyFetched) return;
      if (refetchInflightRef.current) return;
      refetchInflightRef.current = true;
      try {
        await fetchData({ silent: true });
      } finally {
        refetchInflightRef.current = false;
      }
    };
    client.io.on('connect', refetchSilently);

    // If the prior reconnect refetch failed silently — typical scenario: the
    // socket reconnected, the around-hook hadn't refreshed the access token
    // yet, fetchData hit a 401 that bubbled up — retry once a token
    // replacement lands. Without this, byId state stays stale until the next
    // physical reconnect or a page refresh. We gate on the latch so we don't
    // refetch 14 services on every routine token rotation.
    const handleTokensRefreshed = () => {
      if (!lastSilentFetchFailedRef.current) return;
      void refetchSilently();
    };
    window.addEventListener(TOKENS_REFRESHED_EVENT, handleTokensRefreshed);

    // Initial fetch (only once — WebSocket events keep us synced after that).
    // Kicked off AFTER every `.on()` above is attached so realtime
    // created/patched/removed events that fire while fetchData's requests are
    // in flight are captured (and bump the per-collection revision counters)
    // instead of being dropped in the gap between fetch-start and listener-attach.
    if (!hasInitiallyFetched) {
      fetchData().then(() => setHasInitiallyFetched(true));
    }

    // Cleanup listeners on unmount
    return () => {
      client.io.off('oauth:completed', handleOAuthCompleted);
      client.io.off('oauth:disconnected', handleOAuthDisconnected);
      client.io.off('connect', refetchSilently);
      window.removeEventListener(TOKENS_REFRESHED_EVENT, handleTokensRefreshed);
      sessionsService.removeListener('created', handleSessionCreated);
      sessionsService.removeListener('patched', handleSessionPatched);
      sessionsService.removeListener('updated', handleSessionPatched);
      sessionsService.removeListener('removed', handleSessionRemoved);

      boardsService.removeListener('created', handleBoardCreated);
      boardsService.removeListener('patched', handleBoardPatched);
      boardsService.removeListener('updated', handleBoardPatched);
      boardsService.removeListener('removed', handleBoardRemoved);

      boardObjectsService.removeListener('created', handleBoardObjectCreated);
      boardObjectsService.removeListener('patched', handleBoardObjectPatched);
      boardObjectsService.removeListener('updated', handleBoardObjectPatched);
      boardObjectsService.removeListener('removed', handleBoardObjectRemoved);

      reposService.removeListener('created', handleRepoCreated);
      reposService.removeListener('patched', handleRepoPatched);
      reposService.removeListener('updated', handleRepoPatched);
      reposService.removeListener('removed', handleRepoRemoved);

      branchesService.removeListener('created', handleBranchCreated);
      branchesService.removeListener('patched', handleBranchPatched);
      branchesService.removeListener('updated', handleBranchPatched);
      branchesService.removeListener('removed', handleBranchRemoved);

      usersService.removeListener('created', handleUserCreated);
      usersService.removeListener('patched', handleUserPatched);
      usersService.removeListener('updated', handleUserPatched);
      usersService.removeListener('removed', handleUserRemoved);

      mcpServersService.removeListener('created', handleMCPServerCreated);
      mcpServersService.removeListener('patched', handleMCPServerPatched);
      mcpServersService.removeListener('updated', handleMCPServerPatched);
      mcpServersService.removeListener('removed', handleMCPServerRemoved);

      sessionMcpService.removeListener('created', handleSessionMcpCreated);
      sessionMcpService.removeListener('removed', handleSessionMcpRemoved);

      commentsService.removeListener('created', handleCommentCreated);
      commentsService.removeListener('patched', handleCommentPatched);
      commentsService.removeListener('updated', handleCommentPatched);
      commentsService.removeListener('removed', handleCommentRemoved);

      gatewayChannelsService.removeListener('created', handleGatewayChannelCreated);
      gatewayChannelsService.removeListener('patched', handleGatewayChannelPatched);
      gatewayChannelsService.removeListener('updated', handleGatewayChannelPatched);
      gatewayChannelsService.removeListener('removed', handleGatewayChannelRemoved);

      cardsService.removeListener('created', handleCardCreated);
      cardsService.removeListener('patched', handleCardPatched);
      cardsService.removeListener('updated', handleCardPatched);
      cardsService.removeListener('removed', handleCardRemoved);

      cardTypesService.removeListener('created', handleCardTypeCreated);
      cardTypesService.removeListener('patched', handleCardTypePatched);
      cardTypesService.removeListener('updated', handleCardTypePatched);
      cardTypesService.removeListener('removed', handleCardTypeRemoved);

      artifactsService.removeListener('created', handleArtifactCreated);
      artifactsService.removeListener('patched', handleArtifactPatched);
      artifactsService.removeListener('updated', handleArtifactPatched);
      artifactsService.removeListener('removed', handleArtifactRemoved);
      artifactsService.removeListener('agor-query', handleAgorQuery);
    };
  }, [client, enabled, fetchData, hasInitiallyFetched]);

  // Derived render model for the loading checklist. Memoized so the array
  // identity is stable across renders where no per-item count changed.
  const initialLoadItems = useMemo<InitialLoadItem[]>(
    () =>
      INITIAL_LOAD_ITEMS.map(({ key, label }) => {
        const count = itemCounts[key];
        return { key, label, done: count !== undefined, count: count ?? 0 };
      }),
    [itemCounts]
  );

  const initialLoadComplete = INITIAL_LOAD_ITEMS.every(({ key }) => itemCounts[key] !== undefined);

  return {
    ...maps,
    initialLoadItems,
    initialLoadComplete,
    loadingStage,
    loading,
    error,
    refetch: fetchData,
  };
}
