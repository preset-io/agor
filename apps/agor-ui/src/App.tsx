import { getRepoReferenceOptions } from '@agor/core/config';
import { Alert, App as AntApp, ConfigProvider, Spin, theme } from 'antd';
import { App as AgorApp } from './components/App';
import { LoginPage } from './components/LoginPage';
import {
  useAgorClient,
  useAgorData,
  useAuth,
  useAuthConfig,
  useBoardActions,
  useSessionActions,
} from './hooks';
import { mockAgents } from './mocks';

function AppContent() {
  const { message } = AntApp.useApp();

  // Fetch daemon auth configuration
  const {
    config: authConfig,
    loading: authConfigLoading,
    error: authConfigError,
  } = useAuthConfig();

  // Authentication
  const {
    user,
    authenticated,
    loading: authLoading,
    error: authError,
    accessToken,
    login,
    logout,
  } = useAuth();

  // Call ALL hooks unconditionally BEFORE any conditional returns
  // Connect to daemon with authentication token
  // If auth not required and anonymous allowed, connect without token
  const {
    client,
    connected,
    connecting,
    error: connectionError,
  } = useAgorClient({
    accessToken: authenticated ? accessToken : null,
    allowAnonymous: authConfig?.allowAnonymous ?? false,
  });

  // Fetch data (only when connected and authenticated)
  const {
    sessions,
    tasks,
    boards,
    repos,
    users,
    mcpServers,
    sessionMcpServerIds,
    loading,
    error: dataError,
  } = useAgorData(connected ? client : null);

  // Session actions
  const { createSession, forkSession, spawnSession, updateSession, deleteSession } =
    useSessionActions(client);

  // Board actions
  const { createBoard, updateBoard, deleteBoard } = useBoardActions(client);

  // NOW handle conditional rendering based on state
  // Show loading while fetching auth config
  if (authConfigLoading) {
    return (
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <div
          style={{
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spin size="large" />
          <div style={{ marginTop: 16, color: 'rgba(255, 255, 255, 0.65)' }}>Loading...</div>
        </div>
      </ConfigProvider>
    );
  }

  // Show auth config error
  if (authConfigError) {
    return (
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <div
          style={{
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2rem',
          }}
        >
          <Alert
            type="warning"
            message="Could not fetch daemon configuration"
            description={
              <div>
                <p>{authConfigError.message}</p>
                <p>Defaulting to requiring authentication. Start the daemon with:</p>
                <p>
                  <code>cd apps/agor-daemon && pnpm dev</code>
                </p>
              </div>
            }
            showIcon
          />
        </div>
      </ConfigProvider>
    );
  }

  // Show login page if auth is required and not authenticated
  if (authConfig?.requireAuth && !authLoading && !authenticated) {
    return <LoginPage onLogin={login} error={authError} />;
  }

  // Show loading while checking authentication (only if auth is required)
  if (authConfig?.requireAuth && authLoading) {
    return (
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <div
          style={{
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spin size="large" />
          <div style={{ marginTop: 16, color: 'rgba(255, 255, 255, 0.65)' }}>Authenticating...</div>
        </div>
      </ConfigProvider>
    );
  }

  // Show connection error
  if (connectionError) {
    return (
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <div
          style={{
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2rem',
          }}
        >
          <Alert
            type="error"
            message="Failed to connect to Agor daemon"
            description={
              <div>
                <p>{connectionError}</p>
                <p>
                  Start the daemon with: <code>cd apps/agor-daemon && pnpm dev</code>
                </p>
              </div>
            }
            showIcon
          />
        </div>
      </ConfigProvider>
    );
  }

  // Show loading state
  if (connecting || loading) {
    return (
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <div
          style={{
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spin size="large" />
          <div style={{ marginTop: 16, color: 'rgba(255, 255, 255, 0.65)' }}>
            Connecting to daemon...
          </div>
        </div>
      </ConfigProvider>
    );
  }

  // Show data error
  if (dataError) {
    return (
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <div
          style={{
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2rem',
          }}
        >
          <Alert type="error" message="Failed to load data" description={dataError} showIcon />
        </div>
      </ConfigProvider>
    );
  }

  // Handle session creation
  const handleCreateSession = async (
    config: Parameters<React.ComponentProps<typeof AgorApp>['onCreateSession']>[0],
    boardId: string
  ) => {
    const session = await createSession(config);
    if (session) {
      // Add session to the current board using custom endpoint
      try {
        await client?.service(`boards/${boardId}/sessions`).create({
          sessionId: session.session_id,
        });

        // Associate MCP servers if provided
        if (config.mcpServerIds && config.mcpServerIds.length > 0) {
          for (const serverId of config.mcpServerIds) {
            try {
              await client?.service(`sessions/${session.session_id}/mcp-servers`).create({
                mcpServerId: serverId,
              });
            } catch (error) {
              console.error(`Failed to associate MCP server ${serverId}:`, error);
            }
          }
        }

        message.success('Session created and added to board!');

        // If there's an initial prompt, send it to the agent
        if (config.initialPrompt && config.initialPrompt.trim()) {
          await handleSendPrompt(session.session_id, config.initialPrompt);
        }
      } catch (error) {
        message.error(
          `Failed to add session to board: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      message.error('Failed to create session');
    }
  };

  // Handle fork session
  const handleForkSession = async (sessionId: string, prompt: string) => {
    const session = await forkSession(sessionId as import('@agor/core/types').SessionID, prompt);
    if (session) {
      message.success('Session forked successfully!');
    } else {
      message.error('Failed to fork session');
    }
  };

  // Handle spawn session
  const handleSpawnSession = async (sessionId: string, prompt: string) => {
    const session = await spawnSession(sessionId as import('@agor/core/types').SessionID, prompt);
    if (session) {
      message.success('Subtask session spawned successfully!');
    } else {
      message.error('Failed to spawn session');
    }
  };

  // Handle send prompt - calls Claude via daemon
  const handleSendPrompt = async (sessionId: string, prompt: string) => {
    if (!client) return;

    try {
      message.loading({ content: 'Sending prompt to Claude...', key: 'prompt', duration: 0 });

      await client.service(`sessions/${sessionId}/prompt`).create({
        prompt,
      });

      message.success({ content: 'Response received!', key: 'prompt' });
    } catch (error) {
      message.error({
        content: `Failed to send prompt: ${error instanceof Error ? error.message : String(error)}`,
        key: 'prompt',
      });
      console.error('Prompt error:', error);
    }
  };

  // Handle update session
  const handleUpdateSession = async (
    sessionId: string,
    updates: Partial<import('@agor/core/types').Session>
  ) => {
    const session = await updateSession(sessionId as import('@agor/core/types').SessionID, updates);
    if (session) {
      message.success('Session updated successfully!');
    } else {
      message.error('Failed to update session');
    }
  };

  // Handle delete session
  const handleDeleteSession = async (sessionId: string) => {
    const success = await deleteSession(sessionId as import('@agor/core/types').SessionID);
    if (success) {
      message.success('Session deleted successfully!');
    } else {
      message.error('Failed to delete session');
    }
  };

  // Handle create user
  const handleCreateUser = async (data: import('@agor/core/types').CreateUserInput) => {
    if (!client) return;
    try {
      await client.service('users').create(data);
      message.success('User created successfully!');
    } catch (error) {
      message.error(
        `Failed to create user: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Handle update user
  const handleUpdateUser = async (
    userId: string,
    updates: import('@agor/core/types').UpdateUserInput
  ) => {
    if (!client) return;
    try {
      await client.service('users').patch(userId, updates);
      message.success('User updated successfully!');
    } catch (error) {
      message.error(
        `Failed to update user: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Handle delete user
  const handleDeleteUser = async (userId: string) => {
    if (!client) return;
    try {
      await client.service('users').remove(userId);
      message.success('User deleted successfully!');
    } catch (error) {
      message.error(
        `Failed to delete user: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Handle board CRUD
  const handleCreateBoard = async (board: Partial<import('@agor/core/types').Board>) => {
    const created = await createBoard(board);
    if (created) {
      message.success('Board created successfully!');
    }
  };

  const handleUpdateBoard = async (
    boardId: string,
    updates: Partial<import('@agor/core/types').Board>
  ) => {
    const updated = await updateBoard(boardId as import('@agor/core/types').UUID, updates);
    if (updated) {
      message.success('Board updated successfully!');
    }
  };

  const handleDeleteBoard = async (boardId: string) => {
    const success = await deleteBoard(boardId as import('@agor/core/types').UUID);
    if (success) {
      message.success('Board deleted successfully!');
    }
  };

  // Handle repo CRUD
  const handleCreateRepo = async (data: { url: string; slug: string }) => {
    if (!client) return;
    try {
      message.loading({ content: 'Cloning repository...', key: 'clone-repo', duration: 0 });

      // Use the custom clone endpoint: POST /repos/clone
      await client.service('repos/clone').create({
        url: data.url,
        slug: data.slug,
      });

      message.success({ content: 'Repository cloned successfully!', key: 'clone-repo' });
    } catch (error) {
      message.error({
        content: `Failed to clone repository: ${error instanceof Error ? error.message : String(error)}`,
        key: 'clone-repo',
      });
    }
  };

  const handleDeleteRepo = async (repoId: string) => {
    if (!client) return;
    try {
      await client.service('repos').remove(repoId);
      message.success('Repository deleted successfully!');
    } catch (error) {
      message.error(
        `Failed to delete repository: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleDeleteWorktree = async (repoId: string, worktreeName: string) => {
    if (!client) return;
    try {
      // Use custom route: DELETE /repos/:id/worktrees/:name
      await client.service(`repos/${repoId}/worktrees`).remove(worktreeName);
      message.success('Worktree deleted successfully!');
    } catch (error) {
      message.error(
        `Failed to delete worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleCreateWorktree = async (
    repoId: string,
    data: { name: string; ref: string; createBranch: boolean }
  ) => {
    if (!client) return;
    try {
      message.loading({ content: 'Creating worktree...', key: 'create-worktree', duration: 0 });

      await client.service(`repos/${repoId}/worktrees`).create({
        name: data.name,
        ref: data.ref,
        createBranch: data.createBranch,
      });

      message.success({ content: 'Worktree created successfully!', key: 'create-worktree' });
    } catch (error) {
      message.error({
        content: `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
        key: 'create-worktree',
      });
    }
  };

  // Handle MCP server CRUD
  const handleCreateMCPServer = async (data: import('@agor/core/types').CreateMCPServerInput) => {
    if (!client) return;
    try {
      await client.service('mcp-servers').create(data);
      message.success('MCP server added successfully!');
    } catch (error) {
      message.error(
        `Failed to add MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleUpdateMCPServer = async (
    serverId: string,
    updates: import('@agor/core/types').UpdateMCPServerInput
  ) => {
    if (!client) return;
    try {
      await client.service('mcp-servers').patch(serverId, updates);
      message.success('MCP server updated successfully!');
    } catch (error) {
      message.error(
        `Failed to update MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleDeleteMCPServer = async (serverId: string) => {
    if (!client) return;
    try {
      await client.service('mcp-servers').remove(serverId);
      message.success('MCP server deleted successfully!');
    } catch (error) {
      message.error(
        `Failed to delete MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Handle update session-MCP server relationships
  const handleUpdateSessionMcpServers = async (sessionId: string, mcpServerIds: string[]) => {
    if (!client) return;

    try {
      // Get current session-MCP relationships for this session
      const currentIds = sessionMcpServerIds[sessionId] || [];

      // Find servers to add (in new list but not in current)
      const toAdd = mcpServerIds.filter(id => !currentIds.includes(id));

      // Find servers to remove (in current list but not in new)
      const toRemove = currentIds.filter(id => !mcpServerIds.includes(id));

      // Add new relationships
      for (const serverId of toAdd) {
        await client.service(`sessions/${sessionId}/mcp-servers`).create({
          mcpServerId: serverId,
        });
      }

      // Remove old relationships
      for (const serverId of toRemove) {
        await client.service(`sessions/${sessionId}/mcp-servers`).remove(serverId);
      }

      message.success('MCP servers updated successfully!');
    } catch (error) {
      message.error(
        `Failed to update MCP servers: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Generate repo reference options for dropdowns
  const allOptions = getRepoReferenceOptions(repos);
  const worktreeOptions = allOptions.filter(opt => opt.type === 'managed-worktree');
  const repoOptions = allOptions.filter(opt => opt.type === 'managed');

  // Render main app
  return (
    <AgorApp
      client={client}
      user={user}
      sessions={sessions}
      tasks={tasks}
      availableAgents={mockAgents}
      boards={boards}
      repos={repos}
      users={users}
      mcpServers={mcpServers}
      sessionMcpServerIds={sessionMcpServerIds}
      worktreeOptions={worktreeOptions}
      repoOptions={repoOptions}
      initialBoardId={boards[0]?.board_id}
      onCreateSession={handleCreateSession}
      onForkSession={handleForkSession}
      onSpawnSession={handleSpawnSession}
      onSendPrompt={handleSendPrompt}
      onUpdateSession={handleUpdateSession}
      onDeleteSession={handleDeleteSession}
      onCreateBoard={handleCreateBoard}
      onUpdateBoard={handleUpdateBoard}
      onDeleteBoard={handleDeleteBoard}
      onCreateRepo={handleCreateRepo}
      onDeleteRepo={handleDeleteRepo}
      onDeleteWorktree={handleDeleteWorktree}
      onCreateWorktree={handleCreateWorktree}
      onCreateUser={handleCreateUser}
      onUpdateUser={handleUpdateUser}
      onDeleteUser={handleDeleteUser}
      onCreateMCPServer={handleCreateMCPServer}
      onUpdateMCPServer={handleUpdateMCPServer}
      onDeleteMCPServer={handleDeleteMCPServer}
      onUpdateSessionMcpServers={handleUpdateSessionMcpServers}
      onLogout={logout}
    />
  );
}

function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <AntApp>
        <AppContent />
      </AntApp>
    </ConfigProvider>
  );
}

export default App;
