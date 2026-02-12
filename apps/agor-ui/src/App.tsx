import { getRepoReferenceOptions } from '@agor/core/config/browser';
import type {
  Board,
  CreateMCPServerInput,
  CreateUserInput,
  GatewayChannel,
  PermissionMode,
  Repo,
  Session,
  SessionID,
  SpawnConfig,
  UpdateMCPServerInput,
  UpdateUserInput,
  User,
  UUID,
  Worktree,
} from '@agor/core/types';
import { Alert, App as AntApp, ConfigProvider, Input, Modal, Spin, theme } from 'antd';
import { useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AVAILABLE_AGENTS } from './components/AgentSelectionGrid';
import { App as AgorApp } from './components/App';
import { ForcePasswordChangeModal } from './components/ForcePasswordChangeModal';
import { LoginPage } from './components/LoginPage';
import { MobileApp } from './components/mobile/MobileApp';
import { SandboxBanner } from './components/SandboxBanner';
import type { WorktreeUpdate } from './components/WorktreeModal/tabs/GeneralTab';
import { ConnectionProvider } from './contexts/ConnectionContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import {
  useAgorClient,
  useAgorData,
  useAuth,
  useAuthConfig,
  useBoardActions,
  useSessionActions,
} from './hooks';
import { StreamdownDemoPage } from './pages/StreamdownDemoPage';
import { isMobileDevice } from './utils/deviceDetection';
import { useThemedMessage } from './utils/message';
import { buildOAuthAutoContinuePrompt, shouldProcessOAuthRequired } from './utils/oauth-helpers';

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
  const { token } = theme.useToken();
  const { getCurrentThemeConfig } = useTheme();
  const { showSuccess, showError, showLoading, destroy } = useThemedMessage();

  // Fetch daemon auth and instance configuration
  const {
    config: authConfig,
    instanceConfig,
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
    reAuthenticate,
  } = useAuth();

  // Call ALL hooks unconditionally BEFORE any conditional returns
  // Connect to daemon with authentication token
  // If auth not required and anonymous allowed, connect without token
  const {
    client,
    connected,
    connecting,
    error: connectionError,
    retryConnection,
  } = useAgorClient({
    accessToken: authenticated ? accessToken : null,
    allowAnonymous: authConfig?.allowAnonymous ?? false,
  });

  // Fetch data (only when connected and authenticated)
  // Skip data fetch if user needs to change password - the ForcePasswordChangeModal will handle that
  const {
    sessionById,
    sessionsByWorktree,
    boardById,
    boardObjectById,
    commentById,
    repoById,
    worktreeById,
    userById,
    mcpServerById,
    gatewayChannelById,
    sessionMcpServerIds,
    loading,
    error: dataError,
  } = useAgorData(connected ? client : null, {
    enabled: !user?.must_change_password,
  });

  // Session actions
  const { createSession, forkSession, spawnSession, updateSession, deleteSession } =
    useSessionActions(client);

  // Board actions
  const { createBoard, updateBoard, deleteBoard } = useBoardActions(client);

  // Onboarding state (for new users)
  const [settingsTabToOpen, setSettingsTabToOpen] = useState<string | null>(null);
  const [openUserSettings, setOpenUserSettings] = useState(false);
  const [openNewWorktree, setOpenNewWorktree] = useState(false);

  // Per-session prompt drafts (persists across session switches)
  const [promptDrafts, setPromptDrafts] = useState<Map<string, string>>(new Map());

  // Track if we've successfully loaded data at least once
  // This prevents UI from unmounting during reconnections
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  // Mark as loaded once we have data
  useEffect(() => {
    if (!loading && (sessionById.size > 0 || boardById.size > 0 || repoById.size > 0)) {
      setHasLoadedOnce(true);
    }
  }, [loading, sessionById.size, boardById.size, repoById.size]);

  // State for OAuth flow triggered by MCP tools
  const [pendingOAuthServer, setPendingOAuthServer] = useState<{
    serverId: string;
    name: string;
    url: string;
    sessionId?: string;
  } | null>(null);
  const [oauthCallbackUrl, setOauthCallbackUrl] = useState('');
  const [oauthFlowStarted, setOauthFlowStarted] = useState(false);
  const [oauthCooldownUntil, setOauthCooldownUntil] = useState<number>(0);

  // Listen for OAuth authentication required events from MCP tools
  useEffect(() => {
    if (!client?.io) return;

    const handleOAuthRequired = (data: {
      session_id: string;
      servers: Array<{ name: string; serverId: string; url: string }>;
    }) => {
      console.log('[OAuth] Received oauth:auth_required event:', data);

      const { shouldProcess, reason } = shouldProcessOAuthRequired(
        pendingOAuthServer,
        oauthCooldownUntil
      );
      if (!shouldProcess) {
        console.log(`[OAuth] Ignoring - ${reason}`);
        return;
      }

      // Start OAuth flow for the first server that needs it
      if (data.servers.length > 0) {
        const server = data.servers[0];
        setPendingOAuthServer({ ...server, sessionId: data.session_id });
        setOauthCallbackUrl('');
        setOauthFlowStarted(false);
      }
    };

    client.io.on('oauth:auth_required', handleOAuthRequired);

    return () => {
      client.io.off('oauth:auth_required', handleOAuthRequired);
    };
  }, [client, pendingOAuthServer, oauthCooldownUntil]);

  // Auto-start OAuth flow when pendingOAuthServer is set
  useEffect(() => {
    if (!client || !pendingOAuthServer || oauthFlowStarted) return;

    const startOAuthFlow = async () => {
      setOauthFlowStarted(true);

      // Set up listener for oauth:open_browser event
      const handleOpenBrowser = ({ authUrl }: { authUrl: string }) => {
        console.log('[OAuth] Opening browser for auth:', authUrl);
        window.open(authUrl, '_blank', 'noopener,noreferrer');
      };
      client.io.on('oauth:open_browser', handleOpenBrowser);

      try {
        const mcpServer = mcpServerById.get(pendingOAuthServer.serverId);
        const data = (await client.service('mcp-servers/oauth-start').create({
          mcp_url: mcpServer?.url || pendingOAuthServer.url,
          mcp_server_id: pendingOAuthServer.serverId,
          client_id: mcpServer?.auth?.oauth_client_id,
        })) as {
          success: boolean;
          error?: string;
          authorizationUrl?: string;
          state?: string;
        };

        if (!data.success) {
          showError(data.error || 'Failed to start OAuth flow');
          setPendingOAuthServer(null);
        }
        // If success, the modal will show for callback URL input
      } catch (error) {
        showError(`OAuth error: ${error instanceof Error ? error.message : String(error)}`);
        setPendingOAuthServer(null);
      } finally {
        client.io.off('oauth:open_browser', handleOpenBrowser);
      }
    };

    startOAuthFlow();
  }, [client, pendingOAuthServer, oauthFlowStarted, mcpServerById, showError]);

  // Handle OAuth callback URL submission
  const handleOAuthCallbackSubmit = async () => {
    if (!client || !oauthCallbackUrl.trim()) {
      showError('Please paste the callback URL');
      return;
    }

    try {
      const data = (await client.service('mcp-servers/oauth-complete').create({
        callback_url: oauthCallbackUrl.trim(),
      })) as {
        success: boolean;
        error?: string;
        message?: string;
      };

      if (data.success) {
        showSuccess(
          data.message || 'OAuth authentication successful! MCP tools are now available.'
        );

        // Auto-continue the session that was waiting for OAuth
        const autoContinue = buildOAuthAutoContinuePrompt(pendingOAuthServer);
        if (autoContinue) {
          try {
            await client.service(`sessions/${autoContinue.sessionId}/prompt`).create({
              prompt: autoContinue.prompt,
              messageSource: autoContinue.messageSource,
            });
          } catch (err) {
            console.warn('[OAuth] Failed to auto-continue session:', err);
          }
        }

        setPendingOAuthServer(null);
        setOauthCallbackUrl('');
        // Set 10 second cooldown to prevent immediate re-triggers
        setOauthCooldownUntil(Date.now() + 10000);
      } else {
        showError(data.error || 'Failed to complete OAuth flow');
      }
    } catch (error) {
      showError(`OAuth error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Get current user from users Map (real-time updates via WebSocket)
  // This ensures we get the latest onboarding_completed status
  // Fall back to user from auth if users Map hasn't loaded yet
  const currentUser = user ? userById.get(user.user_id) || user : null;

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
    return (
      <ConfigProvider theme={getCurrentThemeConfig()}>
        <LoginPage onLogin={login} error={authError} />
      </ConfigProvider>
    );
  }

  // Show reconnecting state if we have tokens but lost connection
  // ONLY show fullscreen on initial connection, not during reconnections
  if (authConfig?.requireAuth && hasTokens && (!connected || !authenticated) && !hasLoadedOnce) {
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
      return (
        <ConfigProvider theme={getCurrentThemeConfig()}>
          <LoginPage onLogin={login} error={authError || connectionError} />
        </ConfigProvider>
      );
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

  // Show loading state ONLY on initial load, not during reconnections
  // Once data is loaded, keep UI mounted and show connection status in header instead
  if ((connecting || loading) && !hasLoadedOnce) {
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

  // Show data error (but not if user needs to change password - let the modal render)
  if (dataError && !user?.must_change_password) {
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
      const worktree_id = config.worktree_id;

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

        showSuccess('Session created!');

        // If there's an initial prompt, send it to the agent
        if (config.initialPrompt?.trim()) {
          await handleSendPrompt(session.session_id, config.initialPrompt, config.permissionMode);
        }

        // Return the session ID so AgorApp can open the drawer
        return session.session_id;
      } else {
        showError('Failed to create session');
        return null;
      }
    } catch (error) {
      showError(
        `Failed to create session: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  };

  // Update draft for a specific session
  const handleUpdateDraft = (sessionId: string, draft: string) => {
    setPromptDrafts((prev) => {
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
    setPromptDrafts((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  };

  // Handle fork session
  const handleForkSession = async (sessionId: string, prompt: string) => {
    const session = await forkSession(sessionId as SessionID, prompt);
    if (session) {
      showSuccess('Session forked successfully!');
      // Clear the draft after forking
      handleClearDraft(sessionId);
    } else {
      showError('Failed to fork session');
    }
  };

  // Handle spawn session
  const handleSpawnSession = async (sessionId: string, config: string | Partial<SpawnConfig>) => {
    // Handle both string prompt and full SpawnConfig
    const spawnConfig = typeof config === 'string' ? { prompt: config } : config;
    const session = await spawnSession(sessionId as SessionID, spawnConfig);
    if (session) {
      showSuccess('Subsession session spawned successfully!');
      // Clear the draft after spawning subsession
      handleClearDraft(sessionId);
    } else {
      showError('Failed to spawn session');
    }
  };

  // Handle send prompt - calls Claude/Codex via daemon
  const handleSendPrompt = async (
    sessionId: string,
    prompt: string,
    permissionMode?: PermissionMode
  ) => {
    if (!client) return;

    try {
      await client.service(`sessions/${sessionId}/prompt`).create({
        prompt,
        permissionMode,
        messageSource: 'agor',
      });

      // Clear the draft after sending
      handleClearDraft(sessionId);
    } catch (error) {
      showError(`Failed to send prompt: ${error instanceof Error ? error.message : String(error)}`);
      console.error('Prompt error:', error);
    }
  };

  // Handle update session
  const handleUpdateSession = async (sessionId: string, updates: Partial<Session>) => {
    const session = await updateSession(sessionId as SessionID, updates);
    if (session) {
      showSuccess('Session updated successfully!');
    } else {
      showError('Failed to update session');
    }
  };

  // Handle delete session
  const handleDeleteSession = async (sessionId: string) => {
    const success = await deleteSession(sessionId as SessionID);
    if (success) {
      showSuccess('Session deleted successfully!');
    } else {
      showError('Failed to delete session');
    }
  };

  // Handle create user
  const handleCreateUser = async (data: CreateUserInput) => {
    if (!client) return;
    try {
      await client.service('users').create(data);
      showSuccess('User created successfully!');
    } catch (error) {
      showError(`Failed to create user: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Handle update user
  const handleUpdateUser = async (userId: string, updates: UpdateUserInput) => {
    if (!client) return;
    try {
      // Cast UpdateUserInput to Partial<User> - backend handles encryption/conversion
      await client.service('users').patch(userId, updates as Partial<User>);
      showSuccess('User updated successfully!');
    } catch (error) {
      showError(`Failed to update user: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Handle delete user
  const handleDeleteUser = async (userId: string) => {
    if (!client) return;
    try {
      await client.service('users').remove(userId);
      showSuccess('User deleted successfully!');
    } catch (error) {
      showError(`Failed to delete user: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Handle forced password change (from ForcePasswordChangeModal)
  const handleForcePasswordChange = async (userId: string, newPassword: string) => {
    if (!client) throw new Error('Not connected');
    // This will auto-clear must_change_password flag on the backend
    await client.service('users').patch(userId, { password: newPassword } as Partial<User>);
    showSuccess('Password changed successfully!');
    // Re-authenticate to refresh user state with must_change_password: false
    // This will dismiss the modal and allow the user to continue
    await reAuthenticate();
  };

  // Handle board CRUD
  const handleCreateBoard = async (board: Partial<Board>) => {
    if (board.board_id) {
      // Board already exists (clone/import already persisted it)
      return;
    }

    const created = await createBoard(board);
    if (created) {
      showSuccess('Board created successfully!');
    }
  };

  const handleUpdateBoard = async (boardId: string, updates: Partial<Board>) => {
    const updated = await updateBoard(boardId as UUID, updates);
    if (updated) {
      showSuccess('Board updated successfully!');
    }
  };

  const handleDeleteBoard = async (boardId: string) => {
    const success = await deleteBoard(boardId as UUID);
    if (success) {
      showSuccess('Board deleted successfully!');
    }
  };

  // Handle repo CRUD
  const handleCreateRepo = async (data: { url: string; slug: string; default_branch: string }) => {
    if (!client) return;
    try {
      showLoading('Cloning repository...', { key: 'clone-repo' });

      // Use the custom clone endpoint: POST /repos/clone
      await client.service('repos/clone').create({
        url: data.url,
        slug: data.slug,
        default_branch: data.default_branch,
      });

      showSuccess('Repository cloned successfully!', { key: 'clone-repo' });
    } catch (error) {
      showError(
        `Failed to clone repository: ${error instanceof Error ? error.message : String(error)}`,
        { key: 'clone-repo' }
      );
    }
  };

  const handleCreateLocalRepo = async (data: { path: string; slug?: string }) => {
    if (!client) return;
    try {
      showLoading('Adding local repository...', { key: 'add-local-repo' });

      await client.service('repos/local').create({
        path: data.path,
        slug: data.slug,
      });

      showSuccess('Local repository added successfully!', { key: 'add-local-repo' });
    } catch (error) {
      showError(
        `Failed to add local repository: ${error instanceof Error ? error.message : String(error)}`,
        { key: 'add-local-repo' }
      );
    }
  };

  const handleUpdateRepo = async (repoId: string, updates: Partial<Repo>) => {
    if (!client) return;
    try {
      await client.service('repos').patch(repoId, updates);
      showSuccess('Repository updated successfully!');
    } catch (error) {
      showError(
        `Failed to update repository: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleDeleteRepo = async (repoId: string, cleanup: boolean) => {
    if (!client) return;
    try {
      await client.service('repos').remove(repoId, {
        query: { cleanup },
      });
      if (cleanup) {
        showSuccess('Repository and files deleted successfully!');
      } else {
        showSuccess('Repository removed from Agor (files preserved)');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check for partial deletion (some files deleted, some failed)
      if (errorMessage.includes('Partial deletion occurred:')) {
        showError(`⚠️ PARTIAL DELETION: Some files were permanently deleted. ${errorMessage}`);
      }
      // Check for complete failure (no files deleted)
      else if (errorMessage.includes('No files were deleted')) {
        showError(`Deletion failed, but no files were removed. ${errorMessage}`);
      }
      // Generic failure
      else {
        showError(`Failed to delete repository: ${errorMessage}`);
      }
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
      showLoading(
        `${options.metadataAction === 'archive' ? 'Archiving' : 'Deleting'} worktree...`,
        { key: 'archive-delete' }
      );
      await client.service(`worktrees/${worktreeId}/archive-or-delete`).create(options);
      showSuccess(`Worktree ${action} successfully!`, { key: 'archive-delete' });
    } catch (error) {
      showError(
        `Failed to ${options.metadataAction} worktree: ${error instanceof Error ? error.message : String(error)}`,
        { key: 'archive-delete' }
      );
    }
  };

  const handleUnarchiveWorktree = async (worktreeId: string, options?: { boardId?: string }) => {
    if (!client) return;
    try {
      showLoading('Unarchiving worktree...', { key: 'unarchive' });
      await client.service(`worktrees/${worktreeId}/unarchive`).create(options || {});
      showSuccess('Worktree unarchived successfully!', { key: 'unarchive' });
    } catch (error) {
      showError(
        `Failed to unarchive worktree: ${error instanceof Error ? error.message : String(error)}`,
        { key: 'unarchive' }
      );
    }
  };

  const handleUpdateWorktree = async (worktreeId: string, updates: WorktreeUpdate) => {
    if (!client) return;
    try {
      // Cast to Partial<Worktree> to satisfy Feathers type checking
      // The backend MCP handler properly handles null values for clearing fields
      await client.service('worktrees').patch(worktreeId, updates as Partial<Worktree>);
      showSuccess('Worktree updated successfully!');
    } catch (error) {
      showError(
        `Failed to update worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleCreateWorktree = async (
    repoId: string,
    data: {
      name: string;
      ref: string;
      refType?: 'branch' | 'tag';
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      issue_url?: string;
      pull_request_url?: string;
      boardId?: string;
      position?: { x: number; y: number };
    }
  ): Promise<Worktree | null> => {
    if (!client) return null;
    try {
      showLoading('Creating worktree...', { key: 'create-worktree' });

      const worktree = (await client.service(`repos/${repoId}/worktrees`).create({
        name: data.name,
        ref: data.ref,
        refType: data.refType,
        createBranch: data.createBranch,
        pullLatest: data.pullLatest, // Fetch latest from remote before creating
        sourceBranch: data.sourceBranch, // Base new branch on specified source branch
        issue_url: data.issue_url,
        pull_request_url: data.pull_request_url,
        boardId: data.boardId, // Optional: add to board
        position: data.position, // Optional: position on board (defaults to center of viewport)
      })) as Worktree;

      // Dismiss loading message - worktree will appear on board via WebSocket broadcast
      destroy('create-worktree');
      return worktree;
    } catch (error) {
      showError(
        `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
        { key: 'create-worktree' }
      );
      return null;
    }
  };

  // Handle environment control
  const handleStartEnvironment = async (worktreeId: string) => {
    if (!client) return;
    try {
      showLoading('Starting environment...', { key: 'start-env' });
      await client.service(`worktrees/${worktreeId}/start`).create({});
      showSuccess('Environment started successfully!', { key: 'start-env' });
    } catch (error) {
      showError(
        `Failed to start environment: ${error instanceof Error ? error.message : String(error)}`,
        { key: 'start-env' }
      );
    }
  };

  const handleStopEnvironment = async (worktreeId: string) => {
    if (!client) return;
    try {
      showLoading('Stopping environment...', { key: 'stop-env' });
      await client.service(`worktrees/${worktreeId}/stop`).create({});
      showSuccess('Environment stopped successfully!', { key: 'stop-env' });
    } catch (error) {
      showError(
        `Failed to stop environment: ${error instanceof Error ? error.message : String(error)}`,
        { key: 'stop-env' }
      );
    }
  };

  const handleNukeEnvironment = async (worktreeId: string) => {
    if (!client) return;
    try {
      showLoading('Nuking environment...', { key: 'nuke-env' });
      await client.service(`worktrees/${worktreeId}/nuke`).create({});
      showSuccess('Environment nuked successfully!', { key: 'nuke-env' });
    } catch (error) {
      showError(
        `Failed to nuke environment: ${error instanceof Error ? error.message : String(error)}`,
        { key: 'nuke-env' }
      );
    }
  };

  // Handle MCP server CRUD
  const handleCreateMCPServer = async (data: CreateMCPServerInput) => {
    if (!client) return;
    try {
      await client.service('mcp-servers').create(data);
      showSuccess('MCP server added successfully!');
    } catch (error) {
      showError(
        `Failed to add MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleUpdateMCPServer = async (serverId: string, updates: UpdateMCPServerInput) => {
    if (!client) return;
    try {
      await client.service('mcp-servers').patch(serverId, updates);
      showSuccess('MCP server updated successfully!');
    } catch (error) {
      showError(
        `Failed to update MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleDeleteMCPServer = async (serverId: string) => {
    if (!client) return;
    try {
      await client.service('mcp-servers').remove(serverId);
      showSuccess('MCP server deleted successfully!');
    } catch (error) {
      showError(
        `Failed to delete MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Handle gateway channel CRUD
  const handleCreateGatewayChannel = async (data: Partial<GatewayChannel>) => {
    if (!client) return;
    try {
      await client.service('gateway-channels').create(data);
      showSuccess('Gateway channel created!');
    } catch (error) {
      showError(
        `Failed to create gateway channel: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleUpdateGatewayChannel = async (
    channelId: string,
    updates: Partial<GatewayChannel>
  ) => {
    if (!client) return;
    try {
      await client.service('gateway-channels').patch(channelId, updates);
      showSuccess('Gateway channel updated!');
    } catch (error) {
      showError(
        `Failed to update gateway channel: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleDeleteGatewayChannel = async (channelId: string) => {
    if (!client) return;
    try {
      await client.service('gateway-channels').remove(channelId);
      showSuccess('Gateway channel deleted!');
    } catch (error) {
      showError(
        `Failed to delete gateway channel: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Handle update session-MCP server relationships
  const handleUpdateSessionMcpServers = async (sessionId: string, mcpServerIds: string[]) => {
    if (!client) return;

    try {
      // Get current session-MCP relationships for this session
      const currentIds = sessionMcpServerIds.get(sessionId) || [];

      // Find servers to add (in new list but not in current)
      const toAdd = mcpServerIds.filter((id) => !currentIds.includes(id));

      // Find servers to remove (in current list but not in new)
      const toRemove = currentIds.filter((id) => !mcpServerIds.includes(id));

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
      showError(
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
      showError(
        `Failed to send comment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleResolveComment = async (commentId: string) => {
    if (!client) return;
    try {
      const comment = commentById.get(commentId);
      await client.service('board-comments').patch(commentId, {
        resolved: !comment?.resolved,
      });
    } catch (error) {
      showError(
        `Failed to resolve comment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!client) return;
    try {
      await client.service('board-comments').remove(commentId);
      showSuccess('Comment deleted');
    } catch (error) {
      showError(
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
      showError(`Failed to send reply: ${error instanceof Error ? error.message : String(error)}`);
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
      showError(
        `Failed to toggle reaction: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Generate repo reference options for dropdowns
  const allOptions = getRepoReferenceOptions(
    Array.from(repoById.values()),
    Array.from(worktreeById.values())
  );
  const _worktreeOptions = allOptions.filter((opt) => opt.type === 'managed-worktree');
  const _repoOptions = allOptions.filter((opt) => opt.type === 'managed');

  // Modal close handlers
  const handleSettingsClose = () => {
    setSettingsTabToOpen(null);
  };

  const handleUserSettingsClose = () => {
    setOpenUserSettings(false);
  };

  const handleNewWorktreeModalClose = () => {
    setOpenNewWorktree(false);
  };

  // Render main app
  return (
    <ConnectionProvider value={{ connected, connecting }}>
      {/* Force Password Change Modal - shown when user.must_change_password is true */}
      <ForcePasswordChangeModal
        open={!!currentUser?.must_change_password}
        user={currentUser}
        onChangePassword={handleForcePasswordChange}
        onLogout={logout}
      />

      {/* OAuth Callback Modal - shown when MCP server needs OAuth authentication */}
      <Modal
        title={`OAuth Authentication - ${pendingOAuthServer?.name || 'MCP Server'}`}
        open={!!pendingOAuthServer && oauthFlowStarted}
        onOk={handleOAuthCallbackSubmit}
        onCancel={() => {
          setPendingOAuthServer(null);
          setOauthCallbackUrl('');
        }}
        okText="Complete Authentication"
        cancelText="Cancel"
      >
        <p>
          A browser window has been opened for OAuth authentication. After you complete the login,
          you will be redirected to a callback URL.
        </p>
        <p>
          <strong>Please copy and paste the entire callback URL here:</strong>
        </p>
        <Input.TextArea
          value={oauthCallbackUrl}
          onChange={(e) => setOauthCallbackUrl(e.target.value)}
          placeholder="Paste the callback URL here (e.g., http://localhost:3030/oauth/callback?code=...)"
          rows={3}
          style={{ marginTop: 8 }}
        />
      </Modal>

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
              sessionById={sessionById}
              sessionsByWorktree={sessionsByWorktree}
              boardById={boardById}
              commentById={commentById}
              repoById={repoById}
              worktreeById={worktreeById}
              userById={userById}
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

        {/* Desktop routes - board with session (Django-style trailing slash) */}
        <Route
          path="/b/:boardParam/:sessionParam/"
          element={
            <>
              <SandboxBanner />
              <AgorApp
                client={client}
                user={currentUser}
                connected={connected}
                connecting={connecting}
                sessionById={sessionById}
                sessionsByWorktree={sessionsByWorktree}
                availableAgents={AVAILABLE_AGENTS}
                boardById={boardById}
                boardObjectById={boardObjectById}
                commentById={commentById}
                repoById={repoById}
                worktreeById={worktreeById}
                userById={userById}
                mcpServerById={mcpServerById}
                sessionMcpServerIds={sessionMcpServerIds}
                initialBoardId={Array.from(boardById.values())[0]?.board_id}
                openSettingsTab={settingsTabToOpen}
                onSettingsClose={handleSettingsClose}
                openUserSettings={openUserSettings}
                onUserSettingsClose={handleUserSettingsClose}
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
                onCreateLocalRepo={handleCreateLocalRepo}
                onUpdateRepo={handleUpdateRepo}
                onDeleteRepo={handleDeleteRepo}
                onArchiveOrDeleteWorktree={handleArchiveOrDeleteWorktree}
                onUnarchiveWorktree={handleUnarchiveWorktree}
                onUpdateWorktree={handleUpdateWorktree}
                onCreateWorktree={handleCreateWorktree}
                onStartEnvironment={handleStartEnvironment}
                onStopEnvironment={handleStopEnvironment}
                onNukeEnvironment={handleNukeEnvironment}
                onCreateUser={handleCreateUser}
                onUpdateUser={handleUpdateUser}
                onDeleteUser={handleDeleteUser}
                // biome-ignore lint/suspicious/noExplicitAny: CreateMCPServerInput vs Partial<MCPServer> type mismatch
                onCreateMCPServer={handleCreateMCPServer as any}
                onUpdateMCPServer={handleUpdateMCPServer}
                onDeleteMCPServer={handleDeleteMCPServer}
                gatewayChannelById={gatewayChannelById}
                onCreateGatewayChannel={handleCreateGatewayChannel}
                onUpdateGatewayChannel={handleUpdateGatewayChannel}
                onDeleteGatewayChannel={handleDeleteGatewayChannel}
                onUpdateSessionMcpServers={handleUpdateSessionMcpServers}
                onSendComment={handleSendComment}
                onReplyComment={handleReplyComment}
                onResolveComment={handleResolveComment}
                onToggleReaction={handleToggleReaction}
                onDeleteComment={handleDeleteComment}
                onLogout={logout}
                onRetryConnection={retryConnection}
                instanceLabel={instanceConfig?.label}
                instanceDescription={instanceConfig?.description}
              />
            </>
          }
        />

        {/* Desktop routes - board only (Django-style trailing slash) */}
        <Route
          path="/b/:boardParam/"
          element={
            <>
              <SandboxBanner />
              <AgorApp
                client={client}
                user={currentUser}
                connected={connected}
                connecting={connecting}
                sessionById={sessionById}
                sessionsByWorktree={sessionsByWorktree}
                availableAgents={AVAILABLE_AGENTS}
                boardById={boardById}
                boardObjectById={boardObjectById}
                commentById={commentById}
                repoById={repoById}
                worktreeById={worktreeById}
                userById={userById}
                mcpServerById={mcpServerById}
                sessionMcpServerIds={sessionMcpServerIds}
                initialBoardId={Array.from(boardById.values())[0]?.board_id}
                openSettingsTab={settingsTabToOpen}
                onSettingsClose={handleSettingsClose}
                openUserSettings={openUserSettings}
                onUserSettingsClose={handleUserSettingsClose}
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
                onCreateLocalRepo={handleCreateLocalRepo}
                onUpdateRepo={handleUpdateRepo}
                onDeleteRepo={handleDeleteRepo}
                onArchiveOrDeleteWorktree={handleArchiveOrDeleteWorktree}
                onUnarchiveWorktree={handleUnarchiveWorktree}
                onUpdateWorktree={handleUpdateWorktree}
                onCreateWorktree={handleCreateWorktree}
                onStartEnvironment={handleStartEnvironment}
                onStopEnvironment={handleStopEnvironment}
                onNukeEnvironment={handleNukeEnvironment}
                onCreateUser={handleCreateUser}
                onUpdateUser={handleUpdateUser}
                onDeleteUser={handleDeleteUser}
                // biome-ignore lint/suspicious/noExplicitAny: CreateMCPServerInput vs Partial<MCPServer> type mismatch
                onCreateMCPServer={handleCreateMCPServer as any}
                onUpdateMCPServer={handleUpdateMCPServer}
                onDeleteMCPServer={handleDeleteMCPServer}
                gatewayChannelById={gatewayChannelById}
                onCreateGatewayChannel={handleCreateGatewayChannel}
                onUpdateGatewayChannel={handleUpdateGatewayChannel}
                onDeleteGatewayChannel={handleDeleteGatewayChannel}
                onUpdateSessionMcpServers={handleUpdateSessionMcpServers}
                onSendComment={handleSendComment}
                onReplyComment={handleReplyComment}
                onResolveComment={handleResolveComment}
                onToggleReaction={handleToggleReaction}
                onDeleteComment={handleDeleteComment}
                onLogout={logout}
                onRetryConnection={retryConnection}
                instanceLabel={instanceConfig?.label}
                instanceDescription={instanceConfig?.description}
              />
            </>
          }
        />

        {/* Desktop routes - fallback for root path */}
        <Route
          path="/*"
          element={
            <>
              <SandboxBanner />
              <AgorApp
                client={client}
                user={currentUser}
                connected={connected}
                connecting={connecting}
                sessionById={sessionById}
                sessionsByWorktree={sessionsByWorktree}
                availableAgents={AVAILABLE_AGENTS}
                boardById={boardById}
                boardObjectById={boardObjectById}
                commentById={commentById}
                repoById={repoById}
                worktreeById={worktreeById}
                userById={userById}
                mcpServerById={mcpServerById}
                sessionMcpServerIds={sessionMcpServerIds}
                initialBoardId={Array.from(boardById.values())[0]?.board_id}
                openSettingsTab={settingsTabToOpen}
                onSettingsClose={handleSettingsClose}
                openUserSettings={openUserSettings}
                onUserSettingsClose={handleUserSettingsClose}
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
                onCreateLocalRepo={handleCreateLocalRepo}
                onUpdateRepo={handleUpdateRepo}
                onDeleteRepo={handleDeleteRepo}
                onArchiveOrDeleteWorktree={handleArchiveOrDeleteWorktree}
                onUnarchiveWorktree={handleUnarchiveWorktree}
                onUpdateWorktree={handleUpdateWorktree}
                onCreateWorktree={handleCreateWorktree}
                onStartEnvironment={handleStartEnvironment}
                onStopEnvironment={handleStopEnvironment}
                onNukeEnvironment={handleNukeEnvironment}
                onCreateUser={handleCreateUser}
                onUpdateUser={handleUpdateUser}
                onDeleteUser={handleDeleteUser}
                // biome-ignore lint/suspicious/noExplicitAny: CreateMCPServerInput vs Partial<MCPServer> type mismatch
                onCreateMCPServer={handleCreateMCPServer as any}
                onUpdateMCPServer={handleUpdateMCPServer}
                onDeleteMCPServer={handleDeleteMCPServer}
                gatewayChannelById={gatewayChannelById}
                onCreateGatewayChannel={handleCreateGatewayChannel}
                onUpdateGatewayChannel={handleUpdateGatewayChannel}
                onDeleteGatewayChannel={handleDeleteGatewayChannel}
                onUpdateSessionMcpServers={handleUpdateSessionMcpServers}
                onSendComment={handleSendComment}
                onReplyComment={handleReplyComment}
                onResolveComment={handleResolveComment}
                onToggleReaction={handleToggleReaction}
                onDeleteComment={handleDeleteComment}
                onLogout={logout}
                onRetryConnection={retryConnection}
                instanceLabel={instanceConfig?.label}
                instanceDescription={instanceConfig?.description}
              />
            </>
          }
        />
      </Routes>
    </ConnectionProvider>
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
