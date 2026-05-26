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
import { PAGINATION } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shallowEqualEntity } from '../utils/shallowEqual';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';

// Canonical list of initial-load items tracked by the loading checklist.
// Internal only — consumers receive the derived `initialLoadItems` array
// (each entry carries label/done/count) rather than the raw key list.
const INITIAL_LOAD_ITEMS = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'boards', label: 'Boards' },
  { key: 'branches', label: 'Branches' },
  { key: 'repos', label: 'Repos' },
  { key: 'users', label: 'Users' },
  { key: 'cards', label: 'Cards' },
  { key: 'mcp-servers', label: 'MCP servers' },
  { key: 'artifacts', label: 'Artifacts' },
] as const;

export type InitialLoadItemKey = (typeof INITIAL_LOAD_ITEMS)[number]['key'];

// One row in the loading checklist. `count` is captured atomically with
// `done` when each tracked fetch resolves — readers never see a green row
// with a stale 0.
export interface InitialLoadItem {
  key: InitialLoadItemKey;
  label: string;
  done: boolean;
  count: number;
}

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

/**
 * Fetch and subscribe to Agor data from daemon
 *
 * @param client - Agor client instance
 * @param options - Optional configuration
 * @param options.enabled - Whether to enable data fetching (default: true). Set to false to skip
 *                          all data fetching (useful when user needs to change password first).
 * @returns Sessions, boards, loading state, and refetch function
 */
export function useAgorData(
  client: AgorClient | null,
  options?: { enabled?: boolean }
): UseAgorDataResult {
  const enabled = options?.enabled ?? true;
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
  const setBoardObjectById = setMapSlice('boardObjectById');
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: setter helpers only close over stable setMaps; listing them would add noise without preventing stale closures
  const fetchData = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!client || !enabled) {
        return;
      }

      try {
        if (!silent) {
          setLoading(true);
          setError(null);
          setItemCounts({});
        }

        // Marks a tracked item complete (and captures its count from the
        // resolved list length) when its promise resolves. No-ops on
        // silent (reconnect) refetches so initial-load progress isn't mutated.
        const track = <T extends ReadonlyArray<unknown>>(
          key: InitialLoadItemKey,
          p: Promise<T>
        ): Promise<T> =>
          p.then((r) => {
            if (!silent) setItemCounts((prev) => ({ ...prev, [key]: r.length }));
            return r;
          });

        // Fetch sessions, boards, board-objects, comments, repos, branches, users, mcp servers, session-mcp relationships in parallel.
        // Task/message detail now comes from per-session reactive state in conversation components.
        const [
          sessionsList,
          boardsList,
          boardObjectsList,
          commentsList,
          cardsList,
          cardTypesList,
          reposList,
          branchesList,
          usersList,
          mcpServersList,
          sessionMcpList,
          gatewayChannelsList,
          artifactsList,
          oauthStatusResult,
        ] = await Promise.all([
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
          client.service('board-objects').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client.service('board-comments').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          track(
            'cards',
            client.service('cards').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } })
          ),
          client.service('card-types').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
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
          track(
            'mcp-servers',
            client.service('mcp-servers').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } })
          ),
          client
            .service('session-mcp-servers')
            .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client
            .service('gateway-channels')
            .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          track(
            'artifacts',
            client.service('artifacts').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } })
          ),
          client
            .service('mcp-servers/oauth-status')
            .find()
            .catch(() => ({ authenticated_server_ids: [] })),
        ]);

        // Build session Maps for efficient lookups
        const sessionsById = new Map<string, Session>();
        const sessionsByBranchId = new Map<string, Session[]>();

        for (const session of sessionsList) {
          // sessionById: O(1) ID lookups
          sessionsById.set(session.session_id, session);

          // sessionsByBranch: O(1) branch-scoped filtering
          const branchId = session.branch_id;
          if (!sessionsByBranchId.has(branchId)) {
            sessionsByBranchId.set(branchId, []);
          }
          sessionsByBranchId.get(branchId)!.push(session);
        }

        setSessionById(sessionsById);
        setSessionsByBranch(sessionsByBranchId);

        // Build board Map for efficient lookups
        const boardsMap = new Map<string, Board>();
        for (const board of boardsList) {
          boardsMap.set(board.board_id, board);
        }
        setBoardById(boardsMap);

        // Build board object Map for efficient lookups
        const boardObjectsMap = new Map<string, BoardEntityObject>();
        for (const boardObject of boardObjectsList) {
          boardObjectsMap.set(boardObject.object_id, boardObject);
        }
        setBoardObjectById(boardObjectsMap);

        // Build comment Map for efficient lookups
        const commentsMap = new Map<string, BoardComment>();
        for (const comment of commentsList) {
          commentsMap.set(comment.comment_id, comment);
        }
        setCommentById(commentsMap);

        // Build card Map for efficient lookups
        const cardsMap = new Map<string, CardWithType>();
        for (const card of cardsList) {
          cardsMap.set(card.card_id, card);
        }
        setCardById(cardsMap);

        // Build card type Map for efficient lookups
        const cardTypesMap = new Map<string, CardType>();
        for (const cardType of cardTypesList) {
          cardTypesMap.set(cardType.card_type_id, cardType);
        }
        setCardTypeById(cardTypesMap);

        // Build repo Map for efficient lookups
        const reposMap = new Map<string, Repo>();
        for (const repo of reposList) {
          reposMap.set(repo.repo_id, repo);
        }
        setRepoById(reposMap);

        // Build branch Map for efficient lookups
        const branchesMap = new Map<string, Branch>();
        for (const branch of branchesList) {
          branchesMap.set(branch.branch_id, branch);
        }
        setBranchById(branchesMap);

        // Build user Map for efficient lookups
        const usersMap = new Map<string, User>();
        for (const user of usersList) {
          usersMap.set(user.user_id, user);
        }
        setUserById(usersMap);

        // Build MCP server Map for efficient lookups
        const mcpServersMap = new Map<string, MCPServer>();
        for (const mcpServer of mcpServersList) {
          mcpServersMap.set(mcpServer.mcp_server_id, mcpServer);
        }
        setMcpServerById(mcpServersMap);

        // Build gateway channel Map for efficient lookups
        const gatewayChannelsMap = new Map<string, GatewayChannel>();
        for (const channel of gatewayChannelsList) {
          gatewayChannelsMap.set(channel.id, channel);
        }
        setGatewayChannelById(gatewayChannelsMap);

        // Build artifact Map for efficient lookups
        const artifactsMap = new Map<string, Artifact>();
        for (const artifact of artifactsList) {
          artifactsMap.set(artifact.artifact_id, artifact);
        }
        setArtifactById(artifactsMap);

        // Group session-MCP relationships by session_id
        const sessionMcpMap = new Map<string, string[]>();
        for (const relationship of sessionMcpList) {
          if (!sessionMcpMap.has(relationship.session_id)) {
            sessionMcpMap.set(relationship.session_id, []);
          }
          sessionMcpMap.get(relationship.session_id)!.push(relationship.mcp_server_id);
        }
        setSessionMcpServerIds(sessionMcpMap);

        // Set per-user OAuth auth status
        const oauthStatus = oauthStatusResult as { authenticated_server_ids?: string[] };
        setUserAuthenticatedMcpServerIds(new Set(oauthStatus?.authenticated_server_ids ?? []));

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
          setError(err instanceof Error ? err.message : 'Failed to fetch data');
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [client, enabled]
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

  // Subscribe to real-time updates
  // biome-ignore lint/correctness/useExhaustiveDependencies: setter helpers only close over stable setMaps; listing them would add noise without preventing stale closures
  useEffect(() => {
    if (!client || !enabled) {
      // No client or disabled = not ready for data fetch, set loading to false
      setLoading(false);
      return;
    }

    // Initial fetch (only once - WebSocket events keep us synced after that)
    if (!hasInitiallyFetched) {
      fetchData().then(() => setHasInitiallyFetched(true));
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

        // Bail out on no-op patches. Feathers always emits a fresh object so
        // `existing === session` never holds, but the daemon does emit
        // idempotent patches (e.g. callback bookkeeping that lands at the same
        // status). Shallow-equal misses nested fields the daemon reserializes
        // — that's a safe false negative.
        if (existing && shallowEqualEntity(existing, session)) return prev;

        const next = new Map(prev);
        next.set(session.session_id, session);
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
          if (oldBranchId) {
            removeFromBranch(oldBranchId);
          }
          removeFromBranch(newBranchId);
          return changed ? next : prev;
        }

        // Session moved between branches - remove from old bucket first
        const branchMigrated = oldBranchId && oldBranchId !== newBranchId;
        if (branchMigrated) {
          removeFromBranch(oldBranchId!);
        }

        const branchSessions = next.get(newBranchId) || [];
        const index = branchSessions.findIndex((s) => s.session_id === session.session_id);

        if (index === -1) {
          next.set(newBranchId, [...branchSessions, session]);
          return next;
        }

        // Bail out when the session is content-equal to what we already hold.
        // Mirrors the sessionById bailout above so an idempotent patch doesn't
        // produce a fresh branch-bucket array (which would invalidate
        // `data.sessions === n.sessions` in BranchNode's custom areEqual and
        // re-render every BranchCard on the affected branch).
        if (
          branchSessions[index] === session ||
          shallowEqualEntity(branchSessions[index], session)
        ) {
          return changed ? next : prev;
        }

        const updatedSessions = [...branchSessions];
        updatedSessions[index] = session;
        next.set(newBranchId, updatedSessions);
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
      setBoardObjectById((prev) => {
        if (prev.has(boardObject.object_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(boardObject.object_id, boardObject);
        return next;
      });
    };
    const handleBoardObjectPatched = (boardObject: BoardEntityObject) => {
      setBoardObjectById((prev) => replaceIfChanged(prev, boardObject.object_id, boardObject));
    };
    const handleBoardObjectRemoved = (boardObject: BoardEntityObject) => {
      setBoardObjectById((prev) => {
        if (!prev.has(boardObject.object_id)) return prev; // Doesn't exist, nothing to remove
        const next = new Map(prev);
        next.delete(boardObject.object_id);
        return next;
      });
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
      setMcpServerById((prev) => {
        if (prev.has(server.mcp_server_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(server.mcp_server_id, server);
        return next;
      });
    };
    const handleMCPServerPatched = (server: MCPServer) => {
      setMcpServerById((prev) => replaceIfChanged(prev, server.mcp_server_id, server));
    };
    const handleMCPServerRemoved = (server: MCPServer) => {
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
      setGatewayChannelById((prev) => {
        if (prev.has(channel.id)) return prev;
        const next = new Map(prev);
        next.set(channel.id, channel);
        return next;
      });
    };
    const handleGatewayChannelPatched = (channel: GatewayChannel) => {
      setGatewayChannelById((prev) => replaceIfChanged(prev, channel.id, channel));
    };
    const handleGatewayChannelRemoved = (channel: GatewayChannel) => {
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
      setCardById((prev) => {
        if (prev.has(card.card_id)) return prev; // Duplicate event — bail.
        const next = new Map(prev);
        next.set(card.card_id, card);
        return next;
      });
    };
    const handleCardPatched = (card: CardWithType) => {
      setCardById((prev) => replaceIfChanged(prev, card.card_id, card));
    };
    const handleCardRemoved = (card: CardWithType) => {
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
      setArtifactById((prev) => {
        if (prev.has(artifact.artifact_id)) return prev;
        const next = new Map(prev);
        next.set(artifact.artifact_id, artifact);
        return next;
      });
    };
    const handleArtifactPatched = (artifact: Artifact) => {
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
      setCommentById((prev) => {
        if (prev.has(comment.comment_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(comment.comment_id, comment);
        return next;
      });
    };
    const handleCommentPatched = (comment: BoardComment) => {
      setCommentById((prev) => replaceIfChanged(prev, comment.comment_id, comment));
    };
    const handleCommentRemoved = (comment: BoardComment) => {
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
    loading,
    error,
    refetch: fetchData,
  };
}
