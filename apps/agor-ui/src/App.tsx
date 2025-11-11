import { getRepoReferenceOptions } from '@agor/core/config/browser';
import { Alert, App as AntApp, ConfigProvider, Spin, theme } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AVAILABLE_AGENTS } from './components/AgentSelectionGrid';
import { App as AgorApp } from './components/App';
import { LoginPage } from './components/LoginPage';
import { MobileApp } from './components/mobile/MobileApp';
import { SandboxBanner } from './components/SandboxBanner';
import { WelcomeModal } from './components/WelcomeModal';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { StreamdownDemoPage } from './pages/StreamdownDemoPage';
import {
  useAgorClient,
  useAgorData,
  useAuth,
  useAuthConfig,
  useBoardActions,
  useSessionActions,
} from './hooks';
import { isMobileDevice } from './utils/deviceDetection';

/**
 * DeviceRouter - Redirects users to mobile or desktop site based on device detection
 * Responds to window resize events for responsive switching
 */
function DeviceRouter() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const checkAndRoute = () => {
      const isMobile = isMobileDevice();
      const isOnMobilePath = location.pathname.startsWith('/m');

      // Redirect mobile devices to mobile site
      if (isMobile && !isOnMobilePath) {
        navigate('/m', { replace: true });
      }
      // Redirect desktop devices away from mobile site
      else if (!isMobile && isOnMobilePath) {
        navigate('/', { replace: true });
      }
    };

    // Check on mount and route change
    checkAndRoute();

    // Debounced resize handler to avoid excessive redirects
    let resizeTimeout: NodeJS.Timeout;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(checkAndRoute, 200);
    };

    // Listen for window resize events for responsive switching
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimeout);
    };
  }, [location.pathname, navigate]);

  return null;
}

function AppContent() {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const { getCurrentThemeConfig } = useTheme();

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
    boardObjects,
    comments,
    repos,
    worktrees,
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

  // Welcome modal state (onboarding for new users)
  const [welcomeModalOpen, setWelcomeModalOpen] = useState(false);
  const [settingsTabToOpen, setSettingsTabToOpen] = useState<string | null>(null);
  const [openNewWorktree, setOpenNewWorktree] = useState(false);
  const [inOnboardingFlow, setInOnboardingFlow] = useState(false);

  // Per-session prompt drafts (persists across session switches)
  const [promptDrafts, setPromptDrafts] = useState<Map<string, string>>(new Map());

  // Get current user from users array (real-time updates via WebSocket)
  // This ensures we get the latest onboarding_completed status
  // Fall back to user from auth if users array hasn't loaded yet
  const currentUser = user ? users.find(u => u.user_id === user.user_id) || user : null;

  // Memoize welcome modal stats to prevent unnecessary re-renders
  const welcomeStats = useMemo(
    () => ({
      repoCount: repos.length,
      worktreeCount: worktrees.length,
      sessionCount: sessions.length,
    }),
    [repos.length, worktrees.length, sessions.length]
  );

  // Show welcome modal if user hasn't completed onboarding
  useEffect(() => {
    // Only show modal if onboarding_completed is explicitly false (not undefined)
    if (!loading && currentUser && currentUser.onboarding_completed === false) {
      setWelcomeModalOpen(true);
    }
  }, [loading, currentUser]);

  // NOW handle conditional rendering based on state
  // Show loading while fetching auth config
  if (authConfigLoading) {
    return (
      <ConfigProvider theme={getCurrentThemeConfig()}>
        <div
          style={{
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: token.colorBgLayout,
          }}
        >
          <Spin size="large" />
          <div style={{ marginTop: 16, color: 'rgba(255, 255, 255, 0.65)' }}>Loading...</div>
        </div>
      </ConfigProvider>
    );
  }

  // Show auth config error ONLY if we don't have a config yet (first load)
  // If we already have a config cached, continue with that even if there's an error
  if (authConfigError && !authConfig) {
    return (
      <ConfigProvider theme={getCurrentThemeConfig()}>
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
  // BUT: Show a reconnecting message if we have tokens but aren't connected yet
  const hasTokens =
    typeof window !== 'undefined' &&
    !!(localStorage.getItem('agor-access-token') || localStorage.getItem('agor-refresh-token'));

  if (authConfig?.requireAuth && !authLoading && !authenticated && !hasTokens) {
    return <LoginPage onLogin={login} error={authError} />;
  }

  // Show reconnecting state if we have tokens but lost connection
  if (authConfig?.requireAuth && hasTokens && (!connected || !authenticated)) {
    return (
      <ConfigProvider theme={getCurrentThemeConfig()}>
        <div
          style={{
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: token.colorBgLayout,
          }}
        >
          <Spin size="large" />
          <div style={{ marginTop: 16, color: 'rgba(255, 255, 255, 0.65)' }}>
            Reconnecting to daemon...
          </div>
        </div>
      </ConfigProvider>
    );
  }

  // Show loading while checking authentication (only if auth is required)
  if (authConfig?.requireAuth && authLoading) {
    return (
      <ConfigProvider theme={getCurrentThemeConfig()}>
        <div
          style={{
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: token.colorBgLayout,
          }}
        >
          <Spin size="large" />
          <div style={{ marginTop: 16, color: 'rgba(255, 255, 255, 0.65)' }}>Authenticating...</div>
        </div>
      </ConfigProvider>
    );
  }

  // Show connection error
  // BUT: If auth is required and anonymous auth failed, show login page instead
  if (connectionError) {
    const isAnonymousAuthError = connectionError.includes('Anonymous authentication failed');

    if (authConfig?.requireAuth && isAnonymousAuthError && !authenticated) {
      // Anonymous auth failed but auth is required - show login page
      return <LoginPage onLogin={login} error={authError || connectionError} />;
    }

    return (
      <ConfigProvider theme={getCurrentThemeConfig()}>
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
      <ConfigProvider theme={getCurrentThemeConfig()}>
        <div
          style={{
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: token.colorBgLayout,
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
      <ConfigProvider theme={getCurrentThemeConfig()}>
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
  // biome-ignore lint/suspicious/noExplicitAny: Config type from AgorApp component props
  const handleCreateSession = async (config: any, boardId: string) => {
    try {
      let worktree_id = config.worktree_id;

      // If creating a new worktree, create it first (with URLs included)
      if (config.worktreeMode === 'new' && config.newWorktree) {
        // Create the worktree with all metadata (URLs passed to backend)
        const newWorktree = await handleCreateWorktree(config.newWorktree.repoId, {
          name: config.newWorktree.name,
          ref: config.newWorktree.ref,
          createBranch: config.newWorktree.createBranch,
          sourceBranch: config.newWorktree.sourceBranch,
          pullLatest: config.newWorktree.pullLatest,
          issue_url: config.newWorktree.issue_url,
          pull_request_url: config.newWorktree.pull_request_url,
          boardId: config.newWorktree.boardId, // Pass boardId from session config
        });

        if (!newWorktree) {
          throw new Error('Failed to create worktree');
        }

        // Use the returned worktree ID directly (no race condition!)
        worktree_id = newWorktree.worktree_id;
      }

      if (!worktree_id) {
        throw new Error('Worktree ID is required to create a session');
      }

      // Create the session with the worktree_id
      const session = await createSession({
        ...config,
        worktree_id,
      });

      if (session) {
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

        message.success('Session created!');

        // If there's an initial prompt, send it to the agent
        if (config.initialPrompt?.trim()) {
          await handleSendPrompt(session.session_id, config.initialPrompt, config.permissionMode);
        }

        // Return the session ID so AgorApp can open the drawer
        return session.session_id;
      } else {
        message.error('Failed to create session');
        return null;
      }
    } catch (error) {
      message.error(
        `Failed to create session: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  };

  // Update draft for a specific session
  const handleUpdateDraft = (sessionId: string, draft: string) => {
    setPromptDrafts(prev => {
      const next = new Map(prev);
      if (draft.trim()) {
        next.set(sessionId, draft);
      } else {
        next.delete(sessionId); // Clean up empty drafts
      }
      return next;
    });
  };

  // Clear draft for a specific session
  const handleClearDraft = (sessionId: string) => {
    setPromptDrafts(prev => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  };

  // Handle fork session
  const handleForkSession = async (sessionId: string, prompt: string) => {
    const session = await forkSession(sessionId as import('@agor/core/types').SessionID, prompt);
    if (session) {
      message.success('Session forked successfully!');
      // Clear the draft after forking
      handleClearDraft(sessionId);
    } else {
      message.error('Failed to fork session');
    }
  };

  // Handle spawn session
  const handleSpawnSession = async (sessionId: string, prompt: string) => {
    const session = await spawnSession(sessionId as import('@agor/core/types').SessionID, prompt);
    if (session) {
      message.success('Subsession session spawned successfully!');
      // Clear the draft after spawning subsession
      handleClearDraft(sessionId);
    } else {
      message.error('Failed to spawn session');
    }
  };

  // Handle send prompt - calls Claude/Codex via daemon
  const handleSendPrompt = async (
    sessionId: string,
    prompt: string,
    permissionMode?: import('@agor/core/types').PermissionMode
  ) => {
    if (!client) return;

    try {
      message.loading({ content: 'Sending prompt...', key: 'prompt', duration: 0 });

      await client.service(`sessions/${sessionId}/prompt`).create({
        prompt,
        permissionMode,
      });

      message.success({ content: 'Response received!', key: 'prompt' });

      // Clear the draft after sending
      handleClearDraft(sessionId);
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
      // Cast UpdateUserInput to Partial<User> - backend handles encryption/conversion
      await client
        .service('users')
        .patch(userId, updates as Partial<import('@agor/core/types').User>);
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
  const handleCreateRepo = async (data: { url: string; slug: string; default_branch: string }) => {
    if (!client) return;
    try {
      message.loading({ content: 'Cloning repository...', key: 'clone-repo', duration: 0 });

      // Use the custom clone endpoint: POST /repos/clone
      await client.service('repos/clone').create({
        url: data.url,
        slug: data.slug,
        default_branch: data.default_branch,
      });

      message.success({ content: 'Repository cloned successfully!', key: 'clone-repo' });
    } catch (error) {
      message.error({
        content: `Failed to clone repository: ${error instanceof Error ? error.message : String(error)}`,
        key: 'clone-repo',
      });
    }
  };

  const handleUpdateRepo = async (
    repoId: string,
    updates: Partial<import('@agor/core/types').Repo>
  ) => {
    if (!client) return;
    try {
      await client.service('repos').patch(repoId, updates);
      message.success('Repository updated successfully!');
    } catch (error) {
      message.error(
        `Failed to update repository: ${error instanceof Error ? error.message : String(error)}`
      );
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

  const handleArchiveOrDeleteWorktree = async (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => {
    if (!client) return;
    try {
      const action = options.metadataAction === 'archive' ? 'archived' : 'deleted';
      message.loading({
        content: `${options.metadataAction === 'archive' ? 'Archiving' : 'Deleting'} worktree...`,
        key: 'archive-delete',
        duration: 0,
      });
      await client.service(`worktrees/${worktreeId}/archive-or-delete`).create(options);
      message.success({ content: `Worktree ${action} successfully!`, key: 'archive-delete' });
    } catch (error) {
      message.error({
        content: `Failed to ${options.metadataAction} worktree: ${error instanceof Error ? error.message : String(error)}`,
        key: 'archive-delete',
      });
    }
  };

  const handleUnarchiveWorktree = async (worktreeId: string, options?: { boardId?: string }) => {
    if (!client) return;
    try {
      message.loading({ content: 'Unarchiving worktree...', key: 'unarchive', duration: 0 });
      await client.service(`worktrees/${worktreeId}/unarchive`).create(options || {});
      message.success({ content: 'Worktree unarchived successfully!', key: 'unarchive' });
    } catch (error) {
      message.error({
        content: `Failed to unarchive worktree: ${error instanceof Error ? error.message : String(error)}`,
        key: 'unarchive',
      });
    }
  };

  const handleUpdateWorktree = async (
    worktreeId: string,
    updates: Partial<import('@agor/core/types').Worktree>
  ) => {
    if (!client) return;
    try {
      await client.service('worktrees').patch(worktreeId, updates);
      message.success('Worktree updated successfully!');
    } catch (error) {
      message.error(
        `Failed to update worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleCreateWorktree = async (
    repoId: string,
    data: {
      name: string;
      ref: string;
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      issue_url?: string;
      pull_request_url?: string;
      boardId?: string;
    }
  ): Promise<import('@agor/core/types').Worktree | null> => {
    if (!client) return null;
    try {
      message.loading({ content: 'Creating worktree...', key: 'create-worktree', duration: 0 });

      const worktree = (await client.service(`repos/${repoId}/worktrees`).create({
        name: data.name,
        ref: data.ref,
        createBranch: data.createBranch,
        pullLatest: data.pullLatest, // Fetch latest from remote before creating
        sourceBranch: data.sourceBranch, // Base new branch on specified source branch
        issue_url: data.issue_url,
        pull_request_url: data.pull_request_url,
        boardId: data.boardId, // Optional: add to board
      })) as import('@agor/core/types').Worktree;

      // Dismiss loading message - worktree will appear on board via WebSocket broadcast
      message.destroy('create-worktree');
      return worktree;
    } catch (error) {
      message.error({
        content: `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
        key: 'create-worktree',
      });
      return null;
    }
  };

  // Handle environment control
  const handleStartEnvironment = async (worktreeId: string) => {
    if (!client) return;
    try {
      message.loading({ content: 'Starting environment...', key: 'start-env', duration: 0 });
      await client.service(`worktrees/${worktreeId}/start`).create({});
      message.success({ content: 'Environment started successfully!', key: 'start-env' });
    } catch (error) {
      message.error({
        content: `Failed to start environment: ${error instanceof Error ? error.message : String(error)}`,
        key: 'start-env',
      });
    }
  };

  const handleStopEnvironment = async (worktreeId: string) => {
    if (!client) return;
    try {
      message.loading({ content: 'Stopping environment...', key: 'stop-env', duration: 0 });
      await client.service(`worktrees/${worktreeId}/stop`).create({});
      message.success({ content: 'Environment stopped successfully!', key: 'stop-env' });
    } catch (error) {
      message.error({
        content: `Failed to stop environment: ${error instanceof Error ? error.message : String(error)}`,
        key: 'stop-env',
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

      // Note: Don't show success message here - it's part of the session settings save
      // The main "Session updated" message will appear from handleUpdateSession
    } catch (error) {
      message.error(
        `Failed to update MCP servers: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Handle board comments
  const handleSendComment = async (boardId: string, content: string) => {
    if (!client) return;
    try {
      await client.service('board-comments').create({
        board_id: boardId,
        created_by: user?.user_id || 'anonymous',
        content,
        content_preview: content.slice(0, 200),
      });
    } catch (error) {
      message.error(
        `Failed to send comment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleResolveComment = async (commentId: string) => {
    if (!client) return;
    try {
      const comment = comments.find(c => c.comment_id === commentId);
      await client.service('board-comments').patch(commentId, {
        resolved: !comment?.resolved,
      });
    } catch (error) {
      message.error(
        `Failed to resolve comment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!client) return;
    try {
      await client.service('board-comments').remove(commentId);
      message.success('Comment deleted');
    } catch (error) {
      message.error(
        `Failed to delete comment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleReplyComment = async (parentId: string, content: string) => {
    if (!client) return;
    try {
      // Use the custom route for creating replies
      await client.service(`board-comments/${parentId}/reply`).create({
        content,
        created_by: user?.user_id || 'anonymous',
      });
    } catch (error) {
      message.error(
        `Failed to send reply: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleToggleReaction = async (commentId: string, emoji: string) => {
    if (!client) return;
    try {
      // Use the custom route for toggling reactions
      await client.service(`board-comments/${commentId}/toggle-reaction`).create({
        user_id: user?.user_id || 'anonymous',
        emoji,
      });
    } catch (error) {
      message.error(
        `Failed to toggle reaction: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Generate repo reference options for dropdowns
  const allOptions = getRepoReferenceOptions(repos, worktrees);
  const _worktreeOptions = allOptions.filter(opt => opt.type === 'managed-worktree');
  const _repoOptions = allOptions.filter(opt => opt.type === 'managed');

  // Handle onboarding dismissal
  const handleDismissOnboarding = async () => {
    if (!client || !user) return;
    setInOnboardingFlow(false);
    try {
      await client.service('users').patch(user.user_id, {
        onboarding_completed: true,
      });
    } catch (error) {
      message.error(
        `Failed to update onboarding status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Welcome modal action handlers - open settings to relevant tab
  const handleWelcomeAddRepo = () => {
    setInOnboardingFlow(true);
    setWelcomeModalOpen(false);
    setSettingsTabToOpen('repos');
  };

  const handleWelcomeCreateWorktree = () => {
    setInOnboardingFlow(true);
    setWelcomeModalOpen(false);
    setOpenNewWorktree(true);
  };

  const handleWelcomeNewSession = () => {
    setInOnboardingFlow(true);
    setWelcomeModalOpen(false);
    // TODO: Should this open a new session modal instead? For now just close.
  };

  const handleWelcomeOpenApiKeys = () => {
    setInOnboardingFlow(true);
    setWelcomeModalOpen(false);
    setSettingsTabToOpen('api-keys');
  };

  // Re-open welcome modal after completing sub-actions during onboarding
  const handleSettingsClose = () => {
    setSettingsTabToOpen(null);
    // Re-open welcome modal if still in onboarding flow
    if (inOnboardingFlow && currentUser && !currentUser.onboarding_completed) {
      setWelcomeModalOpen(true);
    }
  };

  const handleNewWorktreeModalClose = () => {
    setOpenNewWorktree(false);
    // Re-open welcome modal if still in onboarding flow
    if (inOnboardingFlow && currentUser && !currentUser.onboarding_completed) {
      setWelcomeModalOpen(true);
    }
  };

  // Render main app
  return (
    <>
      <DeviceRouter />
      <Routes>
        {/* Demo route */}
        <Route path="/demo/streamdown" element={<StreamdownDemoPage />} />

        {/* Mobile routes */}
        <Route
          path="/m/*"
          element={
            <MobileApp
              client={client}
              user={user}
              sessions={sessions}
              tasks={tasks}
              boards={boards}
              comments={comments}
              repos={repos}
              worktrees={worktrees}
              users={users}
              onSendPrompt={handleSendPrompt}
              onSendComment={handleSendComment}
              onReplyComment={handleReplyComment}
              onResolveComment={handleResolveComment}
              onToggleReaction={handleToggleReaction}
              onDeleteComment={handleDeleteComment}
              onLogout={logout}
              promptDrafts={promptDrafts}
              onUpdateDraft={handleUpdateDraft}
            />
          }
        />

        {/* Desktop routes */}
        <Route
          path="/*"
          element={
            <>
              <SandboxBanner />
              {welcomeModalOpen && (
                <WelcomeModal
                  open={welcomeModalOpen}
                  onClose={() => setWelcomeModalOpen(false)}
                  stats={welcomeStats}
                  onAddRepo={handleWelcomeAddRepo}
                  onCreateWorktree={handleWelcomeCreateWorktree}
                  onNewSession={handleWelcomeNewSession}
                  onOpenApiKeys={handleWelcomeOpenApiKeys}
                  onDismiss={handleDismissOnboarding}
                />
              )}
              <AgorApp
                client={client}
                user={currentUser}
                sessions={sessions}
                tasks={tasks}
                availableAgents={AVAILABLE_AGENTS}
                boards={boards}
                boardObjects={boardObjects}
                comments={comments}
                repos={repos}
                worktrees={worktrees}
                users={users}
                mcpServers={mcpServers}
                sessionMcpServerIds={sessionMcpServerIds}
                initialBoardId={boards[0]?.board_id}
                openSettingsTab={settingsTabToOpen}
                onSettingsClose={handleSettingsClose}
                openNewWorktreeModal={openNewWorktree}
                onNewWorktreeModalClose={handleNewWorktreeModalClose}
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
                onUpdateRepo={handleUpdateRepo}
                onDeleteRepo={handleDeleteRepo}
                onArchiveOrDeleteWorktree={handleArchiveOrDeleteWorktree}
                onUnarchiveWorktree={handleUnarchiveWorktree}
                onUpdateWorktree={handleUpdateWorktree}
                onCreateWorktree={handleCreateWorktree}
                onStartEnvironment={handleStartEnvironment}
                onStopEnvironment={handleStopEnvironment}
                onCreateUser={handleCreateUser}
                onUpdateUser={handleUpdateUser}
                onDeleteUser={handleDeleteUser}
                // biome-ignore lint/suspicious/noExplicitAny: CreateMCPServerInput vs Partial<MCPServer> type mismatch
                onCreateMCPServer={handleCreateMCPServer as any}
                onUpdateMCPServer={handleUpdateMCPServer}
                onDeleteMCPServer={handleDeleteMCPServer}
                onUpdateSessionMcpServers={handleUpdateSessionMcpServers}
                onSendComment={handleSendComment}
                onReplyComment={handleReplyComment}
                onResolveComment={handleResolveComment}
                onToggleReaction={handleToggleReaction}
                onDeleteComment={handleDeleteComment}
                onLogout={logout}
              />
            </>
          }
        />
      </Routes>
    </>
  );
}

function AppWrapper() {
  const { getCurrentThemeConfig } = useTheme();

  return (
    <ConfigProvider theme={getCurrentThemeConfig()}>
      <AntApp>
        <AppContent />
      </AntApp>
    </ConfigProvider>
  );
}

function App() {
  // Determine base path: '/ui' in production (served by daemon), '/' in dev mode
  const basename = import.meta.env.BASE_URL === '/ui/' ? '/ui' : '';

  return (
    <BrowserRouter basename={basename}>
      <ThemeProvider>
        <AppWrapper />
      </ThemeProvider>
    </BrowserRouter>
  );
}

export default App;
