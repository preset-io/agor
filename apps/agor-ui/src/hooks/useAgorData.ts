// @ts-nocheck - Complex WebSocket event handling with dynamic types
/**
 * React hook for fetching and subscribing to Agor data
 *
 * Manages sessions, tasks, boards with real-time WebSocket updates.
 *
 * State ownership lives in the zustand store (`agorStore`); this hook is the
 * single DRIVER of that store — the fetch effect and socket subscriptions
 * dispatch store actions. It returns only load-state (`UseAgorDataResult`) and
 * subscribes narrowly to the store's load-state fields, so its owner re-renders
 * on load progress rather than on every entity patch; entity-map consumers
 * subscribe to the store directly via their own selectors. The realtime entity
 * reducers + index/merge helpers live in `../store/agorRealtimeActions` and
 * `../store/agorMaps`, and the background-hydration bookkeeping (per-collection
 * revision counters, generation tokens, `runHydration`) in
 * `../store/agorHydration`.
 */

import type {
  AgorClient,
  Board,
  BoardComment,
  Branch,
  CardType,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import {
  ARTIFACT_METADATA_LIST_FIELDS,
  ENTITY_PATH_SEGMENTS,
  findByShortIdPrefix,
  hasMinimumRole,
  PAGINATION,
  ROLES,
} from '@agor-live/client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  beginPartitionLoad,
  bumpFirstPaintMergeRevisions,
  bumpRevision,
  cancelAllHydrations,
  cancelAndFailAllHydrations,
  endPartitionLoad,
  type PartitionLoadFence,
  resetHydrationRevisions,
  runHydration,
  touchedIdsSince,
  touchedSince,
} from '../store/agorHydration';
import {
  buildById,
  buildSessionMaps,
  keepLiveWrites,
  type PartitionCollection,
} from '../store/agorMaps';
import * as realtime from '../store/agorRealtimeActions';
import { agorStore, shallow, useStoreWithEqualityFn } from '../store/agorStore';
import {
  claimBoardPartition,
  claimDisplayedBoardForResync,
  evictUnloadedBoards,
  getDisplayedBoardId,
  nextPartitionGeneration,
  partitionLoadMark,
  partitionLoadSince,
  partitionsLoadedSince,
  releaseResyncClaim,
  settleBoardPartition,
} from '../store/boardPartitions';
import {
  captureLoadLifetime,
  isLoadLifetimeCurrent,
  type LoadLifetime,
} from '../store/loadLifetime';
import {
  type OpenedTranscriptPrefetch,
  prefetchOpenedTranscript,
} from '../store/openedTranscriptPrefetch';
import {
  discardRealtimeNow,
  enqueueSessionPatch,
  flushRealtimeNow,
  setRealtimeAuthorityScope,
  tombstoneSession,
  untombstoneSession,
} from '../store/realtimeBatch';
import { holdRows, releaseStaleScopes } from '../store/retention';
import {
  BOARD_SCOPE_PREFIX,
  boardPartitionScope,
  boardScopeKey,
  type Coverage,
  replaceScope,
  withoutBoardPartitions,
} from '../store/scopeMerge';
import { resetSessionMcpLinks } from '../store/sessionMcpLinks';
import {
  fillOnDemand,
  MY_SESSIONS_GATED_LIMIT,
  mySessionsQuery,
  otherCommittedMembers,
  startUserScope,
  stopUserScope,
  userScopeRunGeneration,
} from '../store/userScope';
import { boardIdForSession } from '../utils/boardIdForSession';
import { createInitialLoadDebugTimer, isInitialLoadDebugEnabled } from '../utils/initialLoadDebug';
import { runLatestMCPOAuthStatusRequest } from '../utils/mcpOAuthAttempt';
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
// needed to paint — mcp-servers, gateway-channels, artifacts, and the
// oauth-status probe — are fetched in the BACKGROUND (see `fetchData`), and
// session↔MCP links per session on first need (`sessionMcpLinks`); none of
// them is here, so the gate never waits on them. Their realtime subscriptions are still attached immediately in the
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

// Every session list read that feeds the store is `lean: true`: rows omit the
// bulky single-session `custom_context` keys (LEAN_SESSION_LIST_OMITTED_CONTEXT_KEYS)
// and carry the `read_shape` marker, so `sessionById` holds summaries and must
// never be the source for those keys (see `DataMaps.sessionById`). The open
// session reads them from its full `sessions.get` (the reactive session /
// settings modal / zone trigger).

// Items the Home first paint gates on. Board objects and cards are only needed
// to paint a canvas, so Home does not read them at all; a board loads its own
// with its partition. Comments stay gated on every route: Home's "comments for
// you" rule scans them all.
const HOME_DEFERRED_ITEMS: ReadonlySet<InitialLoadItemKey> = new Set(['board-objects', 'cards']);
const ALL_INITIAL_LOAD_KEYS: readonly InitialLoadItemKey[] = INITIAL_LOAD_ITEMS.map(
  ({ key }) => key
);
const HOME_INITIAL_LOAD_KEYS: readonly InitialLoadItemKey[] = ALL_INITIAL_LOAD_KEYS.filter(
  (key) => !HOME_DEFERRED_ITEMS.has(key)
);

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

interface UseAgorDataResult {
  initialLoadItems: InitialLoadItem[];
  initialLoadComplete: boolean;
  loadingStage: InitialLoadingStage;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
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

// The mobile routes (`/m/board/<board_id>`, `/m/session/<session_id>`,
// `/m/comments/<board_id>`) live OUTSIDE the main entity route table
// (ENTITY_PATH_SEGMENTS) and use full ids rather than short ids, so
// `parseEntityPath` never matches them. Each still displays a single board at
// first paint, so match them here: a cold deep-link then resolves its board
// scope and triggers the targeted full-board `get`. Without this the load
// paints with no board scope and `board.objects` stays undefined until the
// board's partition loads.
const MOBILE_PATH_RE = /\/m\/(board|session|comments)\/([^/]+)/;

// Resolve the board the app will ACTUALLY display on first paint from the
// current URL, reusing the same slug/short-id resolvers `useUrlState` uses.
// First-paint scoping MUST target this board (never the stored one) so the
// displayed board renders fully. Returns null → caller falls back to a GLOBAL
// (unscoped) first paint, which is always correct:
//   - Home (`/`) or any non-entity path: no board shown.
//   - `/a/<artifact>/`: artifacts aren't in the gated light batch (they load
//     in the background), so the board can't be resolved synchronously here.
//   - Unresolvable / ambiguous short id or a board_id we can't chain to.
export function resolveDisplayedBoardId(
  pathname: string,
  boardById: Map<string, { board_id: string; slug?: string }>,
  branchById: Map<string, { branch_id: string; board_id?: string | null }>,
  sessionById: Map<
    string,
    { session_id: string; branch_id?: string; branch_board_id?: string | null }
  >
): string | null {
  const mobile = pathname.match(MOBILE_PATH_RE);
  if (mobile) {
    const [, mobileSegment, token] = mobile;
    if (mobileSegment === 'session') {
      // Mobile routes normally carry a full ID, but a cold responsive handoff
      // preserves the desktop short token until the targeted get heals it.
      const sessionId = sessionById.has(token)
        ? token
        : resolveSessionFromShortIdPure(token, sessionById);
      const session = sessionId ? sessionById.get(sessionId) : undefined;
      if (!session) return null;
      if (session.branch_board_id) return session.branch_board_id;
      const branchId = session.branch_id;
      return branchId ? (branchById.get(branchId)?.board_id ?? null) : null;
    }
    return resolveBoardFromUrlPure(token, boardById);
  }

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
export function useAgorData(
  client: AgorClient | null,
  options?: {
    enabled?: boolean;
    directSessionId?: string | null;
    /** Optional branch short/full ID from a direct `/w/` URL; fetched by ID when not loaded. */
    directBranchId?: string | null;
    /** Authenticated identity, independent from the privileged users directory. */
    authenticatedUserId?: string;
    /**
     * Role from the authenticated user response, not from the optional users
     * directory. Viewer bootstrap must decide whether member-only workspace
     * requests exist before attempting them; otherwise one expected 403 hides
     * the authenticated header and viewer-safe routes such as Marketplace.
     */
    authenticatedUserRole?: string;
    /** Successful socket authentication generation from useAgorClient. */
    authGeneration?: number;
    /** Socket is connected, authenticated, and outside a reauth transition. */
    connectionReady?: boolean;
  }
): UseAgorDataResult {
  const enabled = options?.enabled ?? true;
  const directSessionId = options?.directSessionId ?? null;
  const directBranchId = options?.directBranchId ?? null;
  // Preserve the hook's historical standalone-test/default behavior when the
  // caller does not provide role context. App always provides the property,
  // including `undefined` before auth resolves, and therefore fails closed.
  const hasAuthenticatedRoleContext = Object.hasOwn(options ?? {}, 'authenticatedUserRole');
  const canUseMemberWorkspaceServices =
    !hasAuthenticatedRoleContext || hasMinimumRole(options?.authenticatedUserRole, ROLES.MEMBER);
  const canListUsers = canUseMemberWorkspaceServices;
  const hasAuthorityContext =
    Object.hasOwn(options ?? {}, 'authenticatedUserId') ||
    Object.hasOwn(options ?? {}, 'authGeneration') ||
    Object.hasOwn(options ?? {}, 'connectionReady');
  const authenticatedUserId = options?.authenticatedUserId;
  const authGeneration = options?.authGeneration ?? 0;
  const connectionReady = options?.connectionReady ?? true;
  const identityRoleKey =
    authenticatedUserId && options?.authenticatedUserRole
      ? `${authenticatedUserId}:${options.authenticatedUserRole}`
      : null;
  // A role/identity value can render before the socket has authenticated the
  // replacement token. Remember the last pair proven by a ready connection;
  // changing that pair requires a strictly newer auth generation. Demotions
  // therefore fail closed immediately, while promotions cannot issue a
  // viewer-era request merely because React observed the refreshed user first.
  const establishedAuthorityRef = useRef<{
    client: AgorClient;
    identityRoleKey: string;
    authGeneration: number;
  } | null>(null);
  const establishedAuthority = establishedAuthorityRef.current;
  const authorityMatchesEstablished =
    !!establishedAuthority &&
    establishedAuthority.client === client &&
    establishedAuthority.identityRoleKey === identityRoleKey &&
    authGeneration >= establishedAuthority.authGeneration;
  const authorityHasNewAuthentication =
    !establishedAuthority || authGeneration > establishedAuthority.authGeneration;
  const authorityIsEstablished =
    !hasAuthorityContext ||
    (!!client &&
      connectionReady &&
      !!identityRoleKey &&
      (authorityMatchesEstablished || authorityHasNewAuthentication));
  const authorityScopeKey =
    client &&
    enabled &&
    authorityIsEstablished &&
    (!hasAuthorityContext || (authenticatedUserId && options?.authenticatedUserRole))
      ? `${authenticatedUserId ?? '__standalone__'}:${options?.authenticatedUserRole ?? '__standalone__'}:${authGeneration}`
      : null;
  // Render-time update closes the window before transition effects run: every
  // asynchronous apply below compares its captured scope against this value.
  const authorityScopeKeyRef = useRef(authorityScopeKey);
  authorityScopeKeyRef.current = authorityScopeKey;

  // Advance the singleton realtime queue in the layout phase. React runs this
  // before the authority-transition map reset below and before the previous
  // subscription's passive cleanup, so that cleanup cannot flush a queued row
  // from the previous identity/role/auth generation into the replacement
  // authority's store. Socket callbacks also consult this scope synchronously,
  // closing the short layout→passive-cleanup listener overlap.
  useLayoutEffect(() => {
    setRealtimeAuthorityScope(authorityScopeKey);
  }, [authorityScopeKey]);

  // On a true owner unmount, discard rather than preserve a final frame. The
  // subscription cleanup cannot distinguish unmount from a same-authority
  // resubscribe, while layout cleanup ordering can: it runs first and makes the
  // later scoped flush a no-op.
  useLayoutEffect(() => () => setRealtimeAuthorityScope(null), []);

  useLayoutEffect(() => {
    if (!hasAuthorityContext || !client || !connectionReady || !identityRoleKey) return;
    if (!authorityIsEstablished) return;
    establishedAuthorityRef.current = { client, identityRoleKey, authGeneration };
  }, [
    authGeneration,
    authorityIsEstablished,
    client,
    connectionReady,
    hasAuthorityContext,
    identityRoleKey,
  ]);

  // Reset the shared singleton store once per hook (re)mount, synchronously
  // BEFORE the first store-subscription read below. This mirrors the old per-mount
  // `useState(EMPTY_MAPS)` / `useState(true)` semantics: the store is a module
  // singleton (so a remount — and each test's `renderHook` — would otherwise
  // inherit stale state), and `useAgorData` is its sole owner (mounted once in
  // App.tsx). The `useState` initializer runs exactly once per instance.
  //
  // `resetHydrationRevisions()` zeroes the per-collection live-write baseline
  // (fresh-`useRef` semantics); `cancelAllHydrations()` supersedes any straggler
  // loop from a prior mount of the singleton (generations stay monotonic so a
  // stale loop can never collide with this instance's fresh generation).
  useState(() => {
    agorStore.getState().reset();
    resetHydrationRevisions();
    cancelAllHydrations();
    // Drop any straggler frame-batched patches from a prior mount of the
    // singleton so they can't flush into this instance's fresh store.
    discardRealtimeNow();
    return null;
  });

  // Narrow selective subscription so the bootstrap owner re-renders only on a
  // load-state change — not on every entity patch. The fetch effect and socket
  // subscriptions still drive the full store; map consumers subscribe to it via
  // their own `useAgorStore` selectors, and the few reads in this hook that need
  // an entity map reach for it imperatively through `agorStore.getState()`.
  const storeState = useStoreWithEqualityFn(
    agorStore,
    (s) => ({
      loadingStage: s.loadingStage,
      loading: s.loading,
      error: s.error,
      itemCounts: s.itemCounts,
    }),
    shallow
  );

  // Track if we've done initial fetch. The initial fetch happens once on mount;
  // socket reconnects after that re-trigger fetchData() to recover any events
  // that fired while disconnected (Feathers real-time events are fire-and-forget
  // — there's no replay log, so a reconnect with no re-fetch leaves the byId
  // maps stale until manual page refresh).
  const [hasInitiallyFetched, setHasInitiallyFetched] = useState(false);

  // The gated items of the current first-paint load. Home gates on fewer
  // items than a board route (see HOME_DEFERRED_ITEMS).
  const [initialLoadPlan, setInitialLoadPlan] =
    useState<readonly InitialLoadItemKey[]>(ALL_INITIAL_LOAD_KEYS);

  // Single-flight guard for reconnect-triggered refetches. Prevents stampedes
  // when the socket flaps (e.g. waking from sleep on a flaky network). The
  // authority key prevents an older identity's flight from blocking the next.
  const refetchInflightRef = useRef<string | null>(null);

  // Tracks whether the most recent silent refetch failed. Set by the silent
  // catch branch in `fetchData`, cleared on success. Read by the
  // TOKENS_REFRESHED_EVENT listener below so a token replacement that lands
  // AFTER a failed reconnect refetch (for example a transient daemon failure) gets to
  // retry — without this, the byId maps would stay stale until the next
  // physical reconnect or page refresh. We use a ref rather than state since
  // we only consume it in event handlers, never in render.
  const lastSilentFetchFailedRef = useRef(false);
  // Boards an authority transition unloaded (a disconnect forgets every
  // partition). Their rows may have missed deletions, archives or revoked
  // access meanwhile: the next resync evicts them unless loaded again.
  const transitionUnloadedBoardsRef = useRef(new Set<string>());
  const oauthStatusRequestGenerationRef = useRef(0);

  // The opened session's transcript prefetch (see `openedTranscriptPrefetch`).
  // Released early whenever hydrations are cancelled wholesale.
  const openedTranscriptPrefetchRef = useRef<OpenedTranscriptPrefetch | null>(null);
  const releaseOpenedTranscriptPrefetch = useCallback(() => {
    openedTranscriptPrefetchRef.current?.release();
    openedTranscriptPrefetchRef.current = null;
  }, []);

  /**
   * One latest-request-wins coordinator for initial hydration and
   * realtime OAuth hints. A later request invalidates every earlier response,
   * preventing an old read from overwriting a newer disconnect/re-auth result.
   * Like a load, a response is also dropped once the hydration cancellation
   * epoch moves (unmount, authority change, logout): an unmount leaves
   * `authorityScopeKeyRef` as it was, so the scope check alone would let a
   * late answer write one user's OAuth grants into the next user's store.
   */
  const refetchOAuthDurableState = useCallback(
    async (requestAuthorityScope: string, mcpServerId?: string): Promise<boolean> => {
      if (!client) return false;
      const requestLifetime = captureLoadLifetime(requestAuthorityScope);
      return runLatestMCPOAuthStatusRequest(
        oauthStatusRequestGenerationRef,
        async () => {
          const [status, freshServer] = await Promise.all([
            client.service('mcp-servers/oauth-status').find(),
            mcpServerId
              ? client.service('mcp-servers').get(mcpServerId)
              : Promise.resolve(undefined),
          ]);
          return { status, freshServer };
        },
        () =>
          !!requestLifetime && isLoadLifetimeCurrent(requestLifetime, authorityScopeKeyRef.current),
        ({ status, freshServer }) => {
          const ids =
            (status as { authenticated_server_ids?: string[] })?.authenticated_server_ids ?? [];
          agorStore.getState().applyMaps((prev) => {
            const deleted = agorStore.getState().deletedMcpServerIds;
            const authenticated = new Set(ids.filter((id) => !deleted.has(id)));
            if (!freshServer || deleted.has(freshServer.mcp_server_id)) {
              return { ...prev, userAuthenticatedMcpServerIds: authenticated };
            }
            const mcpServerById = new Map(prev.mcpServerById);
            mcpServerById.set(freshServer.mcp_server_id, freshServer);
            return { ...prev, userAuthenticatedMcpServerIds: authenticated, mcpServerById };
          });
        }
      );
    },
    [client]
  );

  // Fetch all data
  //
  // `silent: true` is used by background refetches (e.g. socket reconnect) that
  // must not flip the global `loading` / `error` state — those are wired to the
  // fullscreen "Connecting to daemon..." spinner and "Failed to load data"
  // alert in App.tsx, which would be wildly disruptive if a transient
  // reconnect-time error
  // bubbled up. Silent failures are logged for observability; the UI continues
  // to render whatever byId state was last successfully fetched, and the next
  // reconnect or token replacement gets another shot.
  const fetchData = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const fetchAuthorityScope = authorityScopeKey;
      if (!client || !enabled || !fetchAuthorityScope) {
        return false;
      }
      // Load-lifetime cancellation token, captured BEFORE the first await.
      // Every cancellation path (unmount, authority change, logout) bumps the
      // hydration epoch, and an unmount leaves `authorityScopeKeyRef` as it
      // was — so the scope check alone would let a load suspended in the
      // light/heavy batch resume after teardown, retain a transcript prefetch,
      // repopulate the singleton store and start deferred hydrations.
      // The scope and the partition record carry this same lifetime, never
      // whatever authority is current when they run (a remount can swap it).
      const loadLifetime = captureLoadLifetime(fetchAuthorityScope) as LoadLifetime;
      const authorityIsCurrent = () =>
        isLoadLifetimeCurrent(loadLifetime, authorityScopeKeyRef.current);
      const runAuthorityHydration = (
        name: string,
        revisions: Parameters<typeof runHydration>[1],
        fetcher: () => Promise<unknown>,
        apply: (value: unknown) => void
      ) =>
        runHydration(name, revisions, fetcher, (value) => {
          if (authorityIsCurrent()) apply(value);
        });

      const debugTimer =
        !silent && isInitialLoadDebugEnabled()
          ? createInitialLoadDebugTimer(INITIAL_LOAD_ITEMS)
          : null;
      let debugFinishStatus: 'success' | 'error' | null = null;
      let debugFinishError: unknown;
      // Per-id touched fence for the wholesale first-paint/resync apply below:
      // realtime events keep landing while this load is in flight, and the
      // apply must keep them (a created row, a patch, a removal) rather than
      // replace them with the older snapshot. Released in `finally`.
      const firstPaintFence = beginPartitionLoad();
      // A resync after an authority transition (every board unloaded) claims
      // the displayed board so its partition hook doesn't read it a second
      // time; the apply below settles it, `finally` releases it otherwise.
      // Partition loads started after this mark postdate the resync, so it
      // can reuse one for its board (see `inflightBoardPartitionLoad`).
      const partitionMark = partitionLoadMark();
      const resyncClaim = silent ? claimDisplayedBoardForResync(loadLifetime) : null;
      // The generation this load settles the displayed board's partition
      // under (the claim's, when it holds one).
      const boardGeneration = resyncClaim?.generation ?? nextPartitionGeneration();
      // The displayed board, once resolved: claimed and fenced from there.
      let boardClaim: { boardId: string; generation: number } | null = null;
      let boardFence: PartitionLoadFence | null = null;

      try {
        if (!silent) {
          agorStore.getState().setLoading(true);
          agorStore.getState().setLoadingStage('fetching');
          debugTimer?.markStage('fetching');
          agorStore.getState().setError(null);
          agorStore.getState().setItemCounts({});
          setInitialLoadPlan(ALL_INITIAL_LOAD_KEYS);
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
            if (!silent && authorityIsCurrent())
              agorStore.getState().setItemCounts((prev) => ({ ...prev, [key]: r.length }));
            return r;
          });
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
        // gate ignores them. We apply through the store's `applyMaps` (not the
        // per-entity setters), keeping fetchData's deps stable so the subscribe
        // effect doesn't re-fire.
        // Route the full snapshot through the shared skip-apply-on-race / generation
        // lifecycle (like mcp-servers / gateway-channels) so an older snapshot can't
        // clobber a newer realtime upsert, and a fetch resolving after logout is
        // dropped instead of repopulating the previous tenant. The apply sets the
        // hydration gate, so it only flips once a quiet, current snapshot lands.
        void runAuthorityHydration(
          'agentic-tool-settings',
          ['agenticToolSettings'],
          () => client.service('agentic-tool-settings').findAll(),
          (settings) => agorStore.getState().setAgenticToolSettings(settings)
        );

        void runAuthorityHydration(
          'mcp-servers',
          ['mcpServers'],
          () =>
            client.service('mcp-servers').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          (list) => {
            agorStore.getState().applyMaps((prev) => ({
              ...prev,
              mcpServerById: buildById(list, 'mcp_server_id', prev.mcpServerById),
            }));
            agorStore.getState().markHydrated('mcpServersHydrated');
          }
        );
        // Session↔MCP links are not read here: each session's load on first
        // need (`sessionMcpLinks`). A resync may have missed link events, so
        // every session counts as unloaded again and mounted readers reload.
        if (silent) resetSessionMcpLinks();
        void runAuthorityHydration(
          'gateway-channels',
          ['gatewayChannels'],
          () =>
            client
              .service('gateway-channels')
              .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          (list) => {
            agorStore.getState().applyMaps((prev) => ({
              ...prev,
              gatewayChannelById: buildById(list, 'id', prev.gatewayChannelById),
            }));
            agorStore.getState().markHydrated('gatewayChannelsHydrated');
          }
        );
        void runAuthorityHydration(
          'artifacts',
          ['artifacts'],
          () =>
            client.service('artifacts').findAll({
              query: {
                $limit: PAGINATION.DEFAULT_LIMIT,
                $select: [...ARTIFACT_METADATA_LIST_FIELDS],
              },
            }),
          (list) =>
            agorStore.getState().applyMaps((prev) => ({
              ...prev,
              artifactById: buildById(list, 'artifact_id', prev.artifactById),
            }))
        );
        void refetchOAuthDurableState(fetchAuthorityScope);

        // ── Essential gated fetches — LIGHT batch ───────────────────────
        // Tiny global collections (boards / users / repos / card-types stay
        // global — bounded and small) plus a BOUNDED page of my sessions.
        // Awaited first so we can resolve the first-paint board scope BEFORE the
        // board-scoped heavy batch. Sessions and branches are never read in
        // full: the displayed board's load with it, and the user scope reads
        // the rest of mine after paint (`userScope`).
        debugTimer?.startFetchPhase();
        // Set when the gated page of MY sessions returned fewer rows than its
        // limit, i.e. it already holds every active session I created.
        let gatedMineComplete = false;
        const [sessionsList, boardsList, cardTypesList, reposList, usersList] = await Promise.all([
          track(
            'sessions',
            !silent && authenticatedUserId
              ? // My newest sessions (user scope), served from
                // SQL by `created_by`: correct however busy the rest of the
                // workspace is. One page via find() (findAll would walk every
                // page). The rest of mine load right after paint (`userScope`).
                client
                  .service('sessions')
                  .find({ query: mySessionsQuery(authenticatedUserId, MY_SESSIONS_GATED_LIMIT) })
                  .then((result) => {
                    const rows = (Array.isArray(result) ? result : result.data) as Session[];
                    gatedMineComplete = rows.length < MY_SESSIONS_GATED_LIMIT;
                    return rows;
                  })
                  .catch((err) => {
                    // Non-fatal: U1 reads every session of mine after paint.
                    console.warn('[useAgorData] my-sessions page failed:', err);
                    return [] as Session[];
                  })
              : // A resync: the user scope's U1 and the displayed board read them.
                Promise.resolve([] as Session[])
          ),
          track(
            'boards',
            // LEAN list — omit each board's heavy `objects` / `custom_css`
            // annotations (68% of the boards payload — only the displayed board
            // needs them to paint). Metadata still covers the switcher, Home,
            // and `resolveDisplayedBoardId` scope resolution. The displayed
            // board's full record is fetched below, also on a reconnect resync
            // (its zones never flash off); other boards' records load with
            // their partition.
            client.service('boards').findAll({
              query: { lean: true, $limit: PAGINATION.DEFAULT_LIMIT },
            })
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
            canListUsers
              ? client.service('users').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } })
              : Promise.resolve([])
          ),
        ]);
        if (!authorityIsCurrent()) return false;

        // Branches healed into first paint by a `/w/<id>` branch link. They seed `branchById`
        // ahead of the board-scoped branch fetch so the displayed board can be
        // resolved and its target card paints immediately.
        const healedBranches: Branch[] = [];

        // Direct /s/<id>/ opens should work for archived sessions without broadening
        // the gated page. If it missed the URL target, fetch just that
        // session by ID/short ID. Do not await a separate branches.get here:
        // sessions carry branch_board_id for board resolution, and the scoped
        // branch batch below loads active branches. Optional branch enrichment
        // must not block session first paint.
        if (
          directSessionId &&
          !silent &&
          !hasIdMatchingPrefix(directSessionId, sessionsList, (s) => s.session_id)
        ) {
          try {
            const directSession = (await client
              .service('sessions')
              .get(directSessionId)) as Session;
            if (!sessionsList.some((s) => s.session_id === directSession.session_id)) {
              sessionsList.push(directSession);
            }
          } catch {
            // Leave normal URL resolution to report/not-heal unresolved session links.
          }
        }

        // The board the app will ACTUALLY display, resolved from the current URL
        // with the same slug/short-id resolvers `useUrlState` uses (NOT
        // localStorage — the displayed board can differ from the stored one, e.g.
        // a `/b/<other>/` deep link). undefined → no board scope, always
        // correct: Home, `/a/` artifact links, or any unresolvable target.
        // A silent reconnect resyncs the displayed board's partition in place.
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

        // A session route: start its transcript now, concurrently with the
        // board-scoped batch, and hold the user scope's bulk U1 read until its
        // first page lands (below).
        const openedSessionId =
          !silent && directSessionId
            ? resolveSessionFromShortIdPure(directSessionId, interimSessionById)
            : null;
        let openedTranscriptReady: Promise<void> | null = null;
        // The direct-session get above awaited; never retain after teardown.
        if (!authorityIsCurrent()) return false;
        if (openedSessionId) {
          // Retain before releasing any earlier prefetch: for the same session
          // the shared handle stays warm instead of dropping to zero refs.
          const previous = openedTranscriptPrefetchRef.current;
          const prefetch = prefetchOpenedTranscript(client, openedSessionId);
          openedTranscriptPrefetchRef.current = prefetch;
          previous?.release();
          openedTranscriptReady = prefetch.ready;
        }

        // A reconnect resync reconciles the board the UI actually displays
        // (`useBoardPartition` registers it: artifact routes and the mobile
        // shell's fallbacks resolve boards the URL alone can't) in place, and
        // unloads every other board (below). First paint runs before the UI
        // mounts, so it resolves from the URL.
        const displayedBoardId = silent ? getDisplayedBoardId() : undefined;
        const boardScope =
          (displayedBoardId && boardsMap.has(displayedBoardId) ? displayedBoardId : null) ??
          resolveDisplayedBoardId(
            pathname,
            boardsMap,
            silent ? agorStore.getState().branchById : interimBranchById,
            interimSessionById
          ) ??
          undefined;
        // No displayed board (Home): board objects and cards are not read.
        const deferAnnotations = !boardScope;
        if (deferAnnotations && !silent) setInitialLoadPlan(HOME_INITIAL_LOAD_KEYS);
        // The UI navigated to this board while the resync ran (its light
        // batch): the board's own partition load, started after the resync,
        // reconciles it. Await (or reuse) that load rather than read the board
        // twice.
        const reusedPartitionLoad =
          silent && boardScope
            ? partitionLoadSince(boardScope, loadLifetime, partitionMark)
            : undefined;
        const readBoardAnnotations = !!boardScope && !reusedPartitionLoad;
        // Claim the board before reading it, and fence its rows from here: a
        // live row on it is admitted from now on (`admitHeld`) and keeps its
        // live value, while one rejected before the claim (the board wasn't
        // known yet) is not touched for this fence, so the snapshot restores it.
        if (boardScope && !reusedPartitionLoad) {
          boardClaim = claimBoardPartition(boardScope, loadLifetime);
          boardFence = beginPartitionLoad();
        }

        // ── Essential gated fetches — HEAVY + board-scoped batch ────────
        // Scoped to the displayed board when resolved (board_id pushes to SQL
        // for sessions / board-objects; cards filter it server-side). On a real
        // workspace this trims thousands of rows to one board's. A reconnect
        // resync reads the board's rows like first paint does.
        const [
          branchesList,
          boardSessionsList,
          boardObjectsList,
          commentsList,
          cardsList,
          displayedBoardFull,
        ] = await Promise.all([
          track(
            'branches',
            boardScope
              ? client.service('branches').findAll({
                  query: {
                    archived: false,
                    board_id: boardScope,
                    $limit: PAGINATION.DEFAULT_LIMIT,
                  },
                })
              : Promise.resolve([] as Branch[])
          ),
          // Board-scoped sessions: only when a board is displayed. Merged with
          // my sessions below. Not tracked — not part of the loading checklist.
          boardScope
            ? client.service('sessions').findAll({
                query: {
                  archived: false,
                  board_id: boardScope,
                  lean: true,
                  $limit: PAGINATION.DEFAULT_LIMIT,
                  $sort: { updated_at: -1 },
                },
              })
            : Promise.resolve([] as Session[]),
          !readBoardAnnotations
            ? Promise.resolve(null)
            : track(
                'board-objects',
                // The daemon intentionally keeps the whole board-objects service at
                // the MEMBER floor (the rows carry editable canvas layout). A global
                // viewer can still read the workspace shell and Marketplace, so an
                // expected authorization failure here is not an essential bootstrap
                // failure. Keep the collection empty and don't subscribe below.
                canUseMemberWorkspaceServices
                  ? client.service('board-objects').findAll({
                      query: { $limit: PAGINATION.DEFAULT_LIMIT, board_id: boardScope },
                    })
                  : Promise.resolve([])
              ),
          // Comments are GLOBAL and gated on every route: Home's comment rule
          // and the mobile bell scan them all, so they are never board-scoped.
          track(
            'board-comments',
            client
              .service('board-comments')
              .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } })
          ),
          !readBoardAnnotations
            ? Promise.resolve(null)
            : track(
                'cards',
                client.service('cards').findAll({
                  query: { $limit: PAGINATION.DEFAULT_LIMIT, board_id: boardScope },
                })
              ),
          // Displayed board's FULL record (with objects/custom_css) so its
          // zones/text/markdown paint at first load — the boards list above is
          // lean. Only when a board is actually displayed (also on a reconnect).
          // Not tracked — not a loading-checklist item.
          readBoardAnnotations && boardScope
            ? // A failed get degrades gracefully rather than blocking first paint:
              // the board is then not marked loaded, and its partition load
              // fetches the record again.
              (client.service('boards').get(boardScope) as Promise<Board>).catch(() => null)
            : Promise.resolve(null),
          // Settles (applied, dropped or failed); never rejects.
          reusedPartitionLoad,
        ]);
        if (!authorityIsCurrent()) return false;
        debugTimer?.endFetchPhase();

        if (!silent) {
          agorStore.getState().setLoadingStage('indexing');
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
        if (!authorityIsCurrent()) return false;

        // Queued streaming patches are live writes too: apply them now so the
        // touched overlay below sees them in the store, not only in the queue.
        flushRealtimeNow(fetchAuthorityScope);
        const live = agorStore.getState();
        const touchedSinceLoad = (collection: Parameters<typeof touchedIdsSince>[0]) =>
          touchedIdsSince(collection, firstPaintFence.startRevisions[collection]);
        // A branch touched during the load and absent now was archived or
        // removed meanwhile: rows on it are dropped with it.
        const removedBranchIds = new Set(
          touchedSinceLoad('branches').filter((id) => !live.branchById.has(id))
        );
        // Build comment Map for efficient lookups (always the global set)
        const commentsMap = new Map<string, BoardComment>();
        for (const comment of commentsList) {
          commentsMap.set(comment.comment_id, comment);
        }
        keepLiveWrites(commentsMap, live.commentById, touchedSinceLoad('comments'));

        // Replace the displayed board's LEAN row with its FULL record so the
        // visible canvas paints zones/text/markdown at first paint (no flash).
        // Other boards stay lean until their partition loads.
        if (displayedBoardFull) {
          boardsMap.set(displayedBoardFull.board_id, displayedBoardFull);
        } else if (boardScope && live.boardById.has(boardScope)) {
          // The get failed: keep the board's current record rather than its
          // lean row (no zone flash); its partition load fetches it again.
          boardsMap.set(boardScope, live.boardById.get(boardScope)!);
        }
        // Boards whose partition load started after this resync (opened while
        // it ran) stay loaded across its reset below: their reads already
        // postdate it. Keep their full records over the lean rows.
        const sparedBoardIds = silent ? partitionsLoadedSince(loadLifetime, partitionMark) : [];
        for (const boardId of sparedBoardIds) {
          const record = live.boardById.get(boardId);
          if (record && boardsMap.has(boardId) && boardId !== displayedBoardFull?.board_id) {
            boardsMap.set(boardId, record);
          }
        }
        keepLiveWrites(boardsMap, live.boardById, touchedSinceLoad('boards'));

        // Merge my sessions with the board-scoped sessions (dedup by id) for
        // first paint, then build both session lookups (incl. remote
        // surrogates).
        const firstPaintSessions = new Map<string, Session>();
        for (const session of sessionsList) {
          firstPaintSessions.set(session.session_id, session);
        }
        for (const session of boardSessionsList) {
          if (!firstPaintSessions.has(session.session_id)) {
            firstPaintSessions.set(session.session_id, session);
          }
        }
        const touchedSessionIds = touchedSinceLoad('sessions');
        keepLiveWrites(firstPaintSessions, live.sessionById, touchedSessionIds);
        for (const [id, session] of firstPaintSessions) {
          if (removedBranchIds.has(session.branch_id)) firstPaintSessions.delete(id);
        }
        // The gated page proves "all of mine" only if no session of mine was
        // created or removed while it was in flight; otherwise U1 runs.
        if (gatedMineComplete) {
          const gatedPage = new Set(sessionsList.map((session) => session.session_id));
          gatedMineComplete = !touchedSessionIds.some((id) => {
            const row = live.sessionById.get(id);
            return row
              ? row.created_by === authenticatedUserId && !gatedPage.has(id)
              : gatedPage.has(id);
          });
        }
        const { sessionById: sessionsById, sessionsByBranch: sessionsByBranchId } =
          buildSessionMaps([...firstPaintSessions.values()]);

        // Branch map for first paint: the board-scoped set, plus any
        // deep-link-healed branches.
        const branchesMap = new Map<string, Branch>();
        for (const branch of branchesList) {
          branchesMap.set(branch.branch_id, branch);
        }
        for (const branch of healedBranches) {
          if (!branchesMap.has(branch.branch_id)) {
            branchesMap.set(branch.branch_id, branch);
          }
        }
        keepLiveWrites(branchesMap, live.branchById, touchedSinceLoad('branches'));

        // Merge the essential slices in one atomic update. We spread `prev`
        // (rather than replacing the whole object) so the BACKGROUND-managed
        // slices — mcpServerById / gatewayChannelById / artifactById /
        // userAuthenticatedMcpServerIds — survive even if their fire-and-forget
        // fetches resolved before this gate did, and so do the per-session
        // `sessionMcpServerIds`. Those slices are owned by their own loaders
        // and the realtime handlers.
        // A reconnect unloads every board: their rows may have missed
        // deletions while disconnected, and their next partition load
        // reconciles them. The displayed board is reconciled right here.
        // Boards loaded after this resync started (a reused partition load
        // among them) are already reconciled: they stay loaded. The reset
        // publishes with the rows and the displayed board's settle below, so
        // no update shows the board unloaded or its rows without coverage.
        // The boards the reset unloads lose their rows once the user scope
        // is replaced (below).
        let unloadedBoardIds: string[] = [];
        const resetCoverage = (coverage: Coverage) => {
          if (!silent) return coverage;
          const next = withoutBoardPartitions(coverage, sparedBoardIds);
          unloadedBoardIds = [...coverage.keys()]
            .filter((key) => key.startsWith(BOARD_SCOPE_PREFIX) && !next.has(key))
            .map((key) => key.slice(BOARD_SCOPE_PREFIX.length));
          return next;
        };
        // The displayed board reconciles (`replaceScope`, fenced like
        // everything above): rows written live during this load keep their
        // live value, and rows the board no longer has (deleted, moved or
        // hidden while disconnected) leave unless another scope's committed
        // membership holds them. Other boards' rows are untouched (Home reads
        // none).
        const boardStart = (boardFence ?? firstPaintFence).startRevisions;
        const touchedInLoad = (collection: PartitionCollection, id: string) =>
          touchedSince(collection, id, boardStart[collection]);
        // The displayed board's read (every query an unbounded `findAll`). It
        // reconciles the board and, when the full record arrived, settles its
        // partition in the same update, with this membership.
        const boardRows =
          boardScope && !reusedPartitionLoad
            ? {
                branches: branchesList.filter((branch) => branch.board_id === boardScope),
                sessions: boardSessionsList.filter(
                  (session) => boardIdForSession(session, branchesMap) === boardScope
                ),
                boardObjects: canUseMemberWorkspaceServices ? (boardObjectsList ?? []) : null,
                cards: cardsList ?? [],
                complete: true,
              }
            : null;
        const settleDisplayed =
          boardScope && boardRows && displayedBoardFull && isLoadLifetimeCurrent(loadLifetime)
            ? settleBoardPartition(
                boardScope,
                loadLifetime,
                boardClaim?.generation ?? boardGeneration,
                boardRows,
                boardStart
              )
            : undefined;
        agorStore.getState().applyMaps(
          (prev) => {
            const maps = {
              ...prev,
              // A resync keeps the session and branch sets: the displayed
              // board's replace below and the user scope's reconcile the rows
              // they claim.
              ...(silent
                ? {}
                : {
                    sessionById: sessionsById,
                    sessionsByBranch: sessionsByBranchId,
                    branchById: branchesMap,
                  }),
              boardById: boardsMap,
              commentById: commentsMap,
              cardTypeById: cardTypesMap,
              repoById: reposMap,
              userById: usersMap,
            };
            if (!boardScope || !boardRows) return maps;
            const state = agorStore.getState();
            return replaceScope(
              maps,
              boardPartitionScope(boardScope),
              boardRows,
              touchedInLoad,
              otherCommittedMembers(
                { ...state, ...maps, coverage: resetCoverage(state.coverage) },
                boardScopeKey(boardScope)
              )
            );
          },
          (maps, coverage) =>
            settleDisplayed
              ? settleDisplayed(maps, resetCoverage(coverage))
              : resetCoverage(coverage),
          silent
            ? (_maps, state) => ({
                // The reset orphans partition loads in flight (`partitionEpoch`).
                partitionEpoch: state.partitionEpoch + 1,
              })
            : undefined
        );
        // This wholesale replace is NOT a `runHydration` apply, so it must bump
        // the revisions of every collection it overwrites — exactly like the
        // per-mutation realtime handlers do. Critical on the SILENT reconnect
        // resync: an in-flight hydration whose snapshot predates the disconnect
        // would otherwise pass its quiet check and clobber this newer reconnect
        // snapshot (resurrecting data that changed while we were disconnected).
        bumpFirstPaintMergeRevisions();
        // User scope: the rest of my sessions, my branches, every
        // teammate I can view, and the branches my sessions and comment
        // threads reference. On a session route only its bulk U1 read is held
        // behind the opened transcript: Home and the teammate surfaces must
        // not wait for a transcript. Starting after first paint
        // keeps the small reads behind the transcript's stream/get/tasks reads
        // (sent with the board-scoped batch); only its messages page, which
        // needs the tasks response, can follow them. Re-run as a replace on
        // every silent resync so the scope reconciles anything missed while
        // disconnected.
        let userScopeSettled: Promise<void> | null = null;
        if (authenticatedUserId) {
          userScopeSettled = startUserScope(client, {
            userId: authenticatedUserId,
            lifetime: loadLifetime,
            gatedMineComplete: !silent && gatedMineComplete,
            // A resync reconciles the scope: rows deleted, archived or moved
            // out while disconnected leave.
            replace: silent,
            // On a session route only the bulk U1 read waits for the opened
            // transcript (up to 10,000 rows could queue ahead of its first
            // messages page); Home has no transcript, and small reads stay early.
            deferBulkRead: openedTranscriptReady ?? undefined,
          });
        }
        // The run just started (`startUserScope` sets it synchronously).
        const userScopeRun = userScopeRunGeneration();
        // Retention, once the user scope is replaced under this lifetime (so
        // my rows stay): the rows of the boards this resync unloaded leave
        // unless a scope holds them — a board displayed or loaded again
        // meanwhile keeps its rows — and so do the scopes this load didn't
        // replace (a failed read: an earlier lifetime's, or an earlier run's
        // after a plain reconnect), with the rows only they held.
        void (userScopeSettled ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => {
            if (!authorityIsCurrent()) return;
            const displayed = getDisplayedBoardId();
            const transitionUnloaded = [...transitionUnloadedBoardsRef.current];
            transitionUnloadedBoardsRef.current.clear();
            evictUnloadedBoards(
              [...unloadedBoardIds, ...transitionUnloaded].filter(
                (id) => id !== boardScope && id !== displayed
              )
            );
            releaseStaleScopes(userScopeRun);
          });

        debugTimer?.endIndexing();
        debugFinishStatus = 'success';

        // Silent refetch succeeded — clear the retry flag so future token
        // refreshes don't trigger another wasted re-fetch.
        if (silent) {
          lastSilentFetchFailedRef.current = false;
        }
        return true;
      } catch (err) {
        if (!authorityIsCurrent()) return false;
        if (silent) {
          // Background refetch failed (e.g. transient 401 racing an authenticated
          // reconnect, or a 5xx). Don't escalate to the fullscreen error overlay —
          // we still have last-known good byId state on screen. Latch the
          // failure so the next TOKENS_REFRESHED_EVENT (or reconnect) retries.
          console.warn('[useAgorData] silent refetch failed:', err);
          lastSilentFetchFailedRef.current = true;
        } else {
          debugFinishStatus = 'error';
          debugFinishError = err;
          agorStore
            .getState()
            .setError(err instanceof Error ? err.message : 'Failed to fetch data');
        }
        return true;
      } finally {
        endPartitionLoad();
        if (boardFence) endPartitionLoad();
        releaseResyncClaim(resyncClaim);
        releaseResyncClaim(boardClaim);
        if (!silent && authorityIsCurrent()) {
          agorStore.getState().setLoading(false);
          agorStore.getState().setLoadingStage('idle');
          debugTimer?.markStage('idle');
          if (debugFinishStatus) {
            debugTimer?.finish(debugFinishStatus, debugFinishError);
          }
        }
      }
    },
    [
      authenticatedUserId,
      authorityScopeKey,
      canListUsers,
      canUseMemberWorkspaceServices,
      client,
      directSessionId,
      enabled,
      refetchOAuthDurableState,
    ]
  );

  // The long-lived client survives role, token, identity, and reconnect
  // transitions. Invalidate every older fetch/hydration at commit time before
  // it can apply under the replacement authority. A promotion deliberately
  // does NOT refetch while connectionReady is false; the new authGeneration
  // produces a non-null scope only after socket reauthentication succeeds.
  const previousAuthorityTransitionRef = useRef({
    scopeKey: authorityScopeKey,
    userId: authenticatedUserId,
    canUseMemberWorkspaceServices,
  });
  useLayoutEffect(() => {
    const previous = previousAuthorityTransitionRef.current;
    const identityChanged = previous.userId !== authenticatedUserId;
    const privilegeChanged =
      previous.canUseMemberWorkspaceServices !== canUseMemberWorkspaceServices;
    const scopeChanged = previous.scopeKey !== authorityScopeKey;
    previousAuthorityTransitionRef.current = {
      scopeKey: authorityScopeKey,
      userId: authenticatedUserId,
      canUseMemberWorkspaceServices,
    };
    if (!identityChanged && !privilegeChanged && !scopeChanged) return;

    cancelAllHydrations();
    releaseOpenedTranscriptPrefetch();
    stopUserScope();
    // Which session↔MCP links are visible depends on the caller.
    resetSessionMcpLinks();
    // Partition loads of the old authority are orphaned by the cancellation;
    // forget their entries so the displayed board loads again under this one,
    // and remember the boards for the resync to evict.
    for (const key of agorStore.getState().coverage.keys()) {
      if (key.startsWith(BOARD_SCOPE_PREFIX)) {
        transitionUnloadedBoardsRef.current.add(key.slice(BOARD_SCOPE_PREFIX.length));
      }
    }
    agorStore.getState().resetBoardPartitions();
    refetchInflightRef.current = null;
    lastSilentFetchFailedRef.current = false;

    if (identityChanged) {
      // All normalized rows may contain caller-scoped/private data (MCP rows,
      // OAuth state, credential presence), so an in-place identity replacement
      // gets the same map boundary as logout before the new authority resyncs.
      agorStore.getState().resetMaps();
    } else if (!canUseMemberWorkspaceServices) {
      bumpRevision('boardObjects');
      agorStore.getState().applyMaps((previousMaps) => ({
        ...previousMaps,
        userById: new Map(),
        boardObjectById: new Map(),
        boardObjectsByBoardId: new Map(),
      }));
    }

    if (authorityScopeKey && client && enabled && hasInitiallyFetched) {
      void fetchData({ silent: true });
    }
  }, [
    authenticatedUserId,
    authorityScopeKey,
    canUseMemberWorkspaceServices,
    client,
    enabled,
    fetchData,
    hasInitiallyFetched,
    releaseOpenedTranscriptPrefetch,
  ]);

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
  // `resetMaps()` clears every data map (EMPTY_MAPS covers every field) while
  // leaving the meta fields alone — matching the old `setMaps(EMPTY_MAPS)`.
  // `cancelAndFailAllHydrations()` cancels every in-flight hydration loop (bump
  // generations) AND fails any quiet check it might still reach (bump revisions)
  // so an unresolved hydration can't repopulate the Maps AFTER logout (post-logout
  // data leak). Bumping the generation is the real stop — without it, a revision
  // bump alone would only make the loop discard-and-RE-FETCH from the stale client
  // and eventually apply into freshly-cleared Maps.
  useEffect(() => {
    if (client) return;
    // Discard (don't apply) any frame-batched session patches so a queued patch
    // can't repopulate the maps `resetMaps()` is about to clear.
    discardRealtimeNow();
    cancelAndFailAllHydrations();
    releaseOpenedTranscriptPrefetch();
    stopUserScope();
    agorStore.getState().resetMaps();
    setHasInitiallyFetched(false);
  }, [client, releaseOpenedTranscriptPrefetch]);

  // On unmount, supersede every in-flight per-collection hydration loop so it
  // stops retrying and never applies a snapshot (or schedules another timer)
  // after teardown. Generation bump = cancellation; see `runHydration`.
  useEffect(
    () => () => {
      cancelAllHydrations();
      releaseOpenedTranscriptPrefetch();
      stopUserScope();
    },
    [releaseOpenedTranscriptPrefetch]
  );

  // Auth badges reflect the last durable observation. Refresh on bootstrap,
  // reconnect and explicit OAuth events, not on an idle-tab timer. Execution
  // independently resolves credentials; this UI snapshot never authorizes use.

  // A deep link (`/s/`, `/m/session/`, `/w/`) whose session or branch the
  // store doesn't hold after the initial load — archived, outside every loaded
  // scope, or an ambiguous short id: read it by id (the daemon resolves short
  // ids) and fill it, joining no scope. An active session brings its branch;
  // an archived one is inserted for display only, outside every list. A
  // target the fill doesn't apply (not returned, or removed while the read
  // was in flight) is recorded in `missingLinkTargets`.
  useEffect(() => {
    const target = directSessionId
      ? { kind: 'session' as const, token: directSessionId }
      : directBranchId
        ? { kind: 'branch' as const, token: directBranchId }
        : null;
    if (!client || !enabled || !authorityScopeKey || !hasInitiallyFetched || !target) return;
    const directFetchAuthorityScope = authorityScopeKey;
    const authorityIsCurrent = () => authorityScopeKeyRef.current === directFetchAuthorityScope;
    const { sessionById, branchById } = agorStore.getState();
    if (
      target.kind === 'session'
        ? sessionById.has(target.token) || resolveSessionFromShortIdPure(target.token, sessionById)
        : branchById.has(target.token) || resolveBranchFromShortIdPure(target.token, branchById)
    ) {
      return;
    }

    let cancelled = false;
    // Holds what the link reads until it is left (the route's pins take over
    // the opened rows by full id); a read it outlived inserts nothing.
    const hold = holdRows();
    const missed = () => {
      if (cancelled || !authorityIsCurrent()) return;
      // Only the current target: the marks never grow with history.
      const { missingLinkTargets, setUserScope } = agorStore.getState();
      if (missingLinkTargets.size === 1 && missingLinkTargets.has(target.token)) return;
      setUserScope({ missingLinkTargets: new Set([target.token]) });
    };
    const fillBranch = (id: string) =>
      fillOnDemand(
        async () => ({
          branches: [(await client.service('branches').get(id)) as Branch].filter(Boolean),
        }),
        hold
      );
    (async () => {
      try {
        if (target.kind === 'branch') {
          const rows = await fillBranch(target.token);
          const { branchById } = agorStore.getState();
          if (rows && !rows.branches?.some((branch) => branchById.has(branch.branch_id))) missed();
          return;
        }
        // The get runs inside the fill's fence, so a removal that lands while
        // it is in flight keeps its stale row out.
        const rows = await fillOnDemand(
          async () => ({
            sessions: [(await client.service('sessions').get(target.token)) as Session].filter(
              Boolean
            ),
          }),
          hold
        );
        if (!rows) return;
        const directSession = rows.sessions?.[0];
        if (!directSession || !agorStore.getState().sessionById.has(directSession.session_id)) {
          return missed();
        }
        if (
          !directSession.archived &&
          directSession.branch_id &&
          !agorStore.getState().branchById.has(directSession.branch_id)
        ) {
          // The session can still be selected if its branch is inaccessible or gone.
          await fillBranch(directSession.branch_id).catch(() => undefined);
        }
      } catch {
        // Not found, ambiguous, or failed: the URL stays sticky and the normal
        // resolver keeps waiting; surfaces may now say "not found".
        missed();
      }
    })();

    return () => {
      cancelled = true;
      hold.release();
    };
  }, [authorityScopeKey, client, directBranchId, directSessionId, enabled, hasInitiallyFetched]);

  // Subscribe to real-time updates
  //
  // Every socket event is wired through an authority-scoped stable wrapper to
  // the matching store action in `agorRealtimeActions` (the wrappers live for
  // this effect, so cleanup `removeListener` matches). The store action does the
  // `replaceIfChanged` / cascade / index-rebuild + per-collection `bumpRevision`.
  // OAuth + agor-query handlers stay local: they need `client` (async refetch)
  // or are pure window side-effects.
  useEffect(() => {
    if (!client || !enabled || !authorityScopeKey) {
      // No client or disabled = not ready for data fetch, set loading to false
      agorStore.getState().setLoading(false);
      agorStore.getState().setLoadingStage('idle');
      return;
    }

    const subscriptionAuthorityScope = authorityScopeKey;
    const subscriptionIsCurrent = () => authorityScopeKeyRef.current === subscriptionAuthorityScope;
    // All direct store handlers are authority-scoped too. Although only
    // sessions are frame-batched, an old Feathers listener remains live until
    // passive cleanup and must not write during the layout→cleanup overlap.
    const scopedRealtime = Object.fromEntries(
      Object.entries(realtime).map(([name, handler]) => [
        name,
        (...args: unknown[]) => {
          if (!subscriptionIsCurrent()) return;
          (handler as (...values: unknown[]) => void)(...args);
        },
      ])
    ) as typeof realtime;

    // Subscribe to session events. `patched`/`updated` are the streaming hot
    // path (a patch per token batch), so they're coalesced into one keyed store
    // write per frame — without this, mounting a board into a live store
    // (home→board) never converges. `created`/`removed` stay synchronous; the
    // keyed queue's tombstones keep a deferred patch from resurrecting a
    // session a synchronous `removed` just deleted (see `realtimeBatch`).
    const sessionsService = client.service('sessions');
    // Keep the revision bump SYNCHRONOUS — the loads' per-id touched fences,
    // and the queue's own stale-drop stamp, both depend on the bump landing
    // the instant the event does, not a frame later.
    const sessionPatchedBatched = (session: Session) => {
      if (!subscriptionIsCurrent()) return;
      bumpRevision('sessions');
      enqueueSessionPatch(subscriptionAuthorityScope, session);
    };
    // `created` clears any tombstone (remove-then-recreate in one frame) and
    // `removed` sets one + drops the id's queued patch, before the synchronous
    // store write.
    const sessionCreatedSync = (session: Session) => {
      if (!subscriptionIsCurrent()) return;
      untombstoneSession(subscriptionAuthorityScope, session.session_id);
      scopedRealtime.sessionCreated(session);
    };
    const sessionRemovedSync = (session: Session) => {
      if (!subscriptionIsCurrent()) return;
      tombstoneSession(subscriptionAuthorityScope, session.session_id);
      scopedRealtime.sessionRemoved(session);
    };
    sessionsService.on('created', sessionCreatedSync);
    sessionsService.on('patched', sessionPatchedBatched);
    sessionsService.on('updated', sessionPatchedBatched);
    sessionsService.on('removed', sessionRemovedSync);

    // Subscribe to board events
    const boardsService = client.service('boards');
    boardsService.on('created', scopedRealtime.boardCreated);
    boardsService.on('patched', scopedRealtime.boardPatched);
    boardsService.on('updated', scopedRealtime.boardPatched);
    boardsService.on('removed', scopedRealtime.boardRemoved);

    // Subscribe to board object events
    const boardObjectsService = canUseMemberWorkspaceServices
      ? client.service('board-objects')
      : null;
    boardObjectsService?.on('created', scopedRealtime.boardObjectCreated);
    boardObjectsService?.on('patched', scopedRealtime.boardObjectPatched);
    boardObjectsService?.on('updated', scopedRealtime.boardObjectPatched);
    boardObjectsService?.on('removed', scopedRealtime.boardObjectRemoved);

    // Subscribe to repo events
    const reposService = client.service('repos');
    reposService.on('created', scopedRealtime.repoCreated);
    reposService.on('patched', scopedRealtime.repoPatched);
    reposService.on('updated', scopedRealtime.repoPatched);
    reposService.on('removed', scopedRealtime.repoRemoved);

    // Subscribe to branch events
    const branchesService = client.service('branches');
    const branchRemovedSync = (branch: Branch) => {
      if (!subscriptionIsCurrent()) return;
      scopedRealtime.branchRemoved(branch);
      // Branch deletion cascades tasks/messages without child Feathers events.
      // Comments survive those cascades with task_id/message_id SET NULL, but
      // the branch tombstone does not contain the deleted descendant IDs.
      // Rehydrate the authoritative comment set under the standard quiet-window
      // guard so stale attachment IDs disappear without risking resurrection.
      void runHydration(
        'branch-removal-comments',
        ['comments'],
        () =>
          client.service('board-comments').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
        (allComments) =>
          agorStore.getState().applyMaps((prev) => ({
            ...prev,
            commentById: buildById(allComments, 'comment_id', prev.commentById),
          }))
      );
    };
    branchesService.on('created', scopedRealtime.branchCreated);
    branchesService.on('patched', scopedRealtime.branchPatched);
    branchesService.on('updated', scopedRealtime.branchPatched);
    branchesService.on('removed', branchRemovedSync);

    // Subscribe to user events
    const usersService = canListUsers ? client.service('users') : null;
    usersService?.on('created', scopedRealtime.userCreated);
    usersService?.on('patched', scopedRealtime.userPatched);
    usersService?.on('updated', scopedRealtime.userPatched);
    usersService?.on('removed', scopedRealtime.userRemoved);

    const agenticToolSettingsService = client.service('agentic-tool-settings');
    // A single-row realtime event is an INCREMENTAL upsert, not a complete
    // snapshot — merge the row without flipping the hydration gate, so a patch
    // that lands before the full fetch can't mark a partial map authoritative.
    const agenticToolSettingsPatched = (
      updated: import('@agor-live/client').TenantAgenticToolSettings
    ) => {
      if (!subscriptionIsCurrent()) return;
      // Bump the live-write revision so a background full-fetch that raced this
      // upsert discards its (now-stale) snapshot instead of overwriting it.
      bumpRevision('agenticToolSettings');
      agorStore.getState().upsertAgenticToolSetting(updated);
    };
    agenticToolSettingsService.on('patched', agenticToolSettingsPatched);
    agenticToolSettingsService.on('created', agenticToolSettingsPatched);

    // Subscribe to MCP server events
    const mcpServersService = client.service('mcp-servers');
    mcpServersService.on('created', scopedRealtime.mcpServerCreated);
    mcpServersService.on('patched', scopedRealtime.mcpServerPatched);
    mcpServersService.on('updated', scopedRealtime.mcpServerPatched);
    mcpServersService.on('removed', scopedRealtime.mcpServerRemoved);

    // Subscribe to gateway channel events
    const gatewayChannelsService = client.service('gateway-channels');
    gatewayChannelsService.on('created', scopedRealtime.gatewayChannelCreated);
    gatewayChannelsService.on('patched', scopedRealtime.gatewayChannelPatched);
    gatewayChannelsService.on('updated', scopedRealtime.gatewayChannelPatched);
    gatewayChannelsService.on('removed', scopedRealtime.gatewayChannelRemoved);

    // Subscribe to card events
    const cardsService = client.service('cards');
    cardsService.on('created', scopedRealtime.cardCreated);
    cardsService.on('patched', scopedRealtime.cardPatched);
    cardsService.on('updated', scopedRealtime.cardPatched);
    cardsService.on('removed', scopedRealtime.cardRemoved);

    // Subscribe to card type events
    const cardTypesService = client.service('card-types');
    cardTypesService.on('created', scopedRealtime.cardTypeCreated);
    cardTypesService.on('patched', scopedRealtime.cardTypePatched);
    cardTypesService.on('updated', scopedRealtime.cardTypePatched);
    cardTypesService.on('removed', scopedRealtime.cardTypeRemoved);

    // Subscribe to artifact events
    const artifactsService = client.service('artifacts');
    artifactsService.on('created', scopedRealtime.artifactCreated);
    artifactsService.on('patched', scopedRealtime.artifactPatched);
    artifactsService.on('updated', scopedRealtime.artifactPatched);
    artifactsService.on('removed', scopedRealtime.artifactRemoved);

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
      if (!subscriptionIsCurrent()) return;
      window.dispatchEvent(new CustomEvent('agor:artifact-runtime-query', { detail: event }));
    };
    artifactsService.on('agor-query', handleAgorQuery);

    // Subscribe to session-MCP server relationship events
    const sessionMcpService = client.service('session-mcp-servers');
    sessionMcpService.on('created', scopedRealtime.sessionMcpCreated);
    sessionMcpService.on('patched', scopedRealtime.sessionMcpPatched);
    sessionMcpService.on('removed', scopedRealtime.sessionMcpRemoved);

    // Subscribe to board comment events
    const commentsService = client.service('board-comments');
    commentsService.on('created', scopedRealtime.commentCreated);
    commentsService.on('patched', scopedRealtime.commentPatched);
    commentsService.on('updated', scopedRealtime.commentPatched);
    commentsService.on('removed', scopedRealtime.commentRemoved);

    // Realtime OAuth events are latency hints only. Correctness comes from
    // refetching the durable, authenticated token status and server record;
    // events can be missed during reconnects or handled by another daemon.
    const handleOAuthCompleted = async (event: {
      attempt_id?: string;
      success: boolean;
      mcp_server_id?: string;
      oauth_mode?: string;
    }) => {
      if (!event.success || !event.mcp_server_id) return;
      try {
        const applied = await refetchOAuthDurableState(authorityScopeKey, event.mcp_server_id);
        if (!applied) return;
        if (authorityScopeKeyRef.current !== authorityScopeKey) return;
        bumpRevision('oauth');
        bumpRevision('mcpServers');
      } catch (err) {
        console.warn('[OAuth] Failed to refetch durable state after re-auth:', err);
      }
    };
    client.io.on('oauth:completed', handleOAuthCompleted);

    // Disconnect follows the same durable-refetch rule; do not optimistically
    // mutate token state based only on a best-effort realtime event.
    const handleOAuthDisconnected = async (event: { mcp_server_id: string }) => {
      if (!event.mcp_server_id) return;
      try {
        const applied = await refetchOAuthDurableState(authorityScopeKey, event.mcp_server_id);
        if (!applied) return;
        if (authorityScopeKeyRef.current !== authorityScopeKey) return;
        bumpRevision('oauth');
        bumpRevision('mcpServers');
      } catch (err) {
        console.warn('[OAuth] Failed to refetch durable state after disconnect:', err);
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
    // `silent: true` so a transient failure during reconnect
    // doesn't blank the whole app via App.tsx's `dataError`
    // path — see the silent branch in `fetchData`.
    const refetchSilently = async () => {
      const refetchScope = authorityScopeKey;
      if (!hasInitiallyFetched || !refetchScope) return;
      if (refetchInflightRef.current === refetchScope) return;
      refetchInflightRef.current = refetchScope;
      try {
        await fetchData({ silent: true });
      } finally {
        if (refetchInflightRef.current === refetchScope) {
          refetchInflightRef.current = null;
        }
      }
    };
    client.io.on('connect', refetchSilently);

    // If the prior reconnect refetch failed silently, retry once a token
    // replacement lands (one signal that authentication and connectivity are
    // healthy again). Without this, byId state stays stale until the next
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
    if (!hasInitiallyFetched && authorityScopeKey) {
      fetchData().then((completedForAuthority) => {
        if (completedForAuthority) setHasInitiallyFetched(true);
      });
    }

    // Cleanup listeners on unmount
    return () => {
      // APPLY only when this is a same-authority resubscribe. The layout-phase
      // scope transition has already discarded an identity/role/auth/connection
      // queue, and makes this old passive cleanup a no-op. This preserves live
      // updates on ordinary effect churn without crossing an authority boundary.
      flushRealtimeNow(subscriptionAuthorityScope);
      client.io.off('oauth:completed', handleOAuthCompleted);
      client.io.off('oauth:disconnected', handleOAuthDisconnected);
      client.io.off('connect', refetchSilently);
      window.removeEventListener(TOKENS_REFRESHED_EVENT, handleTokensRefreshed);
      sessionsService.removeListener('created', sessionCreatedSync);
      sessionsService.removeListener('patched', sessionPatchedBatched);
      sessionsService.removeListener('updated', sessionPatchedBatched);
      sessionsService.removeListener('removed', sessionRemovedSync);

      boardsService.removeListener('created', scopedRealtime.boardCreated);
      boardsService.removeListener('patched', scopedRealtime.boardPatched);
      boardsService.removeListener('updated', scopedRealtime.boardPatched);
      boardsService.removeListener('removed', scopedRealtime.boardRemoved);

      boardObjectsService?.removeListener('created', scopedRealtime.boardObjectCreated);
      boardObjectsService?.removeListener('patched', scopedRealtime.boardObjectPatched);
      boardObjectsService?.removeListener('updated', scopedRealtime.boardObjectPatched);
      boardObjectsService?.removeListener('removed', scopedRealtime.boardObjectRemoved);

      reposService.removeListener('created', scopedRealtime.repoCreated);
      reposService.removeListener('patched', scopedRealtime.repoPatched);
      reposService.removeListener('updated', scopedRealtime.repoPatched);
      reposService.removeListener('removed', scopedRealtime.repoRemoved);

      branchesService.removeListener('created', scopedRealtime.branchCreated);
      branchesService.removeListener('patched', scopedRealtime.branchPatched);
      branchesService.removeListener('updated', scopedRealtime.branchPatched);
      branchesService.removeListener('removed', branchRemovedSync);

      usersService?.removeListener('created', scopedRealtime.userCreated);
      usersService?.removeListener('patched', scopedRealtime.userPatched);
      usersService?.removeListener('updated', scopedRealtime.userPatched);
      usersService?.removeListener('removed', scopedRealtime.userRemoved);

      agenticToolSettingsService.removeListener('patched', agenticToolSettingsPatched);
      agenticToolSettingsService.removeListener('created', agenticToolSettingsPatched);

      mcpServersService.removeListener('created', scopedRealtime.mcpServerCreated);
      mcpServersService.removeListener('patched', scopedRealtime.mcpServerPatched);
      mcpServersService.removeListener('updated', scopedRealtime.mcpServerPatched);
      mcpServersService.removeListener('removed', scopedRealtime.mcpServerRemoved);

      sessionMcpService.removeListener('created', scopedRealtime.sessionMcpCreated);
      sessionMcpService.removeListener('patched', scopedRealtime.sessionMcpPatched);
      sessionMcpService.removeListener('removed', scopedRealtime.sessionMcpRemoved);

      commentsService.removeListener('created', scopedRealtime.commentCreated);
      commentsService.removeListener('patched', scopedRealtime.commentPatched);
      commentsService.removeListener('updated', scopedRealtime.commentPatched);
      commentsService.removeListener('removed', scopedRealtime.commentRemoved);

      gatewayChannelsService.removeListener('created', scopedRealtime.gatewayChannelCreated);
      gatewayChannelsService.removeListener('patched', scopedRealtime.gatewayChannelPatched);
      gatewayChannelsService.removeListener('updated', scopedRealtime.gatewayChannelPatched);
      gatewayChannelsService.removeListener('removed', scopedRealtime.gatewayChannelRemoved);

      cardsService.removeListener('created', scopedRealtime.cardCreated);
      cardsService.removeListener('patched', scopedRealtime.cardPatched);
      cardsService.removeListener('updated', scopedRealtime.cardPatched);
      cardsService.removeListener('removed', scopedRealtime.cardRemoved);

      cardTypesService.removeListener('created', scopedRealtime.cardTypeCreated);
      cardTypesService.removeListener('patched', scopedRealtime.cardTypePatched);
      cardTypesService.removeListener('updated', scopedRealtime.cardTypePatched);
      cardTypesService.removeListener('removed', scopedRealtime.cardTypeRemoved);

      artifactsService.removeListener('created', scopedRealtime.artifactCreated);
      artifactsService.removeListener('patched', scopedRealtime.artifactPatched);
      artifactsService.removeListener('updated', scopedRealtime.artifactPatched);
      artifactsService.removeListener('removed', scopedRealtime.artifactRemoved);
      artifactsService.removeListener('agor-query', handleAgorQuery);
    };
  }, [
    canListUsers,
    canUseMemberWorkspaceServices,
    authorityScopeKey,
    client,
    enabled,
    fetchData,
    hasInitiallyFetched,
    refetchOAuthDurableState,
  ]);

  // Derived render model for the loading checklist. Memoized so the array
  // identity is stable across renders where no per-item count changed.
  const initialLoadItems = useMemo<InitialLoadItem[]>(
    () =>
      INITIAL_LOAD_ITEMS.filter(({ key }) => initialLoadPlan.includes(key)).map(
        ({ key, label }) => {
          const count = storeState.itemCounts[key];
          return { key, label, done: count !== undefined, count: count ?? 0 };
        }
      ),
    [initialLoadPlan, storeState.itemCounts]
  );

  const initialLoadComplete = initialLoadPlan.every(
    (key) => storeState.itemCounts[key] !== undefined
  );

  return {
    initialLoadItems,
    initialLoadComplete,
    loadingStage: storeState.loadingStage,
    loading: storeState.loading,
    error: storeState.error,
    refetch: fetchData,
  };
}
