import type {
  Artifact,
  Board,
  CreateLocalRepoRequest,
  CreateMCPServerInput,
  CreateRepoRequest,
  CreateUserInput,
  GatewayChannel,
  PermissionMode,
  Repo,
  Session,
  SessionID,
  SpawnConfig,
  UpdateUserInput,
  User,
  UUID,
  Worktree,
} from '@agor-live/client';
import { getRepoReferenceOptions } from '@agor-live/client';
import { Alert, App as AntApp, ConfigProvider, Spin, theme } from 'antd';
import { useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AVAILABLE_AGENTS } from './components/AgentSelectionGrid';
import { App as AgorApp } from './components/App';
import { ForcePasswordChangeModal } from './components/ForcePasswordChangeModal';
import { LoginPage } from './components/LoginPage';
import { MobileApp } from './components/mobile/MobileApp';
import { OnboardingWizard } from './components/OnboardingWizard';
import type { WorktreeUpdate } from './components/WorktreeModal/tabs/GeneralTab';
import { ConnectionProvider } from './contexts/ConnectionContext';
import { ServicesConfigContext } from './contexts/ServicesConfigContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import {
  useAgorClient,
  useAgorData,
  useAuth,
  useAuthConfig,
  useBoardActions,
  useServerVersion,
  useSessionActions,
} from './hooks';
import { StreamdownDemoPage } from './pages/StreamdownDemoPage';
import { isMobileDevice } from './utils/deviceDetection';
import { useThemedMessage } from './utils/message';

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
  const { showSuccess, showError, showWarning, showLoading, destroy } = useThemedMessage();
  const navigate = useNavigate();

  // Fetch daemon auth and instance configuration
  const {
    config: authConfig,
    instanceConfig,
    onboardingConfig,
    servicesConfig,
    featuresConfig,
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

  // Track FE/BE drift: capture the daemon's build SHA on first load (via
  // /health) and flip outOfSync when the daemon later reports a different
  // SHA on socket reconnect. Surfaced through ConnectionContext →
  // ConnectionStatus (amber tag with a refresh tooltip) and AboutTab (debug
  // rows). Mounted exactly once so all consumers share the same baseline.
  const { capturedSha, currentSha, outOfSync } = useServerVersion(client);

  // Fetch data (only when connected and authenticated)
  // Skip data fetch if user needs to change password - the ForcePasswordChangeModal will handle that
  const {
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
    error: dataError,
  } = useAgorData(connected ? client : null, {
    enabled: !user?.must_change_password,
  });

  // Session actions
  const { createSession, forkSession, btwForkSession, spawnSession, updateSession, deleteSession } =
    useSessionActions(client);

  // Board actions
  const { createBoard, updateBoard, deleteBoard, archiveBoard, unarchiveBoard } =
    useBoardActions(client);

  // Onboarding state (for new users)
  const [settingsTabToOpen, setSettingsTabToOpen] = useState<string | null>(null);
  const [openUserSettings, setOpenUserSettings] = useState(false);
  const [openNewWorktree, setOpenNewWorktree] = useState(false);

  // Detect GitHub App setup callback URL and auto-open gateway settings
  const location = useLocation();
  useEffect(() => {
    if (
      location.pathname === '/gateway/github/setup' &&
      location.search.includes('installation_id')
    ) {
      setSettingsTabToOpen('gateway');
    }
  }, [location.pathname, location.search]);

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

  // Get current user from users Map (real-time updates via WebSocket)
  // This ensures we get the latest onboarding_completed status
  // Fall back to user from auth if users Map hasn't loaded yet
  const currentUser = user ? userById.get(user.user_id) || user : null;

  // Onboarding wizard state
  const [onboardingWizardOpen, setOnboardingWizardOpen] = useState(false);

  // Trigger wizard when user is loaded and hasn't completed onboarding
  useEffect(() => {
    if (
      currentUser &&
      currentUser.onboarding_completed === false &&
      !currentUser.must_change_password &&
      connected &&
      !loading
    ) {
      setOnboardingWizardOpen(true);
    }
  }, [currentUser, connected, loading]);

  // Handle wizard completion
  const handleOnboardingComplete = async (result: {
    worktreeId: string;
    sessionId: string;
    boardId: string;
    path: 'assistant' | 'own-repo';
  }) => {
    setOnboardingWizardOpen(false);

    if (!currentUser) return;

    // Mark onboarding complete and store result in preferences
    handleUpdateUser(currentUser.user_id, {
      onboarding_completed: true,
      preferences: {
        ...currentUser.preferences,
        mainBoardId: result.boardId || currentUser.preferences?.mainBoardId,
        onboarding: {
          path: result.path,
          worktreeId: result.worktreeId,
          boardId: result.boardId,
        },
      },
    });

    // Clear the assistant pending flag if applicable
    if (result.path === 'assistant' && client) {
      try {
        await client.service('config').patch(null, { onboarding: { assistantPending: false } });
      } catch {
        // Non-critical — ignore
      }
    }

    // Navigate to the user's board + session
    if (result.boardId && result.sessionId) {
      navigate(`/b/${result.boardId}/${result.sessionId}/`);
    } else if (result.boardId) {
      navigate(`/b/${result.boardId}/`);
    }
  };

  // NOW handle conditional rendering based on state
  // Show loading while fetching auth config
  if (authConfigLoading) {
    return (
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
    );
  }

  // Show auth config error ONLY if we don't have a config yet (first load)
  // If we already have a config cached, continue with that even if there's an error
  if (authConfigError && !authConfig) {
    return (
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
          title="Could not fetch daemon configuration"
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
  // ONLY show fullscreen on initial connection, not during reconnections
  if (authConfig?.requireAuth && hasTokens && (!connected || !authenticated) && !hasLoadedOnce) {
    return (
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
    );
  }

  // Show loading while checking authentication (only if auth is required)
  if (authConfig?.requireAuth && authLoading) {
    return (
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
          title="Failed to connect to Agor daemon"
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
    );
  }

  // Show loading state ONLY on initial load, not during reconnections
  // Once data is loaded, keep UI mounted and show connection status in header instead
  if ((connecting || loading) && !hasLoadedOnce) {
    return (
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
    );
  }

  // Show data error (but not if user needs to change password - let the modal render)
  if (dataError && !user?.must_change_password) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
        }}
      >
        <Alert type="error" title="Failed to load data" description={dataError} showIcon />
      </div>
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

        // Associate session-scope env var selections if provided.
        if (config.envVarNames && config.envVarNames.length > 0) {
          await handleUpdateSessionEnvSelections(session.session_id, config.envVarNames);
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
  //
  // On failure we RETHROW the error so upstream modals (ForkSpawnModal) can
  // stay open and preserve the user's typed prompt. The error toast is still
  // surfaced here so the user gets immediate feedback either way. We also
  // mirror the prompt onto the forked session's per-session draft so that if
  // the async executor spawn fails later (the fork REST call can succeed
  // while the background executor errors out silently), the user can still
  // find their prompt in the new session's compose box.
  const handleForkSession = async (sessionId: string, prompt: string) => {
    try {
      const session = await forkSession(sessionId as SessionID, prompt);
      showSuccess('Session forked successfully!');
      // Seed a per-session draft on the new fork so the prompt is recoverable
      // even if the background executor fails after the REST call returned.
      handleUpdateDraft(session.session_id, prompt);
      // Clear the parent's draft after a successful fork
      handleClearDraft(sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fork session';
      showError(`Failed to fork session: ${message}`);
      throw err;
    }
  };

  // Handle btw fork session (ephemeral fork for side questions)
  const handleBtwForkSession = async (sessionId: string, prompt: string) => {
    try {
      const session = await btwForkSession(sessionId as SessionID, prompt);
      showSuccess('Side question sent via btw fork');
      handleUpdateDraft(session.session_id, prompt);
      handleClearDraft(sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create btw fork';
      showError(`Failed to create btw fork: ${message}`);
      throw err;
    }
  };

  // Handle spawn session
  const handleSpawnSession = async (sessionId: string, config: string | Partial<SpawnConfig>) => {
    // Handle both string prompt and full SpawnConfig
    const spawnConfig = typeof config === 'string' ? { prompt: config } : config;
    try {
      const session = await spawnSession(sessionId as SessionID, spawnConfig);
      showSuccess('Subsession session spawned successfully!');
      if (spawnConfig.prompt?.trim()) {
        handleUpdateDraft(session.session_id, spawnConfig.prompt);
      }
      // Clear the draft after spawning subsession
      handleClearDraft(sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to spawn session';
      showError(`Failed to spawn session: ${message}`);
      throw err;
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
      await client.sessions.prompt(sessionId, prompt, {
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

  const handleArchiveBoard = async (boardId: string) => {
    const archived = await archiveBoard(boardId as UUID);
    if (archived) {
      showSuccess('Board archived successfully!');
    }
  };

  const handleUnarchiveBoard = async (boardId: string) => {
    const unarchived = await unarchiveBoard(boardId as UUID);
    if (unarchived) {
      showSuccess('Board unarchived successfully!');
    }
  };

  // Handle repo CRUD
  const handleCreateRepo = async (data: CreateRepoRequest) => {
    if (!client) {
      showError('Not connected to daemon — cannot clone repository');
      return;
    }

    // POST /repos/clone returns { status: 'pending' } immediately; the actual
    // clone runs asynchronously in the executor. Show a persistent loading
    // toast and wire one-shot listeners to resolve it on success or failure,
    // with a safety timeout so the toast doesn't linger if events get lost.
    const toastKey = `clone-repo-${data.slug}`;
    const CLONE_TIMEOUT_MS = 120_000;
    showLoading(`Cloning ${data.slug}...`, { key: toastKey });

    const reposService = client.service('repos');
    let settled = false;

    const cleanup = () => {
      reposService.removeListener('created', handleCreated);
      client.io.off('repo:cloneError', handleCloneError);
      clearTimeout(timeoutHandle);
    };
    const handleCreated = (repo: Repo) => {
      if (settled || repo.slug !== data.slug) return;
      settled = true;
      showSuccess(`Cloned ${data.slug}`, { key: toastKey });
      cleanup();
    };
    const handleCloneError = (payload: { slug?: string; url?: string; error?: string }) => {
      if (settled) return;
      if (payload.slug !== data.slug && payload.url !== data.url) return;
      settled = true;
      showError(`Failed to clone ${data.slug}: ${payload.error ?? 'unknown error'}`, {
        key: toastKey,
      });
      cleanup();
    };
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      showError(`Clone of ${data.slug} timed out after 2 minutes. Check daemon logs.`, {
        key: toastKey,
      });
      cleanup();
    }, CLONE_TIMEOUT_MS);

    reposService.on('created', handleCreated);
    client.io.on('repo:cloneError', handleCloneError);

    try {
      const result = (await client.service('repos/clone').create({
        url: data.url,
        slug: data.slug,
        default_branch: data.default_branch,
      })) as { status?: 'pending' | 'exists'; slug?: string };

      // Daemon short-circuits with `status: 'exists'` when a repo with this
      // slug is already registered — no `repos.created` event will fire, so
      // resolve the loading toast here instead of waiting for the timeout.
      if (result?.status === 'exists' && !settled) {
        settled = true;
        showWarning(`Repository "${data.slug}" is already added`, { key: toastKey });
        cleanup();
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        showError(
          `Failed to clone repository: ${error instanceof Error ? error.message : String(error)}`,
          { key: toastKey }
        );
        cleanup();
      }
      throw error;
    }
  };

  const handleCreateLocalRepo = async (data: CreateLocalRepoRequest) => {
    if (!client) {
      showError('Not connected to daemon — cannot add local repository');
      return;
    }
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
    if (!client) {
      throw new Error('Not connected to daemon');
    }
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
      throw error;
    }
  };

  const handleUnarchiveWorktree = async (worktreeId: string, options?: { boardId?: string }) => {
    if (!client) {
      throw new Error('Not connected to daemon');
    }
    try {
      showLoading('Unarchiving worktree...', { key: 'unarchive' });
      await client.service(`worktrees/${worktreeId}/unarchive`).create(options || {});
      showSuccess('Worktree unarchived successfully!', { key: 'unarchive' });
    } catch (error) {
      showError(
        `Failed to unarchive worktree: ${error instanceof Error ? error.message : String(error)}`,
        { key: 'unarchive' }
      );
      throw error;
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

  // Manually trigger a scheduled run for a worktree (execute-now).
  // Reuses the scheduler's spawn path server-side so the session is a
  // first-class scheduled session, just with triggered_manually=true.
  const handleExecuteScheduleNow = async (worktreeId: string) => {
    if (!client) return;
    try {
      showLoading('Starting scheduled run...', { key: 'execute-now' });
      await client.service(`worktrees/${worktreeId}/execute-schedule-now`).create({});
      showSuccess('Scheduled run started!', { key: 'execute-now' });
    } catch (error) {
      // Surface 409 (schedule_busy) and 400 (schedule_disabled/incomplete)
      // with the server-provided message — it's already user-facing.
      const msg = error instanceof Error ? error.message : String(error);
      showError(`Failed to start scheduled run: ${msg}`, { key: 'execute-now' });
      throw error;
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

  // Handle artifact CRUD (edit + delete only — creation via MCP tools)
  const handleUpdateArtifact = async (artifactId: string, updates: Partial<Artifact>) => {
    if (!client) return;
    try {
      await client.service('artifacts').patch(artifactId, updates);
      showSuccess('Artifact updated!');
    } catch (error) {
      showError(
        `Failed to update artifact: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleDeleteArtifact = async (artifactId: string) => {
    if (!client) return;
    try {
      await client.service('artifacts').remove(artifactId);
      showSuccess('Artifact deleted!');
    } catch (error) {
      showError(
        `Failed to delete artifact: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Handle update session env var selections (session-scope vars to export to
  // the executor process). Only the session's creator or an admin can edit these.
  const handleUpdateSessionEnvSelections = async (sessionId: string, envVarNames: string[]) => {
    if (!client) return;
    try {
      await client.service(`sessions/${sessionId}/env-selections`).patch(null, {
        envVarNames,
      });
    } catch (error) {
      showError(
        `Failed to update session env var selections: ${error instanceof Error ? error.message : String(error)}`
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
    <ServicesConfigContext.Provider value={servicesConfig}>
      <ConnectionProvider value={{ connected, connecting, outOfSync, capturedSha, currentSha }}>
        {/* Force Password Change Modal - shown when user.must_change_password is true */}
        <ForcePasswordChangeModal
          open={!!currentUser?.must_change_password}
          user={currentUser}
          onChangePassword={handleForcePasswordChange}
          onLogout={logout}
        />

        {/* Onboarding Wizard - shown for new users */}
        <OnboardingWizard
          open={onboardingWizardOpen}
          onComplete={handleOnboardingComplete}
          repoById={repoById}
          worktreeById={worktreeById}
          boardById={boardById}
          user={currentUser}
          client={client}
          onCreateRepo={handleCreateRepo}
          onCreateLocalRepo={handleCreateLocalRepo}
          onCreateWorktree={handleCreateWorktree}
          onCreateSession={handleCreateSession}
          onUpdateUser={handleUpdateUser}
          onUpdateWorktree={handleUpdateWorktree}
          assistantPending={
            onboardingConfig?.assistantPending ?? onboardingConfig?.persistedAgentPending
          }
          frameworkRepoUrl={onboardingConfig?.frameworkRepoUrl}
          systemCredentials={onboardingConfig?.systemCredentials}
        />

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
                  cardById={cardById}
                  cardTypeById={cardTypeById}
                  repoById={repoById}
                  worktreeById={worktreeById}
                  userById={userById}
                  mcpServerById={mcpServerById}
                  sessionMcpServerIds={sessionMcpServerIds}
                  userAuthenticatedMcpServerIds={userAuthenticatedMcpServerIds}
                  initialBoardId={Array.from(boardById.values())[0]?.board_id}
                  openSettingsTab={settingsTabToOpen}
                  onSettingsClose={handleSettingsClose}
                  openUserSettings={openUserSettings}
                  onUserSettingsClose={handleUserSettingsClose}
                  openNewWorktreeModal={openNewWorktree}
                  onNewWorktreeModalClose={handleNewWorktreeModalClose}
                  onCreateSession={handleCreateSession}
                  onForkSession={handleForkSession}
                  onBtwForkSession={handleBtwForkSession}
                  onSpawnSession={handleSpawnSession}
                  onSendPrompt={handleSendPrompt}
                  onUpdateSession={handleUpdateSession}
                  onDeleteSession={handleDeleteSession}
                  onCreateBoard={handleCreateBoard}
                  onUpdateBoard={handleUpdateBoard}
                  onDeleteBoard={handleDeleteBoard}
                  onArchiveBoard={handleArchiveBoard}
                  onUnarchiveBoard={handleUnarchiveBoard}
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
                  onExecuteScheduleNow={handleExecuteScheduleNow}
                  onCreateUser={handleCreateUser}
                  onUpdateUser={handleUpdateUser}
                  onDeleteUser={handleDeleteUser}
                  onCreateMCPServer={handleCreateMCPServer}
                  onDeleteMCPServer={handleDeleteMCPServer}
                  gatewayChannelById={gatewayChannelById}
                  onCreateGatewayChannel={handleCreateGatewayChannel}
                  onUpdateGatewayChannel={handleUpdateGatewayChannel}
                  onDeleteGatewayChannel={handleDeleteGatewayChannel}
                  artifactById={artifactById}
                  onUpdateArtifact={handleUpdateArtifact}
                  onDeleteArtifact={handleDeleteArtifact}
                  onUpdateSessionMcpServers={handleUpdateSessionMcpServers}
                  onUpdateSessionEnvSelections={handleUpdateSessionEnvSelections}
                  onSendComment={handleSendComment}
                  onReplyComment={handleReplyComment}
                  onResolveComment={handleResolveComment}
                  onToggleReaction={handleToggleReaction}
                  onDeleteComment={handleDeleteComment}
                  onLogout={logout}
                  onRetryConnection={retryConnection}
                  instanceLabel={instanceConfig?.label}
                  instanceDescription={instanceConfig?.description}
                  webTerminalEnabled={featuresConfig?.webTerminal === true}
                />
              </>
            }
          />

          {/* Desktop routes - board only (Django-style trailing slash) */}
          <Route
            path="/b/:boardParam/"
            element={
              <>
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
                  cardById={cardById}
                  cardTypeById={cardTypeById}
                  repoById={repoById}
                  worktreeById={worktreeById}
                  userById={userById}
                  mcpServerById={mcpServerById}
                  sessionMcpServerIds={sessionMcpServerIds}
                  userAuthenticatedMcpServerIds={userAuthenticatedMcpServerIds}
                  initialBoardId={Array.from(boardById.values())[0]?.board_id}
                  openSettingsTab={settingsTabToOpen}
                  onSettingsClose={handleSettingsClose}
                  openUserSettings={openUserSettings}
                  onUserSettingsClose={handleUserSettingsClose}
                  openNewWorktreeModal={openNewWorktree}
                  onNewWorktreeModalClose={handleNewWorktreeModalClose}
                  onCreateSession={handleCreateSession}
                  onForkSession={handleForkSession}
                  onBtwForkSession={handleBtwForkSession}
                  onSpawnSession={handleSpawnSession}
                  onSendPrompt={handleSendPrompt}
                  onUpdateSession={handleUpdateSession}
                  onDeleteSession={handleDeleteSession}
                  onCreateBoard={handleCreateBoard}
                  onUpdateBoard={handleUpdateBoard}
                  onDeleteBoard={handleDeleteBoard}
                  onArchiveBoard={handleArchiveBoard}
                  onUnarchiveBoard={handleUnarchiveBoard}
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
                  onExecuteScheduleNow={handleExecuteScheduleNow}
                  onCreateUser={handleCreateUser}
                  onUpdateUser={handleUpdateUser}
                  onDeleteUser={handleDeleteUser}
                  onCreateMCPServer={handleCreateMCPServer}
                  onDeleteMCPServer={handleDeleteMCPServer}
                  gatewayChannelById={gatewayChannelById}
                  onCreateGatewayChannel={handleCreateGatewayChannel}
                  onUpdateGatewayChannel={handleUpdateGatewayChannel}
                  onDeleteGatewayChannel={handleDeleteGatewayChannel}
                  artifactById={artifactById}
                  onUpdateArtifact={handleUpdateArtifact}
                  onDeleteArtifact={handleDeleteArtifact}
                  onUpdateSessionMcpServers={handleUpdateSessionMcpServers}
                  onUpdateSessionEnvSelections={handleUpdateSessionEnvSelections}
                  onSendComment={handleSendComment}
                  onReplyComment={handleReplyComment}
                  onResolveComment={handleResolveComment}
                  onToggleReaction={handleToggleReaction}
                  onDeleteComment={handleDeleteComment}
                  onLogout={logout}
                  onRetryConnection={retryConnection}
                  instanceLabel={instanceConfig?.label}
                  instanceDescription={instanceConfig?.description}
                  webTerminalEnabled={featuresConfig?.webTerminal === true}
                />
              </>
            }
          />

          {/* Desktop routes - fallback for root path */}
          <Route
            path="/*"
            element={
              <>
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
                  cardById={cardById}
                  cardTypeById={cardTypeById}
                  repoById={repoById}
                  worktreeById={worktreeById}
                  userById={userById}
                  mcpServerById={mcpServerById}
                  sessionMcpServerIds={sessionMcpServerIds}
                  userAuthenticatedMcpServerIds={userAuthenticatedMcpServerIds}
                  initialBoardId={Array.from(boardById.values())[0]?.board_id}
                  openSettingsTab={settingsTabToOpen}
                  onSettingsClose={handleSettingsClose}
                  openUserSettings={openUserSettings}
                  onUserSettingsClose={handleUserSettingsClose}
                  openNewWorktreeModal={openNewWorktree}
                  onNewWorktreeModalClose={handleNewWorktreeModalClose}
                  onCreateSession={handleCreateSession}
                  onForkSession={handleForkSession}
                  onBtwForkSession={handleBtwForkSession}
                  onSpawnSession={handleSpawnSession}
                  onSendPrompt={handleSendPrompt}
                  onUpdateSession={handleUpdateSession}
                  onDeleteSession={handleDeleteSession}
                  onCreateBoard={handleCreateBoard}
                  onUpdateBoard={handleUpdateBoard}
                  onDeleteBoard={handleDeleteBoard}
                  onArchiveBoard={handleArchiveBoard}
                  onUnarchiveBoard={handleUnarchiveBoard}
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
                  onExecuteScheduleNow={handleExecuteScheduleNow}
                  onCreateUser={handleCreateUser}
                  onUpdateUser={handleUpdateUser}
                  onDeleteUser={handleDeleteUser}
                  onCreateMCPServer={handleCreateMCPServer}
                  onDeleteMCPServer={handleDeleteMCPServer}
                  gatewayChannelById={gatewayChannelById}
                  onCreateGatewayChannel={handleCreateGatewayChannel}
                  onUpdateGatewayChannel={handleUpdateGatewayChannel}
                  onDeleteGatewayChannel={handleDeleteGatewayChannel}
                  artifactById={artifactById}
                  onUpdateArtifact={handleUpdateArtifact}
                  onDeleteArtifact={handleDeleteArtifact}
                  onUpdateSessionMcpServers={handleUpdateSessionMcpServers}
                  onUpdateSessionEnvSelections={handleUpdateSessionEnvSelections}
                  onSendComment={handleSendComment}
                  onReplyComment={handleReplyComment}
                  onResolveComment={handleResolveComment}
                  onToggleReaction={handleToggleReaction}
                  onDeleteComment={handleDeleteComment}
                  onLogout={logout}
                  onRetryConnection={retryConnection}
                  instanceLabel={instanceConfig?.label}
                  instanceDescription={instanceConfig?.description}
                  webTerminalEnabled={featuresConfig?.webTerminal === true}
                />
              </>
            }
          />
        </Routes>
      </ConnectionProvider>
    </ServicesConfigContext.Provider>
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
