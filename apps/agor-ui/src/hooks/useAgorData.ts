// @ts-nocheck - Complex WebSocket event handling with dynamic types
/**
 * React hook for fetching and subscribing to Agor data
 *
 * Manages sessions, tasks, boards with real-time WebSocket updates.
 *
 * State ownership lives in the zustand store (`agorStore`); this hook is the
 * single DRIVER of that store — the fetch effect and socket subscriptions
 * dispatch store actions, and the hook reads full state back via `useStore` and
 * returns `UseAgorDataResult`. The realtime entity reducers + index/merge
 * helpers live in `../store/agorRealtimeActions` and `../store/agorMaps`, and
 * the background-hydration bookkeeping (per-collection revision counters,
 * generation tokens, `runHydration`) in `../store/agorHydration`.
 */

import type {
  AgorClient,
  Board,
  BoardComment,
  Branch,
  CardType,
  CardWithType,
  MCPServer,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import { ENTITY_PATH_SEGMENTS, findByShortIdPrefix, PAGINATION } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  bumpFirstPaintMergeRevisions,
  bumpRevision,
  cancelAllHydrations,
  cancelAndFailAllHydrations,
  resetHydrationRevisions,
  runHydration,
} from '../store/agorHydration';
import {
  buildBoardObjectMaps,
  buildById,
  buildSessionMaps,
  buildSessionMcpMap,
  type DataMaps,
  pickMaps,
  replaceIfChanged,
} from '../store/agorMaps';
import * as realtime from '../store/agorRealtimeActions';
import { agorStore } from '../store/agorStore';
import { createInitialLoadDebugTimer, isInitialLoadDebugEnabled } from '../utils/initialLoadDebug';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';
import {
  resolveBoardFromUrlPure,
  resolveBranchFromShortIdPure,
  resolveSessionFromShortIdPure,
} from '../utils/urlResolution';

export type { DataMaps } from '../store/agorMaps';
// Re-exported for backward compatibility: the canonical data-map shape +
// empties now live in `../store/agorMaps`, but existing importers (and tests)
// reference them via this module.
export { EMPTY_MAPS } from '../store/agorMaps';

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

interface UseAgorDataResult extends DataMaps {
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
  options?: { enabled?: boolean; directSessionId?: string | null }
): UseAgorDataResult {
  const enabled = options?.enabled ?? true;
  const directSessionId = options?.directSessionId ?? null;

  // Reset the shared singleton store once per hook (re)mount, synchronously
  // BEFORE the first `useStore` read below. This mirrors the old per-mount
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
    return null;
  });

  // Full store state, re-rendering this owner on every committed store change —
  // exactly as the old single `useState<DataMaps>` + meta `useState`s did.
  const storeState = useStore(agorStore);

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
          agorStore.getState().setLoading(true);
          agorStore.getState().setLoadingStage('fetching');
          debugTimer?.markStage('fetching');
          agorStore.getState().setError(null);
          agorStore.getState().setItemCounts({});
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
            if (!silent)
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
        void runHydration(
          'mcp-servers',
          ['mcpServers'],
          () =>
            client.service('mcp-servers').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          (list) =>
            agorStore
              .getState()
              .applyMaps((prev) => ({ ...prev, mcpServerById: buildById(list, 'mcp_server_id') }))
        );
        void runHydration(
          'session-mcp-servers',
          ['sessionMcp'],
          () =>
            client
              .service('session-mcp-servers')
              .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          (list) =>
            agorStore
              .getState()
              .applyMaps((prev) => ({ ...prev, sessionMcpServerIds: buildSessionMcpMap(list) }))
        );
        void runHydration(
          'gateway-channels',
          ['gatewayChannels'],
          () =>
            client
              .service('gateway-channels')
              .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          (list) =>
            agorStore
              .getState()
              .applyMaps((prev) => ({ ...prev, gatewayChannelById: buildById(list, 'id') }))
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
          (list) =>
            agorStore
              .getState()
              .applyMaps((prev) => ({ ...prev, artifactById: buildById(list, 'artifact_id') }))
        );
        void runHydration(
          'oauth-status',
          ['oauth'],
          () => client.service('mcp-servers/oauth-status').find(),
          (res) => {
            const ids =
              (res as { authenticated_server_ids?: string[] })?.authenticated_server_ids ?? [];
            agorStore
              .getState()
              .applyMaps((prev) => ({ ...prev, userAuthenticatedMcpServerIds: new Set(ids) }));
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
        agorStore.getState().applyMaps((prev) => ({
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
        bumpFirstPaintMergeRevisions();
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
        // separate revision guards, separate generation tokens). Coupling them
        // in a single runHydration would let high-frequency session-write churn
        // (common when agents stream) starve the branch apply indefinitely — and
        // on Home, branches start empty and are filled ONLY by this hydration, so
        // coupling could leave the board empty forever. On independent loops,
        // branches apply on their own quiet window (almost immediately)
        // regardless of session churn.
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
              agorStore.getState().applyMaps((prev) => {
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
              agorStore
                .getState()
                .applyMaps((prev) => ({ ...prev, branchById: buildById(allBranches, 'branch_id') }))
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
              agorStore.getState().applyMaps((prev) => {
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
            (allCards) =>
              agorStore
                .getState()
                .applyMaps((prev) => ({ ...prev, cardById: buildById(allCards, 'card_id') }))
          );
          void runHydration(
            'board-comments',
            ['comments'],
            () =>
              client
                .service('board-comments')
                .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
            (allComments) =>
              agorStore.getState().applyMaps((prev) => ({
                ...prev,
                commentById: buildById(allComments, 'comment_id'),
              }))
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
          agorStore
            .getState()
            .setError(err instanceof Error ? err.message : 'Failed to fetch data');
        }
      } finally {
        if (!silent) {
          agorStore.getState().setLoading(false);
          agorStore.getState().setLoadingStage('idle');
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
    cancelAndFailAllHydrations();
    agorStore.getState().resetMaps();
    setHasInitiallyFetched(false);
  }, [client]);

  // On unmount, supersede every in-flight per-collection hydration loop so it
  // stops retrying and never applies a snapshot (or schedules another timer)
  // after teardown. Generation bump = cancellation; see `runHydration`.
  useEffect(() => () => cancelAllHydrations(), []);

  // If the user navigates to /s/<id>/ after the initial active-session fetch,
  // load that one session by ID as well. This keeps direct links to archived
  // sessions openable without changing the default list query.
  useEffect(() => {
    if (!client || !enabled || !hasInitiallyFetched || !directSessionId) return;
    if (storeState.sessionById.has(directSessionId)) return;
    if (
      hasIdMatchingPrefix(directSessionId, storeState.sessionById.values(), (s) => s.session_id)
    ) {
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
        agorStore.getState().setMap('sessionById', (prev) => {
          if (prev.has(directSession.session_id)) return prev;
          const next = new Map(prev);
          next.set(directSession.session_id, directSession);
          return next;
        });
        if (!directSession.archived) {
          agorStore.getState().setMap('sessionsByBranch', (prev) => {
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
          !storeState.branchById.has(directSession.branch_id)
        ) {
          try {
            const directBranch = (await client
              .service('branches')
              .get(directSession.branch_id)) as Branch;
            if (cancelled) return;
            bumpRevision('branches');
            agorStore.getState().setMap('branchById', (prev) => {
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
    storeState.branchById,
    storeState.sessionById,
  ]);

  // Subscribe to real-time updates
  //
  // Every socket event is wired straight to the matching store action in
  // `agorRealtimeActions` (module singletons → stable references, so cleanup
  // `removeListener` matches). The store action does the
  // `replaceIfChanged` / cascade / index-rebuild + per-collection `bumpRevision`.
  // OAuth + agor-query handlers stay local: they need `client` (async refetch)
  // or are pure window side-effects.
  useEffect(() => {
    if (!client || !enabled) {
      // No client or disabled = not ready for data fetch, set loading to false
      agorStore.getState().setLoading(false);
      agorStore.getState().setLoadingStage('idle');
      return;
    }

    // Subscribe to session events
    const sessionsService = client.service('sessions');
    sessionsService.on('created', realtime.sessionCreated);
    sessionsService.on('patched', realtime.sessionPatched);
    sessionsService.on('updated', realtime.sessionPatched);
    sessionsService.on('removed', realtime.sessionRemoved);

    // Subscribe to board events
    const boardsService = client.service('boards');
    boardsService.on('created', realtime.boardCreated);
    boardsService.on('patched', realtime.boardPatched);
    boardsService.on('updated', realtime.boardPatched);
    boardsService.on('removed', realtime.boardRemoved);

    // Subscribe to board object events
    const boardObjectsService = client.service('board-objects');
    boardObjectsService.on('created', realtime.boardObjectCreated);
    boardObjectsService.on('patched', realtime.boardObjectPatched);
    boardObjectsService.on('updated', realtime.boardObjectPatched);
    boardObjectsService.on('removed', realtime.boardObjectRemoved);

    // Subscribe to repo events
    const reposService = client.service('repos');
    reposService.on('created', realtime.repoCreated);
    reposService.on('patched', realtime.repoPatched);
    reposService.on('updated', realtime.repoPatched);
    reposService.on('removed', realtime.repoRemoved);

    // Subscribe to branch events
    const branchesService = client.service('branches');
    branchesService.on('created', realtime.branchCreated);
    branchesService.on('patched', realtime.branchPatched);
    branchesService.on('updated', realtime.branchPatched);
    branchesService.on('removed', realtime.branchRemoved);

    // Subscribe to user events
    const usersService = client.service('users');
    usersService.on('created', realtime.userCreated);
    usersService.on('patched', realtime.userPatched);
    usersService.on('updated', realtime.userPatched);
    usersService.on('removed', realtime.userRemoved);

    // Subscribe to MCP server events
    const mcpServersService = client.service('mcp-servers');
    mcpServersService.on('created', realtime.mcpServerCreated);
    mcpServersService.on('patched', realtime.mcpServerPatched);
    mcpServersService.on('updated', realtime.mcpServerPatched);
    mcpServersService.on('removed', realtime.mcpServerRemoved);

    // Subscribe to gateway channel events
    const gatewayChannelsService = client.service('gateway-channels');
    gatewayChannelsService.on('created', realtime.gatewayChannelCreated);
    gatewayChannelsService.on('patched', realtime.gatewayChannelPatched);
    gatewayChannelsService.on('updated', realtime.gatewayChannelPatched);
    gatewayChannelsService.on('removed', realtime.gatewayChannelRemoved);

    // Subscribe to card events
    const cardsService = client.service('cards');
    cardsService.on('created', realtime.cardCreated);
    cardsService.on('patched', realtime.cardPatched);
    cardsService.on('updated', realtime.cardPatched);
    cardsService.on('removed', realtime.cardRemoved);

    // Subscribe to card type events
    const cardTypesService = client.service('card-types');
    cardTypesService.on('created', realtime.cardTypeCreated);
    cardTypesService.on('patched', realtime.cardTypePatched);
    cardTypesService.on('updated', realtime.cardTypePatched);
    cardTypesService.on('removed', realtime.cardTypeRemoved);

    // Subscribe to artifact events
    const artifactsService = client.service('artifacts');
    artifactsService.on('created', realtime.artifactCreated);
    artifactsService.on('patched', realtime.artifactPatched);
    artifactsService.on('updated', realtime.artifactPatched);
    artifactsService.on('removed', realtime.artifactRemoved);

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
    sessionMcpService.on('created', realtime.sessionMcpCreated);
    sessionMcpService.on('removed', realtime.sessionMcpRemoved);

    // Subscribe to board comment events
    const commentsService = client.service('board-comments');
    commentsService.on('created', realtime.commentCreated);
    commentsService.on('patched', realtime.commentPatched);
    commentsService.on('updated', realtime.commentPatched);
    commentsService.on('removed', realtime.commentRemoved);

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
        agorStore.getState().setMap('userAuthenticatedMcpServerIds', (prev) => {
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
        agorStore
          .getState()
          .setMap('mcpServerById', (prev) => replaceIfChanged(prev, fresh.mcp_server_id, fresh));
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
      agorStore.getState().setMap('userAuthenticatedMcpServerIds', (prev) => {
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
      agorStore.getState().setMap('mcpServerById', (prev) => {
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
        agorStore
          .getState()
          .setMap('mcpServerById', (prev) => replaceIfChanged(prev, fresh.mcp_server_id, fresh));
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
      sessionsService.removeListener('created', realtime.sessionCreated);
      sessionsService.removeListener('patched', realtime.sessionPatched);
      sessionsService.removeListener('updated', realtime.sessionPatched);
      sessionsService.removeListener('removed', realtime.sessionRemoved);

      boardsService.removeListener('created', realtime.boardCreated);
      boardsService.removeListener('patched', realtime.boardPatched);
      boardsService.removeListener('updated', realtime.boardPatched);
      boardsService.removeListener('removed', realtime.boardRemoved);

      boardObjectsService.removeListener('created', realtime.boardObjectCreated);
      boardObjectsService.removeListener('patched', realtime.boardObjectPatched);
      boardObjectsService.removeListener('updated', realtime.boardObjectPatched);
      boardObjectsService.removeListener('removed', realtime.boardObjectRemoved);

      reposService.removeListener('created', realtime.repoCreated);
      reposService.removeListener('patched', realtime.repoPatched);
      reposService.removeListener('updated', realtime.repoPatched);
      reposService.removeListener('removed', realtime.repoRemoved);

      branchesService.removeListener('created', realtime.branchCreated);
      branchesService.removeListener('patched', realtime.branchPatched);
      branchesService.removeListener('updated', realtime.branchPatched);
      branchesService.removeListener('removed', realtime.branchRemoved);

      usersService.removeListener('created', realtime.userCreated);
      usersService.removeListener('patched', realtime.userPatched);
      usersService.removeListener('updated', realtime.userPatched);
      usersService.removeListener('removed', realtime.userRemoved);

      mcpServersService.removeListener('created', realtime.mcpServerCreated);
      mcpServersService.removeListener('patched', realtime.mcpServerPatched);
      mcpServersService.removeListener('updated', realtime.mcpServerPatched);
      mcpServersService.removeListener('removed', realtime.mcpServerRemoved);

      sessionMcpService.removeListener('created', realtime.sessionMcpCreated);
      sessionMcpService.removeListener('removed', realtime.sessionMcpRemoved);

      commentsService.removeListener('created', realtime.commentCreated);
      commentsService.removeListener('patched', realtime.commentPatched);
      commentsService.removeListener('updated', realtime.commentPatched);
      commentsService.removeListener('removed', realtime.commentRemoved);

      gatewayChannelsService.removeListener('created', realtime.gatewayChannelCreated);
      gatewayChannelsService.removeListener('patched', realtime.gatewayChannelPatched);
      gatewayChannelsService.removeListener('updated', realtime.gatewayChannelPatched);
      gatewayChannelsService.removeListener('removed', realtime.gatewayChannelRemoved);

      cardsService.removeListener('created', realtime.cardCreated);
      cardsService.removeListener('patched', realtime.cardPatched);
      cardsService.removeListener('updated', realtime.cardPatched);
      cardsService.removeListener('removed', realtime.cardRemoved);

      cardTypesService.removeListener('created', realtime.cardTypeCreated);
      cardTypesService.removeListener('patched', realtime.cardTypePatched);
      cardTypesService.removeListener('updated', realtime.cardTypePatched);
      cardTypesService.removeListener('removed', realtime.cardTypeRemoved);

      artifactsService.removeListener('created', realtime.artifactCreated);
      artifactsService.removeListener('patched', realtime.artifactPatched);
      artifactsService.removeListener('updated', realtime.artifactPatched);
      artifactsService.removeListener('removed', realtime.artifactRemoved);
      artifactsService.removeListener('agor-query', handleAgorQuery);
    };
  }, [client, enabled, fetchData, hasInitiallyFetched]);

  // Derived render model for the loading checklist. Memoized so the array
  // identity is stable across renders where no per-item count changed.
  const initialLoadItems = useMemo<InitialLoadItem[]>(
    () =>
      INITIAL_LOAD_ITEMS.map(({ key, label }) => {
        const count = storeState.itemCounts[key];
        return { key, label, done: count !== undefined, count: count ?? 0 };
      }),
    [storeState.itemCounts]
  );

  const initialLoadComplete = INITIAL_LOAD_ITEMS.every(
    ({ key }) => storeState.itemCounts[key] !== undefined
  );

  return {
    ...pickMaps(storeState),
    initialLoadItems,
    initialLoadComplete,
    loadingStage: storeState.loadingStage,
    loading: storeState.loading,
    error: storeState.error,
    refetch: fetchData,
  };
}
