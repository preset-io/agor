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

// Max times a background fetch refetches when a realtime write races its
// in-flight request before falling back to a live-wins merge apply. Small: the
// race window is one fetch RTT and a startup write storm is rare.
const MAX_BACKGROUND_REFETCH = 3;

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
  sessionById: Map<string, { session_id: string; branch_id?: string }>
): string | null {
  const parsed = parseEntityPath(pathname);
  if (!parsed) return null;

  switch (parsed.kind) {
    case 'board':
      return resolveBoardFromUrlPure(parsed.token, boardById);
    case 'session': {
      const sessionId = resolveSessionFromShortIdPure(parsed.token, sessionById);
      if (!sessionId) return null;
      const branchId = sessionById.get(sessionId)?.branch_id;
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
  // TOKENS_REFRESHED_EVENT listener below so a token refresh that lands AFTER
  // a failed reconnect refetch (auth race during socket re-auth) gets to
  // retry — without this, the byId maps would stay stale until the next
  // physical reconnect or page refresh. We use a ref rather than state since
  // we only consume it in event handlers, never in render.
  const lastSilentFetchFailedRef = useRef(false);

  // Monotonic counter bumped by every realtime handler that mutates a slice a
  // BACKGROUND fetch later replaces wholesale (board-objects / cards / comments
  // for full hydration, plus the optional mcp / gateway / artifact / session-mcp
  // / oauth slices). A background apply snapshots this before its fetch; if it
  // changed by the time the fetch resolves, a live create/patch/remove landed
  // mid-flight and the snapshot is potentially stale — so we refetch for a
  // consistent snapshot rather than clobbering the live write. As a final
  // backstop the apply merges live entries on top of the snapshot (live wins),
  // so an in-flight create/patch is never lost even at the retry cap. We use a
  // ref (not state) since it's only read/written from async fetch code and
  // event handlers, never in render.
  const liveWriteRevisionRef = useRef(0);

  // Fetch all data
  //
  // `silent: true` is used by background refetches (e.g. socket reconnect) that
  // must not flip the global `loading` / `error` state — those are wired to the
  // fullscreen "Connecting to daemon..." spinner and "Failed to load data"
  // alert in App.tsx, which would be wildly disruptive if a transient
  // reconnect-time 401 (auth race with the re-auth handler in useAgorClient)
  // bubbled up. Silent failures are logged for observability; the UI continues
  // to render whatever byId state was last successfully fetched, and the next
  // reconnect or token refresh gets another shot.
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

        // Merge fetched snapshot entries with live ones, LIVE WINS: prevMap
        // entries (delivered by realtime while the fetch was in flight)
        // overwrite the snapshot. Mutates and returns `incoming`.
        const mergeLiveWins = <V>(
          incoming: Map<string, V>,
          prevMap: Map<string, V>
        ): Map<string, V> => {
          for (const [key, value] of prevMap) incoming.set(key, value);
          return incoming;
        };

        // Run a BACKGROUND (non-gated) fetch and apply it clobber-safely.
        // - Silent reconnect refetches are authoritative resyncs → apply once.
        // - Otherwise, if a realtime write to one of these slices landed during
        //   the fetch (liveWriteRevisionRef changed), refetch — bounded — for a
        //   fresh snapshot before applying. The appliers additionally merge live
        //   entries on top of the snapshot, so an in-flight create/patch is never
        //   lost even when the retry cap is hit under a continuous write stream.
        const runBackgroundFetch = async <T>(
          label: string,
          fetchFn: () => Promise<T>,
          apply: (result: T) => void
        ): Promise<void> => {
          try {
            if (silent) {
              apply(await fetchFn());
              return;
            }
            for (let attempt = 0; attempt < MAX_BACKGROUND_REFETCH; attempt++) {
              const revBefore = liveWriteRevisionRef.current;
              const result = await fetchFn();
              if (
                liveWriteRevisionRef.current === revBefore ||
                attempt === MAX_BACKGROUND_REFETCH - 1
              ) {
                apply(result);
                return;
              }
              // A realtime write landed mid-fetch; loop to refetch a fresh snapshot.
            }
          } catch (err) {
            console.warn(`[useAgorData] background ${label} fetch failed:`, err);
          }
        };

        // ── Background (non-gated) fetches ──────────────────────────────
        // These collections are NOT needed to paint the canvas, so they must
        // never block the first-paint gate. Fire-and-forget: each populates its
        // own map slice on resolve. Their realtime subscriptions are attached in
        // the subscribe effect BEFORE this fetch runs, so live events land even
        // while these fetches are in flight — and `runBackgroundFetch` keeps the
        // apply from clobbering them. We deliberately do NOT `track()` them —
        // they're absent from INITIAL_LOAD_ITEMS, so the loading checklist /
        // `initialLoadComplete` gate ignores them. We merge through the stable
        // `setMaps` (not the per-render setMapSlice setters, which would
        // destabilize this useCallback's deps and re-fire the subscribe effect).
        void runBackgroundFetch(
          'mcp-servers',
          () =>
            client.service('mcp-servers').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          (list) =>
            setMaps((prev) => ({
              ...prev,
              mcpServerById: silent
                ? buildById(list, 'mcp_server_id')
                : mergeLiveWins(buildById(list, 'mcp_server_id'), prev.mcpServerById),
            }))
        );
        void runBackgroundFetch(
          'session-mcp-servers',
          () =>
            client
              .service('session-mcp-servers')
              .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          (list) =>
            setMaps((prev) => ({
              ...prev,
              sessionMcpServerIds: silent
                ? buildSessionMcpMap(list)
                : mergeLiveWins(buildSessionMcpMap(list), prev.sessionMcpServerIds),
            }))
        );
        void runBackgroundFetch(
          'gateway-channels',
          () =>
            client
              .service('gateway-channels')
              .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          (list) =>
            setMaps((prev) => ({
              ...prev,
              gatewayChannelById: silent
                ? buildById(list, 'id')
                : mergeLiveWins(buildById(list, 'id'), prev.gatewayChannelById),
            }))
        );
        void runBackgroundFetch(
          'artifacts',
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
          (list) =>
            setMaps((prev) => ({
              ...prev,
              artifactById: silent
                ? buildById(list, 'artifact_id')
                : mergeLiveWins(buildById(list, 'artifact_id'), prev.artifactById),
            }))
        );
        void runBackgroundFetch(
          'oauth-status',
          () => client.service('mcp-servers/oauth-status').find(),
          (res) => {
            const ids =
              (res as { authenticated_server_ids?: string[] })?.authenticated_server_ids ?? [];
            setMaps((prev) => ({
              ...prev,
              // Non-silent: union snapshot with live additions so an OAuth
              // completion that landed mid-fetch isn't dropped. Silent: replace.
              userAuthenticatedMcpServerIds: silent
                ? new Set(ids)
                : new Set([...ids, ...prev.userAuthenticatedMcpServerIds]),
            }));
          }
        );

        // ── Essential gated fetches — LIGHT batch ───────────────────────
        // Lightweight global collections needed to (a) paint branch cards and
        // (b) resolve which board the URL targets. Awaited first so we can pick
        // the first-paint board scope BEFORE issuing the heavy fetches below.
        debugTimer?.startFetchPhase();
        const [sessionsList, boardsList, cardTypesList, reposList, branchesList, usersList] =
          await Promise.all([
            track(
              'sessions',
              client.service('sessions').findAll({
                query: {
                  archived: false,
                  $limit: PAGINATION.DEFAULT_LIMIT,
                  $sort: { updated_at: -1 },
                },
              })
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
              'branches',
              client
                .service('branches')
                .findAll({ query: { archived: false, $limit: PAGINATION.DEFAULT_LIMIT } })
            ),
            track(
              'users',
              client.service('users').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } })
            ),
          ]);

        // Direct /s/<id>/ opens should work for archived sessions without broadening
        // the default active-session list. If the active query missed the URL target,
        // fetch just that session by ID/short ID. Its branch is only hydrated when
        // it is still active; adding archived branches to `branchById` would make
        // board-object joins render archived cards back onto active boards.
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
            if (
              !directSession.archived &&
              directSession.branch_id &&
              !branchesList.some((branch) => branch.branch_id === directSession.branch_id)
            ) {
              try {
                const directBranch = (await client
                  .service('branches')
                  .get(directSession.branch_id)) as Branch;
                if (!directBranch.archived) {
                  branchesList.push(directBranch);
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

        // Build session Maps for efficient lookups
        const sessionsById = new Map<string, Session>();
        const sessionsByBranchId = new Map<string, Session[]>();

        for (const session of sessionsList) {
          // sessionById: O(1) ID lookups
          sessionsById.set(session.session_id, session);

          // sessionsByBranch: O(1) branch-scoped filtering. Keep this as the
          // active board/session list: a direct archived-session URL may add
          // the archived session to sessionById so the drawer can open, but it
          // must not reappear in branch cards or board assistants.
          if (session.archived) continue;
          const branchId = session.branch_id;
          if (!sessionsByBranchId.has(branchId)) {
            sessionsByBranchId.set(branchId, []);
          }
          sessionsByBranchId.get(branchId)!.push(session);
        }

        // Cross-branch remote-created sessions are canonical in their target
        // branch, but should also appear as muted/surrogate children under
        // the creating session's branch for track-record and navigation.
        //
        // Keep this as a UI projection only: the cloned session preserves the
        // real session_id (so clicks open the real remote session) while using
        // the source branch + source session as its local tree placement.
        for (const sourceSession of sessionsList) {
          if (sourceSession.archived) continue;

          for (const relationship of sourceSession.remote_relationships?.as_source ?? []) {
            if (relationship.relationship_type !== 'remote_create') continue;

            const targetSession = sessionsById.get(relationship.target_session_id);
            if (!targetSession) continue;

            const sourceBranchSessions = sessionsByBranchId.get(sourceSession.branch_id) ?? [];
            if (
              sourceBranchSessions.some(
                (session) => session.session_id === targetSession.session_id
              )
            ) {
              continue;
            }

            const remoteSurrogate = createRemoteSurrogateSession(
              sourceSession,
              targetSession,
              relationship
            );
            if (!remoteSurrogate) continue;

            sessionsByBranchId.set(sourceSession.branch_id, [
              ...sourceBranchSessions,
              remoteSurrogate,
            ]);
          }
        }

        // Build board / branch / repo / user / card-type Maps (the light global
        // collections). Built before the heavy batch so we can resolve the URL
        // target board.
        const boardsMap = new Map<string, Board>();
        for (const board of boardsList) {
          boardsMap.set(board.board_id, board);
        }
        const branchesMap = new Map<string, Branch>();
        for (const branch of branchesList) {
          branchesMap.set(branch.branch_id, branch);
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

        // ── First-paint board scope (URL-resolved) ──────────────────────
        // Scope the heavy collections to the board the app will ACTUALLY
        // display, resolved from the current URL with the same slug/short-id
        // resolvers `useUrlState` uses (NOT localStorage — the displayed board
        // can differ from the stored one, e.g. a `/b/<other>/` deep link).
        // Returns undefined → GLOBAL (unscoped) first paint, always correct:
        // Home, `/a/` artifact links, or any unresolvable target. Silent
        // reconnect refetches always go GLOBAL so they fully resync every board.
        const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
        const boardScope = silent
          ? undefined
          : (resolveDisplayedBoardId(pathname, boardsMap, branchesMap, sessionsById) ?? undefined);

        // ── Essential gated fetches — HEAVY batch ───────────────────────
        // The heavy collections, scoped to the first-paint board when resolved
        // (board-objects / board-comments push board_id to SQL; cards filter it
        // server-side). On a real workspace this trims thousands of rows to one
        // board's. Awaited as part of the gate so the displayed board paints
        // fully; the background hydration below then fills every other board.
        const [boardObjectsList, commentsList, cardsList] = await Promise.all([
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
        debugTimer?.endIndexing();
        debugFinishStatus = 'success';

        // ── Background full hydration ───────────────────────────────────
        // First paint is now open with ONLY the current board's heavy
        // collections. Pull the global set so cross-board nav, GlobalSearch,
        // BoardSwitcher, branch-list drawer, facepiles and session genealogy
        // see every board's objects/cards/comments.
        //
        // Clobber-safety: this runs WHILE the app is interactive, so a realtime
        // create/patch/remove can land during the global fetch. `runBackgroundFetch`
        // refetches if `liveWriteRevisionRef` changed mid-flight, and the apply
        // below MERGES the live slices on top of the global snapshot (live wins)
        // so an in-flight edit (e.g. a card the user just moved) is never reverted
        // by the snapshot. Removes are covered by the refetch (the fresh snapshot
        // omits them). Sessions/branches/repos/users/boards/card-types are already
        // global above, so only the board-scoped collections need topping up.
        // Only runs when first paint was actually scoped (`boardScope` set), which
        // is non-silent only — silent reconnect already refetches everything global.
        if (boardScope) {
          void runBackgroundFetch(
            'full hydration',
            () =>
              Promise.all([
                client
                  .service('board-objects')
                  .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
                client.service('cards').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
                client
                  .service('board-comments')
                  .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
              ]),
            ([allBoardObjects, allCards, allComments]) =>
              setMaps((prev) => {
                // Start from the global snapshot…
                const base = buildBoardObjectMaps(allBoardObjects);
                let next: DataMaps = {
                  ...prev,
                  boardObjectById: base.boardObjectById,
                  boardObjectsByBoardId: base.boardObjectsByBoardId,
                  boardObjectByBranchId: base.boardObjectByBranchId,
                  boardObjectByCardId: base.boardObjectByCardId,
                  cardById: mergeLiveWins(buildById(allCards, 'card_id'), prev.cardById),
                  commentById: mergeLiveWins(
                    buildById(allComments, 'comment_id'),
                    prev.commentById
                  ),
                };
                // …then overlay every live board-object (current-board first-paint
                // rows + any realtime edits) so live state wins over the snapshot
                // across all four derived board-object maps.
                for (const boardObject of prev.boardObjectById.values()) {
                  next = upsertBoardObjectInMaps(next, boardObject, 'patch');
                }
                return next;
              })
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
    setMaps(EMPTY_MAPS);
    setHasInitiallyFetched(false);
  }, [client]);

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
      liveWriteRevisionRef.current += 1;
      setMaps((prev) => upsertBoardObjectInMaps(prev, boardObject, 'create'));
    };
    const handleBoardObjectPatched = (boardObject: BoardEntityObject) => {
      liveWriteRevisionRef.current += 1;
      setMaps((prev) => upsertBoardObjectInMaps(prev, boardObject, 'patch'));
    };
    const handleBoardObjectRemoved = (boardObject: BoardEntityObject) => {
      liveWriteRevisionRef.current += 1;
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
      if (branch.archived) {
        evictBranchAndSessions(branch.branch_id);
        return;
      }

      setBranchById((prev) => replaceIfChanged(prev, branch.branch_id, branch));
    };
    const handleBranchRemoved = (branch: Branch) => {
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
      liveWriteRevisionRef.current += 1;
      setMcpServerById((prev) => {
        if (prev.has(server.mcp_server_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(server.mcp_server_id, server);
        return next;
      });
    };
    const handleMCPServerPatched = (server: MCPServer) => {
      liveWriteRevisionRef.current += 1;
      setMcpServerById((prev) => replaceIfChanged(prev, server.mcp_server_id, server));
    };
    const handleMCPServerRemoved = (server: MCPServer) => {
      liveWriteRevisionRef.current += 1;
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
      liveWriteRevisionRef.current += 1;
      setGatewayChannelById((prev) => {
        if (prev.has(channel.id)) return prev;
        const next = new Map(prev);
        next.set(channel.id, channel);
        return next;
      });
    };
    const handleGatewayChannelPatched = (channel: GatewayChannel) => {
      liveWriteRevisionRef.current += 1;
      setGatewayChannelById((prev) => replaceIfChanged(prev, channel.id, channel));
    };
    const handleGatewayChannelRemoved = (channel: GatewayChannel) => {
      liveWriteRevisionRef.current += 1;
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
      liveWriteRevisionRef.current += 1;
      setCardById((prev) => {
        if (prev.has(card.card_id)) return prev; // Duplicate event — bail.
        const next = new Map(prev);
        next.set(card.card_id, card);
        return next;
      });
    };
    const handleCardPatched = (card: CardWithType) => {
      liveWriteRevisionRef.current += 1;
      setCardById((prev) => replaceIfChanged(prev, card.card_id, card));
    };
    const handleCardRemoved = (card: CardWithType) => {
      liveWriteRevisionRef.current += 1;
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
      liveWriteRevisionRef.current += 1;
      setArtifactById((prev) => {
        if (prev.has(artifact.artifact_id)) return prev;
        const next = new Map(prev);
        next.set(artifact.artifact_id, artifact);
        return next;
      });
    };
    const handleArtifactPatched = (artifact: Artifact) => {
      liveWriteRevisionRef.current += 1;
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
      liveWriteRevisionRef.current += 1;
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
      liveWriteRevisionRef.current += 1;
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
      liveWriteRevisionRef.current += 1;
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
      liveWriteRevisionRef.current += 1;
      setCommentById((prev) => {
        if (prev.has(comment.comment_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(comment.comment_id, comment);
        return next;
      });
    };
    const handleCommentPatched = (comment: BoardComment) => {
      liveWriteRevisionRef.current += 1;
      setCommentById((prev) => replaceIfChanged(prev, comment.comment_id, comment));
    };
    const handleCommentRemoved = (comment: BoardComment) => {
      liveWriteRevisionRef.current += 1;
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
      liveWriteRevisionRef.current += 1;
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
      liveWriteRevisionRef.current += 1;
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
    // yet, fetchData hit a 401 that bubbled up — retry once a token refresh
    // lands. Without this, byId state stays stale until the next physical
    // reconnect or a page refresh. We gate on the latch so we don't refetch
    // 14 services on every routine token rotation.
    const handleTokensRefreshed = () => {
      if (!lastSilentFetchFailedRef.current) return;
      void refetchSilently();
    };
    window.addEventListener(TOKENS_REFRESHED_EVENT, handleTokensRefreshed);

    // Initial fetch (only once — WebSocket events keep us synced after that).
    // Kicked off AFTER every `.on()` above is attached so realtime
    // created/patched/removed events that fire while fetchData's requests are
    // in flight are captured (and bump liveWriteRevisionRef) instead of being
    // dropped in the gap between fetch-start and listener-attach.
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
