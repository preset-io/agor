/**
 * React hook for fetching and subscribing to Agor data
 *
 * Manages sessions, tasks, boards with real-time WebSocket updates
 */

import type { AgorClient } from '@agor/core/api';
import type { Board, MCPServer, Repo, Session, Task, User } from '@agor/core/types';
import { useCallback, useEffect, useState } from 'react';

interface UseAgorDataResult {
  sessions: Session[];
  tasks: Record<string, Task[]>;
  boards: Board[];
  repos: Repo[];
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
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tasks, setTasks] = useState<Record<string, Task[]>>({});
  const [boards, setBoards] = useState<Board[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [sessionMcpServerIds, setSessionMcpServerIds] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch all data
  const fetchData = useCallback(async () => {
    if (!client) {
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Fetch sessions, tasks, boards, repos, users, mcp servers, session-mcp relationships in parallel
      const [
        sessionsResult,
        tasksResult,
        boardsResult,
        reposResult,
        usersResult,
        mcpServersResult,
        sessionMcpResult,
      ] = await Promise.all([
        client.service('sessions').find(),
        client.service('tasks').find({ query: { $limit: 500 } }), // Fetch up to 500 tasks
        client.service('boards').find(),
        client.service('repos').find(),
        client.service('users').find(),
        client.service('mcp-servers').find(),
        client.service('session-mcp-servers').find(),
      ]);

      // Handle paginated vs array results
      const sessionsList = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data;
      const tasksList = Array.isArray(tasksResult) ? tasksResult : tasksResult.data;
      const boardsList = Array.isArray(boardsResult) ? boardsResult : boardsResult.data;
      const reposList = Array.isArray(reposResult) ? reposResult : reposResult.data;
      const usersList = Array.isArray(usersResult) ? usersResult : usersResult.data;
      const mcpServersList = Array.isArray(mcpServersResult)
        ? mcpServersResult
        : mcpServersResult.data;
      const sessionMcpList = Array.isArray(sessionMcpResult)
        ? sessionMcpResult
        : sessionMcpResult.data;

      setSessions(sessionsList);

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
      setRepos(reposList);
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

    // Initial fetch
    fetchData();

    // Subscribe to session events
    const sessionsService = client.service('sessions');
    const handleSessionCreated = (session: Session) => {
      setSessions(prev => [...prev, session]);
    };
    const handleSessionPatched = (session: Session) => {
      setSessions(prev => prev.map(s => (s.session_id === session.session_id ? session : s)));
    };
    const handleSessionRemoved = (session: Session) => {
      setSessions(prev => prev.filter(s => s.session_id !== session.session_id));
    };

    sessionsService.on('created', handleSessionCreated);
    sessionsService.on('patched', handleSessionPatched);
    sessionsService.on('updated', handleSessionPatched);
    sessionsService.on('removed', handleSessionRemoved);

    // Subscribe to task events
    const tasksService = client.service('tasks');
    const handleTaskCreated = (task: Task) => {
      setTasks(prev => ({
        ...prev,
        [task.session_id]: [...(prev[task.session_id] || []), task],
      }));
    };
    const handleTaskPatched = (task: Task) => {
      setTasks(prev => ({
        ...prev,
        [task.session_id]: (prev[task.session_id] || []).map(t =>
          t.task_id === task.task_id ? task : t
        ),
      }));
    };
    const handleTaskRemoved = (task: Task) => {
      setTasks(prev => ({
        ...prev,
        [task.session_id]: (prev[task.session_id] || []).filter(t => t.task_id !== task.task_id),
      }));
    };

    tasksService.on('created', handleTaskCreated);
    tasksService.on('patched', handleTaskPatched);
    tasksService.on('updated', handleTaskPatched);
    tasksService.on('removed', handleTaskRemoved);

    // Subscribe to board events
    const boardsService = client.service('boards');
    const handleBoardCreated = (board: Board) => {
      setBoards(prev => [...prev, board]);
    };
    const handleBoardPatched = (board: Board) => {
      setBoards(prev => prev.map(b => (b.board_id === board.board_id ? board : b)));
    };
    const handleBoardRemoved = (board: Board) => {
      setBoards(prev => prev.filter(b => b.board_id !== board.board_id));
    };

    boardsService.on('created', handleBoardCreated);
    boardsService.on('patched', handleBoardPatched);
    boardsService.on('updated', handleBoardPatched);
    boardsService.on('removed', handleBoardRemoved);

    // Subscribe to repo events
    const reposService = client.service('repos');
    const handleRepoCreated = (repo: Repo) => {
      setRepos(prev => [...prev, repo]);
    };
    const handleRepoPatched = (repo: Repo) => {
      setRepos(prev => prev.map(r => (r.repo_id === repo.repo_id ? repo : r)));
    };
    const handleRepoRemoved = (repo: Repo) => {
      setRepos(prev => prev.filter(r => r.repo_id !== repo.repo_id));
    };

    reposService.on('created', handleRepoCreated);
    reposService.on('patched', handleRepoPatched);
    reposService.on('updated', handleRepoPatched);
    reposService.on('removed', handleRepoRemoved);

    // Subscribe to user events
    const usersService = client.service('users');
    const handleUserCreated = (user: User) => {
      setUsers(prev => [...prev, user]);
    };
    const handleUserPatched = (user: User) => {
      setUsers(prev => prev.map(u => (u.user_id === user.user_id ? user : u)));
    };
    const handleUserRemoved = (user: User) => {
      setUsers(prev => prev.filter(u => u.user_id !== user.user_id));
    };

    usersService.on('created', handleUserCreated);
    usersService.on('patched', handleUserPatched);
    usersService.on('updated', handleUserPatched);
    usersService.on('removed', handleUserRemoved);

    // Subscribe to MCP server events
    const mcpServersService = client.service('mcp-servers');
    const handleMCPServerCreated = (server: MCPServer) => {
      setMcpServers(prev => [...prev, server]);
    };
    const handleMCPServerPatched = (server: MCPServer) => {
      setMcpServers(prev => prev.map(s => (s.mcp_server_id === server.mcp_server_id ? server : s)));
    };
    const handleMCPServerRemoved = (server: MCPServer) => {
      setMcpServers(prev => prev.filter(s => s.mcp_server_id !== server.mcp_server_id));
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
      setSessionMcpServerIds(prev => ({
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
      setSessionMcpServerIds(prev => ({
        ...prev,
        [relationship.session_id]: (prev[relationship.session_id] || []).filter(
          id => id !== relationship.mcp_server_id
        ),
      }));
    };

    sessionMcpService.on('created', handleSessionMcpCreated);
    sessionMcpService.on('removed', handleSessionMcpRemoved);

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

      reposService.removeListener('created', handleRepoCreated);
      reposService.removeListener('patched', handleRepoPatched);
      reposService.removeListener('updated', handleRepoPatched);
      reposService.removeListener('removed', handleRepoRemoved);

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
    };
  }, [client, fetchData]);

  return {
    sessions,
    tasks,
    boards,
    repos,
    users,
    mcpServers,
    sessionMcpServerIds,
    loading,
    error,
    refetch: fetchData,
  };
}
