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
  CardType,
  CardWithType,
  GatewayChannel,
  MCPServer,
  Repo,
  Session,
  User,
  Worktree,
} from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';

interface UseAgorDataResult {
  sessionById: Map<string, Session>; // O(1) lookups by session_id - efficient, stable references
  sessionsByWorktree: Map<string, Session[]>; // O(1) worktree-scoped filtering
  boardById: Map<string, Board>; // O(1) lookups by board_id - efficient, stable references
  boardObjectById: Map<string, BoardEntityObject>; // O(1) lookups by object_id - efficient, stable references
  commentById: Map<string, BoardComment>; // O(1) lookups by comment_id - efficient, stable references
  cardById: Map<string, CardWithType>; // O(1) lookups by card_id - efficient, stable references
  cardTypeById: Map<string, CardType>; // O(1) lookups by card_type_id - efficient, stable references
  repoById: Map<string, Repo>; // O(1) lookups by repo_id - efficient, stable references
  worktreeById: Map<string, Worktree>; // Primary storage - efficient lookups, stable references
  userById: Map<string, User>; // O(1) lookups by user_id - efficient, stable references
  mcpServerById: Map<string, MCPServer>; // O(1) lookups by mcp_server_id - efficient, stable references
  gatewayChannelById: Map<string, GatewayChannel>; // O(1) lookups by id - efficient, stable references
  artifactById: Map<string, Artifact>; // O(1) lookups by artifact_id - efficient, stable references
  sessionMcpServerIds: Map<string, string[]>; // O(1) lookups by session_id - efficient, stable references
  userAuthenticatedMcpServerIds: Set<string>; // MCP server IDs where current user has valid per-user OAuth tokens
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
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
  const [sessionById, setSessionById] = useState<Map<string, Session>>(new Map());
  const [sessionsByWorktree, setSessionsByWorktree] = useState<Map<string, Session[]>>(new Map());
  const [boardById, setBoardById] = useState<Map<string, Board>>(new Map());
  const [boardObjectById, setBoardObjectById] = useState<Map<string, BoardEntityObject>>(new Map());
  const [commentById, setCommentById] = useState<Map<string, BoardComment>>(new Map());
  const [cardById, setCardById] = useState<Map<string, CardWithType>>(new Map());
  const [cardTypeById, setCardTypeById] = useState<Map<string, CardType>>(new Map());
  const [repoById, setRepoById] = useState<Map<string, Repo>>(new Map());
  const [worktreeById, setWorktreeById] = useState<Map<string, Worktree>>(new Map());
  const [userById, setUserById] = useState<Map<string, User>>(new Map());
  const [mcpServerById, setMcpServerById] = useState<Map<string, MCPServer>>(new Map());
  const [gatewayChannelById, setGatewayChannelById] = useState<Map<string, GatewayChannel>>(
    new Map()
  );
  const [artifactById, setArtifactById] = useState<Map<string, Artifact>>(new Map());
  const [sessionMcpServerIds, setSessionMcpServerIds] = useState<Map<string, string[]>>(new Map());
  const [userAuthenticatedMcpServerIds, setUserAuthenticatedMcpServerIds] = useState<Set<string>>(
    new Set()
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  const fetchData = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!client || !enabled) {
        return;
      }

      try {
        if (!silent) {
          setLoading(true);
          setError(null);
        }

        // Fetch sessions, boards, board-objects, comments, repos, worktrees, users, mcp servers, session-mcp relationships in parallel.
        // Task/message detail now comes from per-session reactive state in conversation components.
        const [
          sessionsList,
          boardsList,
          boardObjectsList,
          commentsList,
          cardsList,
          cardTypesList,
          reposList,
          worktreesList,
          usersList,
          mcpServersList,
          sessionMcpList,
          gatewayChannelsList,
          artifactsList,
          oauthStatusResult,
        ] = await Promise.all([
          client.service('sessions').findAll({
            query: { archived: false, $limit: PAGINATION.DEFAULT_LIMIT, $sort: { updated_at: -1 } },
          }),
          client.service('boards').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client.service('board-objects').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client.service('board-comments').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client.service('cards').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client.service('card-types').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client.service('repos').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client
            .service('worktrees')
            .findAll({ query: { archived: false, $limit: PAGINATION.DEFAULT_LIMIT } }),
          client.service('users').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client.service('mcp-servers').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client
            .service('session-mcp-servers')
            .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client
            .service('gateway-channels')
            .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client.service('artifacts').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
          client
            .service('mcp-servers/oauth-status')
            .find()
            .catch(() => ({ authenticated_server_ids: [] })),
        ]);

        // Build session Maps for efficient lookups
        const sessionsById = new Map<string, Session>();
        const sessionsByWorktreeId = new Map<string, Session[]>();

        for (const session of sessionsList) {
          // sessionById: O(1) ID lookups
          sessionsById.set(session.session_id, session);

          // sessionsByWorktree: O(1) worktree-scoped filtering
          const worktreeId = session.worktree_id;
          if (!sessionsByWorktreeId.has(worktreeId)) {
            sessionsByWorktreeId.set(worktreeId, []);
          }
          sessionsByWorktreeId.get(worktreeId)!.push(session);
        }

        setSessionById(sessionsById);
        setSessionsByWorktree(sessionsByWorktreeId);

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

        // Build worktree Map for efficient lookups
        const worktreesMap = new Map<string, Worktree>();
        for (const worktree of worktreesList) {
          worktreesMap.set(worktree.worktree_id, worktree);
        }
        setWorktreeById(worktreesMap);

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

  // Subscribe to real-time updates
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

      // Update sessionsByWorktree - only create new Map when adding new session
      setSessionsByWorktree((prev) => {
        const worktreeSessions = prev.get(session.worktree_id) || [];
        // Check if session already exists in this worktree (duplicate event)
        if (worktreeSessions.some((s) => s.session_id === session.session_id)) return prev;

        const next = new Map(prev);
        next.set(session.worktree_id, [...worktreeSessions, session]);
        return next;
      });
    };
    const handleSessionPatched = (session: Session) => {
      const isArchived = session.archived === true;
      // Track old worktree_id for migration detection
      let oldWorktreeId: string | null = null;

      // Update sessionById - add/update active sessions, remove archived sessions
      setSessionById((prev) => {
        const existing = prev.get(session.session_id);

        // Capture old worktree_id before updating
        oldWorktreeId = existing?.worktree_id || null;

        if (isArchived) {
          if (!existing) return prev;
          const next = new Map(prev);
          next.delete(session.session_id);
          return next;
        }

        if (existing === session) return prev; // Same reference, no change

        const next = new Map(prev);
        next.set(session.session_id, session);
        return next;
      });

      // Update sessionsByWorktree - keep active sessions only
      setSessionsByWorktree((prev) => {
        let changed = false;
        const next = new Map(prev);
        const newWorktreeId = session.worktree_id;

        const removeFromWorktree = (worktreeId: string) => {
          const bucket = next.get(worktreeId) || [];
          const filtered = bucket.filter((s) => s.session_id !== session.session_id);
          if (filtered.length !== bucket.length) {
            changed = true;
            if (filtered.length > 0) {
              next.set(worktreeId, filtered);
            } else {
              next.delete(worktreeId);
            }
          }
        };

        if (isArchived) {
          if (oldWorktreeId) {
            removeFromWorktree(oldWorktreeId);
          }
          removeFromWorktree(newWorktreeId);
          return changed ? next : prev;
        }

        // Session moved between worktrees - remove from old bucket first
        const worktreeMigrated = oldWorktreeId && oldWorktreeId !== newWorktreeId;
        if (worktreeMigrated) {
          removeFromWorktree(oldWorktreeId!);
        }

        const worktreeSessions = next.get(newWorktreeId) || [];
        const index = worktreeSessions.findIndex((s) => s.session_id === session.session_id);

        if (index === -1) {
          next.set(newWorktreeId, [...worktreeSessions, session]);
          return next;
        }

        if (worktreeSessions[index] === session) {
          return changed ? next : prev;
        }

        const updatedSessions = [...worktreeSessions];
        updatedSessions[index] = session;
        next.set(newWorktreeId, updatedSessions);
        return next;
      });
    };
    const handleSessionRemoved = (session: Session) => {
      // Update sessionById
      setSessionById((prev) => {
        const next = new Map(prev);
        next.delete(session.session_id);
        return next;
      });

      // Update sessionsByWorktree
      setSessionsByWorktree((prev) => {
        const next = new Map(prev);
        const worktreeSessions = next.get(session.worktree_id) || [];
        const filtered = worktreeSessions.filter((s) => s.session_id !== session.session_id);
        if (filtered.length > 0) {
          next.set(session.worktree_id, filtered);
        } else {
          // Clean up empty arrays
          next.delete(session.worktree_id);
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
      setBoardById((prev) => {
        const existing = prev.get(board.board_id);
        if (existing === board) {
          return prev; // Same reference, no change
        }
        const next = new Map(prev);
        next.set(board.board_id, board);
        return next;
      });
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
      setBoardObjectById((prev) => {
        const existing = prev.get(boardObject.object_id);
        if (existing === boardObject) return prev; // Same reference, no change
        const next = new Map(prev);
        next.set(boardObject.object_id, boardObject);
        return next;
      });
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
      setRepoById((prev) => {
        const existing = prev.get(repo.repo_id);
        if (existing === repo) return prev; // Same reference, no change
        const next = new Map(prev);
        next.set(repo.repo_id, repo);
        return next;
      });
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

    // Subscribe to worktree events
    const worktreesService = client.service('worktrees');
    const handleWorktreeCreated = (worktree: Worktree) => {
      if (worktree.archived) return;

      setWorktreeById((prev) => {
        if (prev.has(worktree.worktree_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(worktree.worktree_id, worktree);
        return next;
      });
    };
    const handleWorktreePatched = (worktree: Worktree) => {
      if (worktree.archived) {
        // Remove archived worktree from core map
        setWorktreeById((prev) => {
          if (!prev.has(worktree.worktree_id)) return prev;
          const next = new Map(prev);
          next.delete(worktree.worktree_id);
          return next;
        });

        // Remove sessions under archived worktree from core maps
        setSessionsByWorktree((prev) => {
          if (!prev.has(worktree.worktree_id)) return prev;
          const next = new Map(prev);
          next.delete(worktree.worktree_id);
          return next;
        });
        setSessionById((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const [sessionId, session] of prev.entries()) {
            if (session.worktree_id === worktree.worktree_id) {
              next.delete(sessionId);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        return;
      }

      setWorktreeById((prev) => {
        const existing = prev.get(worktree.worktree_id);
        if (existing === worktree) return prev; // Same reference, no change
        const next = new Map(prev);
        next.set(worktree.worktree_id, worktree);
        return next;
      });
    };
    const handleWorktreeRemoved = (worktree: Worktree) => {
      setWorktreeById((prev) => {
        if (!prev.has(worktree.worktree_id)) return prev; // Doesn't exist, nothing to remove
        const next = new Map(prev);
        next.delete(worktree.worktree_id);
        return next;
      });
    };

    worktreesService.on('created', handleWorktreeCreated);
    worktreesService.on('patched', handleWorktreePatched);
    worktreesService.on('updated', handleWorktreePatched);
    worktreesService.on('removed', handleWorktreeRemoved);

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
      setUserById((prev) => {
        const existing = prev.get(user.user_id);
        if (existing === user) return prev; // Same reference, no change
        const next = new Map(prev);
        next.set(user.user_id, user);
        return next;
      });
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
      setMcpServerById((prev) => {
        const existing = prev.get(server.mcp_server_id);
        if (existing === server) return prev; // Same reference, no change
        const next = new Map(prev);
        next.set(server.mcp_server_id, server);
        return next;
      });
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
      setGatewayChannelById((prev) => {
        const existing = prev.get(channel.id);
        if (existing === channel) return prev;
        const next = new Map(prev);
        next.set(channel.id, channel);
        return next;
      });
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
        const next = new Map(prev);
        next.set(card.card_id, card);
        return next;
      });
    };
    const handleCardPatched = (card: CardWithType) => {
      setCardById((prev) => {
        const existing = prev.get(card.card_id);
        if (existing === card) return prev;
        const next = new Map(prev);
        next.set(card.card_id, card);
        return next;
      });
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
        const next = new Map(prev);
        next.set(cardType.card_type_id, cardType);
        return next;
      });
    };
    const handleCardTypePatched = (cardType: CardType) => {
      setCardTypeById((prev) => {
        const existing = prev.get(cardType.card_type_id);
        if (existing === cardType) return prev;
        const next = new Map(prev);
        next.set(cardType.card_type_id, cardType);
        return next;
      });
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
      setArtifactById((prev) => {
        const existing = prev.get(artifact.artifact_id);
        if (existing === artifact) return prev;
        const next = new Map(prev);
        next.set(artifact.artifact_id, artifact);
        return next;
      });
      // Notify ArtifactNode components that payload may have changed
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
      setCommentById((prev) => {
        const existing = prev.get(comment.comment_id);
        if (existing === comment) return prev; // Same reference, no change
        const next = new Map(prev);
        next.set(comment.comment_id, comment);
        return next;
      });
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
        setMcpServerById((prev) => {
          const next = new Map(prev);
          next.set(fresh.mcp_server_id, fresh);
          return next;
        });
      } catch (err) {
        console.warn('[OAuth] Failed to refetch MCP server after re-auth:', err);
      }
    };
    client.io.on('oauth:completed', handleOAuthCompleted);

    // Re-fetch the global byId maps on every socket reconnect after the
    // initial mount. Feathers real-time events (`created`/`patched`/`removed`)
    // that fired while we were disconnected are gone — the daemon doesn't
    // keep a per-subscriber replay log — so without this, the app keeps
    // showing stale state (vanished worktrees still on the board, missed new
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

      worktreesService.removeListener('created', handleWorktreeCreated);
      worktreesService.removeListener('patched', handleWorktreePatched);
      worktreesService.removeListener('updated', handleWorktreePatched);
      worktreesService.removeListener('removed', handleWorktreeRemoved);

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
    };
  }, [client, enabled, fetchData, hasInitiallyFetched]);

  return {
    sessionById,
    sessionsByWorktree,
    boardById,
    boardObjectById,
    commentById,
    cardById,
    cardTypeById,
    repoById,
    worktreeById,
    userById,
    mcpServerById,
    gatewayChannelById,
    artifactById,
    sessionMcpServerIds,
    userAuthenticatedMcpServerIds,
    loading,
    error,
    refetch: fetchData,
  };
}
