// @ts-nocheck - Complex WebSocket event handling with dynamic types
/**
 * React hook for fetching and subscribing to Agor data
 *
 * Manages sessions, tasks, boards with real-time WebSocket updates
 */

import type { AgorClient } from '@agor/core/api';
import type {
  Board,
  BoardComment,
  BoardEntityObject,
  MCPServer,
  Repo,
  Session,
  Task,
  User,
  Worktree,
} from '@agor/core/types';
import { useCallback, useEffect, useState } from 'react';

interface UseAgorDataResult {
  sessionById: Map<string, Session>; // O(1) lookups by session_id - efficient, stable references
  sessionsByWorktree: Map<string, Session[]>; // O(1) worktree-scoped filtering
  tasks: Record<string, Task[]>;
  boards: Board[];
  boardObjects: BoardEntityObject[]; // Positioned worktrees on boards
  comments: BoardComment[]; // Board comments for collaboration
  repos: Repo[];
  worktreeById: Map<string, Worktree>; // Primary storage - efficient lookups, stable references
  users: User[];
  mcpServers: MCPServer[];
  sessionMcpServerIds: Record<string, string[]>; // Map: sessionId -> mcpServerIds[]
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch and subscribe to Agor data from daemon
 *
 * @param client - Agor client instance
 * @returns Sessions, tasks (grouped by session), boards, loading state, and refetch function
 */
export function useAgorData(client: AgorClient | null): UseAgorDataResult {
  const [sessionById, setSessionById] = useState<Map<string, Session>>(new Map());
  const [sessionsByWorktree, setSessionsByWorktree] = useState<Map<string, Session[]>>(new Map());
  const [tasks, setTasks] = useState<Record<string, Task[]>>({});
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardObjects, setBoardObjects] = useState<BoardEntityObject[]>([]);
  const [comments, setComments] = useState<BoardComment[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [worktreeById, setWorktreeById] = useState<Map<string, Worktree>>(new Map());
  const [users, setUsers] = useState<User[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [sessionMcpServerIds, setSessionMcpServerIds] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track if we've done initial fetch - prevents refetch on reconnection
  // WebSocket events keep data synchronized in real-time
  const [hasInitiallyFetched, setHasInitiallyFetched] = useState(false);

  // Fetch all data
  const fetchData = useCallback(async () => {
    if (!client) {
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Fetch sessions, tasks, boards, board-objects, comments, repos, worktrees, users, mcp servers, session-mcp relationships in parallel
      const [
        sessionsResult,
        tasksResult,
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
          .find({ query: { $limit: 1000, $sort: { updated_at: -1 } } }), // Fetch up to 1000 sessions, sorted by most recent
        client
          .service('tasks')
          .find({ query: { $limit: 500 } }), // Fetch up to 500 tasks
        client.service('boards').find(),
        client.service('board-objects').find(),
        client
          .service('board-comments')
          .find({ query: { $limit: 500 } }), // Fetch up to 500 comments
        client.service('repos').find(),
        client.service('worktrees').find(),
        client.service('users').find(),
        client.service('mcp-servers').find(),
        client.service('session-mcp-servers').find(),
      ]);

      // Handle paginated vs array results
      const sessionsList = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data;
      const tasksList = Array.isArray(tasksResult) ? tasksResult : tasksResult.data;
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

      // Group tasks by session_id
      const tasksMap: Record<string, Task[]> = {};
      for (const task of tasksList) {
        if (!tasksMap[task.session_id]) {
          tasksMap[task.session_id] = [];
        }
        tasksMap[task.session_id].push(task);
      }
      setTasks(tasksMap);

      setBoards(boardsList);
      setBoardObjects(boardObjectsList);
      setComments(commentsList);
      setRepos(reposList);

      // Build worktree Map for efficient lookups
      const worktreesMap = new Map<string, Worktree>();
      for (const worktree of worktreesList) {
        worktreesMap.set(worktree.worktree_id, worktree);
      }
      setWorktreeById(worktreesMap);

      setUsers(usersList);
      setMcpServers(mcpServersList);

      // Group session-MCP relationships by session_id
      const sessionMcpMap: Record<string, string[]> = {};
      for (const relationship of sessionMcpList) {
        if (!sessionMcpMap[relationship.session_id]) {
          sessionMcpMap[relationship.session_id] = [];
        }
        sessionMcpMap[relationship.session_id].push(relationship.mcp_server_id);
      }
      setSessionMcpServerIds(sessionMcpMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [client]);

  // Subscribe to real-time updates
  useEffect(() => {
    if (!client) {
      // No client = not authenticated, set loading to false
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
        const next = new Map(prev);
        next.set(session.worktree_id, [...worktreeSessions, session]);
        return next;
      });
    };
    const handleSessionPatched = (session: Session) => {
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

          return next;
        }

        // Session not found in this worktree and didn't migrate (shouldn't happen, but be safe)
        if (index === -1) return prev;

        // Check if session actually changed (reference equality is sufficient for socket updates)
        if (worktreeSessions[index] === session) return prev;

        // Create new array with updated session (in-place update)
        const updatedSessions = [...worktreeSessions];
        updatedSessions[index] = session;

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

    // Subscribe to task events
    const tasksService = client.service('tasks');
    const handleTaskCreated = (task: Task) => {
      setTasks((prev) => ({
        ...prev,
        [task.session_id]: [...(prev[task.session_id] || []), task],
      }));
    };
    const handleTaskPatched = (task: Task) => {
      setTasks((prev) => ({
        ...prev,
        [task.session_id]: (prev[task.session_id] || []).map((t) =>
          t.task_id === task.task_id ? task : t
        ),
      }));
    };
    const handleTaskRemoved = (task: Task) => {
      setTasks((prev) => ({
        ...prev,
        [task.session_id]: (prev[task.session_id] || []).filter((t) => t.task_id !== task.task_id),
      }));
    };

    tasksService.on('created', handleTaskCreated);
    tasksService.on('patched', handleTaskPatched);
    tasksService.on('updated', handleTaskPatched);
    tasksService.on('removed', handleTaskRemoved);

    // Subscribe to board events
    const boardsService = client.service('boards');
    const handleBoardCreated = (board: Board) => {
      setBoards((prev) => [...prev, board]);
    };
    const handleBoardPatched = (board: Board) => {
      setBoards((prev) => prev.map((b) => (b.board_id === board.board_id ? board : b)));
    };
    const handleBoardRemoved = (board: Board) => {
      setBoards((prev) => prev.filter((b) => b.board_id !== board.board_id));
    };

    boardsService.on('created', handleBoardCreated);
    boardsService.on('patched', handleBoardPatched);
    boardsService.on('updated', handleBoardPatched);
    boardsService.on('removed', handleBoardRemoved);

    // Subscribe to board object events
    const boardObjectsService = client.service('board-objects');
    const handleBoardObjectCreated = (boardObject: BoardEntityObject) => {
      setBoardObjects((prev) => [...prev, boardObject]);
    };
    const handleBoardObjectPatched = (boardObject: BoardEntityObject) => {
      setBoardObjects((prev) =>
        prev.map((bo) => (bo.object_id === boardObject.object_id ? boardObject : bo))
      );
    };
    const handleBoardObjectRemoved = (boardObject: BoardEntityObject) => {
      setBoardObjects((prev) => prev.filter((bo) => bo.object_id !== boardObject.object_id));
    };

    boardObjectsService.on('created', handleBoardObjectCreated);
    boardObjectsService.on('patched', handleBoardObjectPatched);
    boardObjectsService.on('updated', handleBoardObjectPatched);
    boardObjectsService.on('removed', handleBoardObjectRemoved);

    // Subscribe to repo events
    const reposService = client.service('repos');
    const handleRepoCreated = (repo: Repo) => {
      setRepos((prev) => [...prev, repo]);
    };
    const handleRepoPatched = (repo: Repo) => {
      setRepos((prev) => prev.map((r) => (r.repo_id === repo.repo_id ? repo : r)));
    };
    const handleRepoRemoved = (repo: Repo) => {
      setRepos((prev) => prev.filter((r) => r.repo_id !== repo.repo_id));
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
      setUsers((prev) => [...prev, user]);
    };
    const handleUserPatched = (user: User) => {
      setUsers((prev) => prev.map((u) => (u.user_id === user.user_id ? user : u)));
    };
    const handleUserRemoved = (user: User) => {
      setUsers((prev) => prev.filter((u) => u.user_id !== user.user_id));
    };

    usersService.on('created', handleUserCreated);
    usersService.on('patched', handleUserPatched);
    usersService.on('updated', handleUserPatched);
    usersService.on('removed', handleUserRemoved);

    // Subscribe to MCP server events
    const mcpServersService = client.service('mcp-servers');
    const handleMCPServerCreated = (server: MCPServer) => {
      setMcpServers((prev) => [...prev, server]);
    };
    const handleMCPServerPatched = (server: MCPServer) => {
      setMcpServers((prev) =>
        prev.map((s) => (s.mcp_server_id === server.mcp_server_id ? server : s))
      );
    };
    const handleMCPServerRemoved = (server: MCPServer) => {
      setMcpServers((prev) => prev.filter((s) => s.mcp_server_id !== server.mcp_server_id));
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
      setSessionMcpServerIds((prev) => ({
        ...prev,
        [relationship.session_id]: [
          ...(prev[relationship.session_id] || []),
          relationship.mcp_server_id,
        ],
      }));
    };
    const handleSessionMcpRemoved = (relationship: {
      session_id: string;
      mcp_server_id: string;
    }) => {
      setSessionMcpServerIds((prev) => ({
        ...prev,
        [relationship.session_id]: (prev[relationship.session_id] || []).filter(
          (id) => id !== relationship.mcp_server_id
        ),
      }));
    };

    sessionMcpService.on('created', handleSessionMcpCreated);
    sessionMcpService.on('removed', handleSessionMcpRemoved);

    // Subscribe to board comment events
    const commentsService = client.service('board-comments');
    const handleCommentCreated = (comment: BoardComment) => {
      setComments((prev) => [...prev, comment]);
    };
    const handleCommentPatched = (comment: BoardComment) => {
      setComments((prev) => prev.map((c) => (c.comment_id === comment.comment_id ? comment : c)));
    };
    const handleCommentRemoved = (comment: BoardComment) => {
      setComments((prev) => prev.filter((c) => c.comment_id !== comment.comment_id));
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

      tasksService.removeListener('created', handleTaskCreated);
      tasksService.removeListener('patched', handleTaskPatched);
      tasksService.removeListener('updated', handleTaskPatched);
      tasksService.removeListener('removed', handleTaskRemoved);

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
  }, [client, fetchData, hasInitiallyFetched]);

  return {
    sessionById,
    sessionsByWorktree,
    tasks,
    boards,
    boardObjects,
    comments,
    repos,
    worktreeById,
    users,
    mcpServers,
    sessionMcpServerIds,
    loading,
    error,
    refetch: fetchData,
  };
}
