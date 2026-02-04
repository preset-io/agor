// @ts-nocheck - Complex WebSocket event handling with dynamic types
/**
 * React hook for fetching and subscribing to Agor data
 *
 * Manages sessions, tasks, boards with real-time WebSocket updates
 */

import type { AgorClient } from '@agor/core/api';
import { PAGINATION } from '@agor/core/config/browser';
import type {
  Board,
  BoardComment,
  BoardEntityObject,
  MCPServer,
  Repo,
  Session,
  User,
  Worktree,
} from '@agor/core/types';
import { useCallback, useEffect, useState } from 'react';

interface UseAgorDataResult {
  sessionById: Map<string, Session>; // O(1) lookups by session_id - efficient, stable references
  sessionsByWorktree: Map<string, Session[]>; // O(1) worktree-scoped filtering
  boardById: Map<string, Board>; // O(1) lookups by board_id - efficient, stable references
  boardObjectById: Map<string, BoardEntityObject>; // O(1) lookups by object_id - efficient, stable references
  commentById: Map<string, BoardComment>; // O(1) lookups by comment_id - efficient, stable references
  repoById: Map<string, Repo>; // O(1) lookups by repo_id - efficient, stable references
  worktreeById: Map<string, Worktree>; // Primary storage - efficient lookups, stable references
  userById: Map<string, User>; // O(1) lookups by user_id - efficient, stable references
  mcpServerById: Map<string, MCPServer>; // O(1) lookups by mcp_server_id - efficient, stable references
  sessionMcpServerIds: Map<string, string[]>; // O(1) lookups by session_id - efficient, stable references
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
 * @returns Sessions, boards, loading state, and refetch function (tasks fetched just-in-time via useTasks)
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
  const [repoById, setRepoById] = useState<Map<string, Repo>>(new Map());
  const [worktreeById, setWorktreeById] = useState<Map<string, Worktree>>(new Map());
  const [userById, setUserById] = useState<Map<string, User>>(new Map());
  const [mcpServerById, setMcpServerById] = useState<Map<string, MCPServer>>(new Map());
  const [sessionMcpServerIds, setSessionMcpServerIds] = useState<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track if we've done initial fetch - prevents refetch on reconnection
  // WebSocket events keep data synchronized in real-time
  const [hasInitiallyFetched, setHasInitiallyFetched] = useState(false);

  // Fetch all data
  const fetchData = useCallback(async () => {
    if (!client || !enabled) {
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Fetch sessions, boards, board-objects, comments, repos, worktrees, users, mcp servers, session-mcp relationships in parallel
      // Tasks are fetched just-in-time via useTasks hook to avoid unnecessary global subscriptions
      const [
        sessionsResult,
        boardsResult,
        boardObjectsResult,
        commentsResult,
        reposResult,
        worktreesResult,
        usersResult,
        mcpServersResult,
        sessionMcpResult,
      ] = await Promise.all([
        client
          .service('sessions')
          .find({ query: { $limit: PAGINATION.DEFAULT_LIMIT, $sort: { updated_at: -1 } } }),
        client.service('boards').find({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
        client.service('board-objects').find({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
        client.service('board-comments').find({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
        client.service('repos').find({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
        client.service('worktrees').find({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
        client.service('users').find({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
        client.service('mcp-servers').find({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
        client.service('session-mcp-servers').find({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }),
      ]);

      // Handle paginated vs array results
      const sessionsList = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data;
      const boardsList = Array.isArray(boardsResult) ? boardsResult : boardsResult.data;
      const boardObjectsList = Array.isArray(boardObjectsResult)
        ? boardObjectsResult
        : boardObjectsResult.data;
      const commentsList = Array.isArray(commentsResult) ? commentsResult : commentsResult.data;
      const reposList = Array.isArray(reposResult) ? reposResult : reposResult.data;
      const worktreesList = Array.isArray(worktreesResult) ? worktreesResult : worktreesResult.data;
      const usersList = Array.isArray(usersResult) ? usersResult : usersResult.data;
      const mcpServersList = Array.isArray(mcpServersResult)
        ? mcpServersResult
        : mcpServersResult.data;
      const sessionMcpList = Array.isArray(sessionMcpResult)
        ? sessionMcpResult
        : sessionMcpResult.data;

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
        console.log('[useAgorData] Loading MCP server:', {
          name: mcpServer.name,
          mcp_server_id: mcpServer.mcp_server_id.substring(0, 8),
          tools: mcpServer.tools,
          toolCount: mcpServer.tools?.length || 0,
        });
        mcpServersMap.set(mcpServer.mcp_server_id, mcpServer);
      }
      setMcpServerById(mcpServersMap);

      // Group session-MCP relationships by session_id
      const sessionMcpMap = new Map<string, string[]>();
      for (const relationship of sessionMcpList) {
        if (!sessionMcpMap.has(relationship.session_id)) {
          sessionMcpMap.set(relationship.session_id, []);
        }
        sessionMcpMap.get(relationship.session_id)!.push(relationship.mcp_server_id);
      }
      setSessionMcpServerIds(sessionMcpMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [client, enabled]);

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
      console.log(`🔄 [useAgorData] Session patched:`, {
        session_id: session.session_id.substring(0, 8),
        status: session.status,
        ready_for_prompt: session.ready_for_prompt,
      });

      // Track old worktree_id for migration detection
      let oldWorktreeId: string | null = null;

      // Update sessionById - ONLY create new Map if session changed
      setSessionById((prev) => {
        const existing = prev.get(session.session_id);
        if (existing === session) return prev; // Same reference, no change

        // Capture old worktree_id before updating
        oldWorktreeId = existing?.worktree_id || null;

        const next = new Map(prev);
        next.set(session.session_id, session);
        return next;
      });

      // Update sessionsByWorktree - handle both in-place updates and worktree migrations
      setSessionsByWorktree((prev) => {
        const newWorktreeId = session.worktree_id;
        const worktreeSessions = prev.get(newWorktreeId) || [];
        const index = worktreeSessions.findIndex((s) => s.session_id === session.session_id);

        // Check if session migrated to a different worktree
        const worktreeMigrated = oldWorktreeId && oldWorktreeId !== newWorktreeId;

        if (worktreeMigrated) {
          // Session moved between worktrees - remove from old, add to new
          const next = new Map(prev);

          // Remove from old worktree bucket
          const oldSessions = prev.get(oldWorktreeId!) || [];
          const filteredOldSessions = oldSessions.filter(
            (s) => s.session_id !== session.session_id
          );
          if (filteredOldSessions.length > 0) {
            next.set(oldWorktreeId!, filteredOldSessions);
          } else {
            next.delete(oldWorktreeId!); // Remove empty bucket
          }

          // Add to new worktree bucket
          const newSessions = prev.get(newWorktreeId) || [];
          next.set(newWorktreeId, [...newSessions, session]);

          console.log(
            `🔄 [useAgorData] sessionsByWorktree updated (MIGRATED) for worktree ${newWorktreeId.substring(0, 8)}`
          );
          return next;
        }

        // Session not found in this worktree and didn't migrate (shouldn't happen, but be safe)
        if (index === -1) {
          console.log(
            `⚠️ [useAgorData] Session ${session.session_id.substring(0, 8)} not found in worktree ${newWorktreeId.substring(0, 8)}, skipping sessionsByWorktree update`
          );
          return prev;
        }

        // Check if session actually changed (reference equality is sufficient for socket updates)
        if (worktreeSessions[index] === session) {
          console.log(
            `🔄 [useAgorData] Session ${session.session_id.substring(0, 8)} reference unchanged, skipping sessionsByWorktree update`
          );
          return prev;
        }

        // Create new array with updated session (in-place update)
        const updatedSessions = [...worktreeSessions];
        updatedSessions[index] = session;

        const oldArrayRef = worktreeSessions;
        const newArrayRef = updatedSessions;
        console.log(
          `🔄 [useAgorData] sessionsByWorktree updated for worktree ${newWorktreeId.substring(0, 8)}`,
          {
            arrayRefChanged: oldArrayRef !== newArrayRef,
            oldLength: oldArrayRef.length,
            newLength: newArrayRef.length,
            sessionIndex: index,
            sessionStatus: session.status,
          }
        );

        // Only create new Map with updated worktree entry
        const next = new Map(prev);
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
      console.log('🔄 [useAgorData] Board patched:', {
        board_id: board.board_id.substring(0, 8),
        objectsCount: Object.keys(board.objects || {}).length,
        objects: board.objects,
      });
      setBoardById((prev) => {
        const existing = prev.get(board.board_id);
        if (existing === board) {
          console.log('⚠️ [useAgorData] Board reference unchanged, skipping update');
          return prev; // Same reference, no change
        }
        console.log('✅ [useAgorData] Updating boardById Map with new board');
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
      setWorktreeById((prev) => {
        if (prev.has(worktree.worktree_id)) return prev; // Already exists, shouldn't happen
        const next = new Map(prev);
        next.set(worktree.worktree_id, worktree);
        return next;
      });
    };
    const handleWorktreePatched = (worktree: Worktree) => {
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
      console.log('[useAgorData] MCP server patched:', {
        name: server.name,
        mcp_server_id: server.mcp_server_id.substring(0, 8),
        tools: server.tools,
        toolCount: server.tools?.length || 0,
      });
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

    // Cleanup listeners on unmount
    return () => {
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
    };
  }, [client, enabled, fetchData, hasInitiallyFetched]);

  return {
    sessionById,
    sessionsByWorktree,
    boardById,
    boardObjectById,
    commentById,
    repoById,
    worktreeById,
    userById,
    mcpServerById,
    sessionMcpServerIds,
    loading,
    error,
    refetch: fetchData,
  };
}
