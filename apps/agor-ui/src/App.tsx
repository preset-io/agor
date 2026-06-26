import type {
  Artifact,
  AuthCheckResult,
  Board,
  BoardID,
  Branch,
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
} from '@agor-live/client';
import {
  boardPath,
  ENTITY_PATH_SEGMENTS,
  getRepoReferenceOptions,
  sessionPath,
} from '@agor-live/client';
import { Alert, App as AntApp, ConfigProvider } from 'antd';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AVAILABLE_AGENTS } from './components/AgentSelectionGrid';
import type { BranchUpdate } from './components/BranchModal/tabs/GeneralTab';
import { ErrorBoundary, setCrashContext } from './components/ErrorBoundary';
import { ForcePasswordChangeModal } from './components/ForcePasswordChangeModal';
import { InitialLoadingScreen } from './components/InitialLoadingScreen';
import { LoginPage } from './components/LoginPage';
import { OnboardingWizard } from './components/OnboardingWizard';
import { CanvasNavigationProvider } from './contexts/CanvasNavigationContext';
import { ConnectionProvider } from './contexts/ConnectionContext';
import { ServicesConfigContext } from './contexts/ServicesConfigContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import {
  useAgorClient,
  useAgorData,
  useAuth,
  useAuthConfig,
  useBoardActions,
  useInitialLoaderPhase,
  useServerVersion,
  useSessionActions,
} from './hooks';
import { useSurfaceBranding } from './hooks/useSurfaceBranding';
import { SharedUserSettingsModal } from './surfaces/SharedUserSettingsModal';
import type { RouteSurfaceId } from './surfaces/surfaceRegistry';
import {
  ARTIFACT_FULLSCREEN_ROUTE_PATHS,
  KNOWLEDGE_ROUTE_PATHS,
  routeUsesDeviceRouter,
} from './surfaces/surfaceRegistry';
import { useWorkspaceSurfaceLifecycle } from './surfaces/useWorkspaceSurfaceLifecycle';
import { isMobileDevice } from './utils/deviceDetection';
import { completeForcedPasswordChange } from './utils/forcePasswordChange';
import { useThemedMessage } from './utils/message';
import { updateSessionMcpServers } from './utils/sessionMcpServers';
import { getRouterBasename } from './utils/uiRoutes';

type RouteModuleKey = RouteSurfaceId | 'mobile';

type EnvironmentAction = 'start' | 'stop' | 'nuke';

interface PendingEnvironmentToast {
  action: EnvironmentAction;
  key: string;
  requestedAt: number;
}

const ENV_ACTION_COPY: Record<EnvironmentAction, { present: string; gerund: string }> = {
  start: { present: 'start', gerund: 'Starting' },
  stop: { present: 'stop', gerund: 'Stopping' },
  nuke: { present: 'nuke', gerund: 'Nuking' },
};

const loadedRouteModuleKeys = new Set<RouteModuleKey>();

function cacheRouteLoader<TModule, TRouteModule>(
  moduleKey: RouteModuleKey,
  importModule: () => Promise<TModule>,
  selectDefault: (module: TModule) => TRouteModule
) {
  let promise: Promise<TRouteModule> | null = null;

  return () => {
    promise ??= importModule().then((module) => {
      loadedRouteModuleKeys.add(moduleKey);
      return selectDefault(module);
    });
    return promise;
  };
}

const loadAgorApp = cacheRouteLoader(
  'workspace',
  () => import('./components/App'),
  (module) => ({ default: module.App })
);
const loadKnowledgePage = cacheRouteLoader(
  'knowledge',
  () => import('./pages/KnowledgePage'),
  (module) => ({ default: module.KnowledgePage })
);
const loadArtifactFullscreenPage = cacheRouteLoader(
  'artifact-fullscreen',
  () => import('./pages/ArtifactFullscreenPage'),
  (module) => ({ default: module.ArtifactFullscreenPage })
);
const loadMobileApp = cacheRouteLoader(
  'mobile',
  () => import('./components/mobile/MobileApp'),
  (module) => ({ default: module.MobileApp })
);
const loadStreamdownDemoPage = cacheRouteLoader(
  'demo',
  () => import('./pages/StreamdownDemoPage'),
  (module) => ({ default: module.StreamdownDemoPage })
);
const MarketingScreenshotPage = lazy(() =>
  import('./pages/MarketingScreenshotPage').then((module) => ({
    default: module.MarketingScreenshotPage,
  }))
);

const AgorApp = lazy(loadAgorApp);
const KnowledgePage = lazy(loadKnowledgePage);
const ArtifactFullscreenPage = lazy(loadArtifactFullscreenPage);
const MobileApp = lazy(loadMobileApp);
const StreamdownDemoPage = lazy(loadStreamdownDemoPage);

const routeModuleLoaders = {
  workspace: loadAgorApp,
  knowledge: loadKnowledgePage,
  'artifact-fullscreen': loadArtifactFullscreenPage,
  demo: loadStreamdownDemoPage,
  mobile: loadMobileApp,
} satisfies Record<RouteModuleKey, () => Promise<unknown>>;

function getRouteModuleKey(surfaceId: RouteSurfaceId, pathname: string): RouteModuleKey {
  if (pathname.startsWith('/m')) return 'mobile';
  return surfaceId;
}

function preloadRouteModule(moduleKey: RouteModuleKey): Promise<unknown> {
  if (loadedRouteModuleKeys.has(moduleKey)) return Promise.resolve();
  return routeModuleLoaders[moduleKey]();
}

/**
 * DeviceRouter - Redirects users to mobile or desktop site based on device detection
 * Responds to window resize events for responsive switching
 */
function DeviceRouter() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!routeUsesDeviceRouter(location.pathname)) return;

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
  const { showSuccess, showError, showWarning, showLoading, destroy } = useThemedMessage();
  const navigate = useNavigate();
  const location = useLocation();
  const { currentSurface, workspaceSurfaceShouldRun } = useWorkspaceSurfaceLifecycle(
    location.pathname
  );
  // Apply each surface's declared favicon/title centrally. Non-dynamic surfaces
  // get the absolute brand mark + static title here; the 'dynamic' Workspace
  // shell no-ops and manages its own via useFaviconStatus/useBoardTitle. This
  // makes the registry's `branding` field the single enforcement point so a new
  // static surface can't forget to wire it.
  useSurfaceBranding(currentSurface);
  const sharedSurfaceOwnsUserSettings = currentSurface.usesSharedUserSettings;
  const routeModuleKey = getRouteModuleKey(currentSurface.id, location.pathname);
  const [routeModuleReady, setRouteModuleReady] = useState(() =>
    loadedRouteModuleKeys.has(routeModuleKey)
  );

  useEffect(() => {
    let cancelled = false;

    if (!loadedRouteModuleKeys.has(routeModuleKey)) {
      setRouteModuleReady(false);
    }

    preloadRouteModule(routeModuleKey)
      .catch(() => {
        // Let React.lazy/ErrorBoundary surface the route-load failure.
      })
      .finally(() => {
        if (!cancelled) setRouteModuleReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [routeModuleKey]);

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

  // Call ALL hooks unconditionally BEFORE any conditional returns.
  // Connect to daemon with authentication token (auth is always required —
  // anonymous mode was removed; the LoginPage gate below blocks rendering
  // until we have a token).
  const {
    client,
    connected,
    connecting,
    error: connectionError,
    retryConnection,
  } = useAgorClient({
    accessToken: authenticated ? accessToken : null,
  });
  const pendingEnvironmentToastsRef = useRef<Map<string, PendingEnvironmentToast>>(new Map());

  useEffect(() => {
    if (!client) return;

    const branchesService = client.service('branches');
    const handleBranchPatched = (branch: Branch) => {
      const pending = pendingEnvironmentToastsRef.current.get(branch.branch_id);
      if (!pending) return;

      const lastCommand = branch.environment_instance?.last_command;
      if (!lastCommand || lastCommand.action !== pending.action) return;

      const completedAt = Date.parse(lastCommand.timestamp);
      if (Number.isFinite(completedAt) && completedAt + 1000 < pending.requestedAt) return;

      const copy = ENV_ACTION_COPY[pending.action];
      if (lastCommand.status === 'succeeded') {
        showSuccess(`Environment ${copy.present} command executed successfully`, {
          key: pending.key,
        });
        pendingEnvironmentToastsRef.current.delete(branch.branch_id);
      } else if (lastCommand.status === 'failed') {
        const detail = lastCommand.message ? `: ${lastCommand.message}` : '';
        showError(`Environment ${copy.present} command failed${detail}`, { key: pending.key });
        pendingEnvironmentToastsRef.current.delete(branch.branch_id);
      }
    };

    branchesService.on('patched', handleBranchPatched);
    return () => {
      branchesService.removeListener('patched', handleBranchPatched);
    };
  }, [client, showError, showSuccess]);

  // Track FE/BE drift: capture the daemon's build SHA on first load (via
  // /health) and flip outOfSync when the daemon later reports a different
  // SHA on socket reconnect. Surfaced through ConnectionContext →
  // ConnectionStatus (amber tag with a refresh tooltip) and AboutTab (debug
  // rows). Mounted exactly once so all consumers share the same baseline.
  const { capturedSha, currentSha, outOfSync } = useServerVersion(client);

  const directSessionIdFromPath = location.pathname.match(/^\/s\/([^/]+)\/?$/)?.[1] ?? null;

  // Pass the stable client lifetime, not `connected ? client : null`:
  // useAgorData owns reconnect refetches and `null` is reserved for logout /
  // token removal. See the reset-effect comment in useAgorData.ts for the full
  // failure chain we're avoiding.
  // Skip data fetch if user needs to change password — the ForcePasswordChangeModal handles that.
  const {
    sessionById,
    sessionsByBranch,
    boardById,
    boardObjectById,
    boardObjectsByBoardId,
    commentById,
    cardById,
    cardTypeById,
    repoById,
    branchById,
    userById,
    mcpServerById,
    gatewayChannelById,
    artifactById,
    sessionMcpServerIds,
    userAuthenticatedMcpServerIds,
    initialLoadItems,
    initialLoadComplete,
    loadingStage,
    loading,
    error: dataError,
  } = useAgorData(client, {
    enabled: workspaceSurfaceShouldRun && !user?.must_change_password,
    directSessionId: directSessionIdFromPath,
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
  const [openNewBranch, setOpenNewBranch] = useState(false);

  // Detect GitHub App setup callback URL and auto-open gateway settings
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

  // Mark as loaded once the initial fetch completes (regardless of whether the
  // workspace is empty — checking map sizes failed for fresh instances with no
  // sessions/boards/repos yet).
  useEffect(() => {
    if (!loading && !dataError && initialLoadComplete) {
      setHasLoadedOnce(true);
    }
  }, [loading, initialLoadComplete, dataError]);

  const mustChangePassword = !!user?.must_change_password;
  const loaderPhase = useInitialLoaderPhase({
    connecting,
    loading,
    dataError,
    mustChangePassword,
    // Treat the route surface chunk as part of the initial load so the loader
    // only performs its fade-out once. Otherwise the data loader can fade to 0
    // and then pop back to opacity 1 while the lazy route module finishes.
    initialLoadComplete: initialLoadComplete && routeModuleReady,
  });

  const workspaceLoadingFallback = (
    <InitialLoadingScreen
      phase={loaderPhase === 'done' ? 'fading' : loaderPhase}
      connecting={connecting}
      loadingStage={loadingStage}
      items={initialLoadItems}
    />
  );

  const routeFallback = workspaceSurfaceShouldRun ? (
    workspaceLoadingFallback
  ) : (
    <InitialLoadingScreen message="Loading surface…" />
  );

  // Get current user from users Map (real-time updates via WebSocket)
  // This ensures we get the latest onboarding_completed status
  // Fall back to user from auth if users Map hasn't loaded yet
  const currentUser = user ? userById.get(user.user_id) || user : null;

  // Keep the global ErrorBoundary's crash context populated so a render
  // crash anywhere below us can produce a useful report (build SHA + signed-in
  // user). The boundary is a class component that lives ABOVE this tree, so
  // it can't read hooks — a module-level setter is the bridge.
  useEffect(() => {
    setCrashContext({
      buildSha: capturedSha,
      userEmail: currentUser?.email ?? null,
    });
  }, [capturedSha, currentUser?.email]);

  // Onboarding wizard state
  const [onboardingWizardOpen, setOnboardingWizardOpen] = useState(false);
  const [onboardingWizardInstance, setOnboardingWizardInstance] = useState(0);

  // Trigger wizard when user is loaded and hasn't completed onboarding
  useEffect(() => {
    if (
      currentUser &&
      currentUser.onboarding_completed === false &&
      !currentUser.must_change_password &&
      connected &&
      workspaceSurfaceShouldRun &&
      currentSurface.startsWorkspaceRuntime &&
      !loading
    ) {
      setOnboardingWizardOpen(true);
    }
  }, [
    currentUser,
    connected,
    workspaceSurfaceShouldRun,
    currentSurface.startsWorkspaceRuntime,
    loading,
  ]);

  // Handle wizard completion
  const handleOnboardingComplete = async (result: {
    branchId: string;
    sessionId: string;
    boardId: string;
    path: 'assistant' | 'own-repo';
  }) => {
    setOnboardingWizardOpen(false);

    if (!currentUser) return;

    // Silent + fire-and-forget: wizard closing + navigation is the confirmation here.
    // Non-critical — if the preference save fails the wizard just re-opens on next login.
    handleUpdateUser(
      currentUser.user_id,
      {
        onboarding_completed: true,
        preferences: {
          ...currentUser.preferences,
          mainBoardId: result.boardId || currentUser.preferences?.mainBoardId,
          onboarding: {
            path: result.path,
            branchId: result.branchId,
            boardId: result.boardId,
          },
        },
      },
      { silent: true }
    ).catch(() => {});

    // Clear the assistant pending flag if applicable
    if (result.path === 'assistant' && client) {
      try {
        await client.service('config').patch(null, { onboarding: { assistantPending: false } });
      } catch {
        // Non-critical — ignore
      }
    }

    // Navigate to the user's board + session, or to the boards list if they
    // skipped. Use the centralized path builders — the old
    // `/b/<board>/<session>/` shape was removed when we flattened entity URLs.
    if (result.sessionId) {
      navigate(sessionPath(result.sessionId as SessionID));
    } else if (result.boardId) {
      navigate(boardPath(result.boardId as BoardID, boardById.get(result.boardId)?.slug));
    } else {
      navigate('/');
    }
  };

  // NOW handle conditional rendering based on state
  // Show loading while fetching auth config
  if (authConfigLoading) {
    return <InitialLoadingScreen message="Loading…" />;
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

  // Auth is always required (anonymous mode was removed). Show login page
  // when not authenticated; reconnecting state when we have tokens but the
  // socket is reconnecting; spinner while authenticating.
  const hasTokens =
    typeof window !== 'undefined' &&
    !!(localStorage.getItem('agor-access-token') || localStorage.getItem('agor-refresh-token'));

  if (!authLoading && !authenticated && !hasTokens) {
    return (
      <LoginPage
        onLogin={login}
        error={authError}
        externalLaunchLoginRedirectUrl={
          authConfig?.externalLaunch?.enabled
            ? authConfig.externalLaunch.loginRedirectUrl
            : undefined
        }
      />
    );
  }

  // Show reconnecting state if we have tokens but lost connection.
  // ONLY show fullscreen on initial connection, not during reconnections.
  if (hasTokens && (!connected || !authenticated) && workspaceSurfaceShouldRun && !hasLoadedOnce) {
    return <InitialLoadingScreen message="Reconnecting to daemon…" />;
  }

  // Show loading while checking authentication
  if (authLoading) {
    return <InitialLoadingScreen message="Authenticating…" />;
  }

  // Show connection error
  if (connectionError) {
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
  if (workspaceSurfaceShouldRun && (loaderPhase !== 'done' || !routeModuleReady)) {
    return workspaceLoadingFallback;
  }

  // Show data error (but not if user needs to change password - let the modal render)
  if (workspaceSurfaceShouldRun && dataError && !user?.must_change_password) {
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
      const branch_id = config.branch_id;

      if (!branch_id) {
        throw new Error('Branch ID is required to create a session');
      }

      // Create the session with the branch_id
      const session = await createSession({
        ...config,
        branch_id,
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

  const handleUpdateUser = async (
    userId: string,
    updates: UpdateUserInput,
    options: { silent?: boolean } = {}
  ) => {
    if (!client) return;
    try {
      // Cast UpdateUserInput to Partial<User> - backend handles encryption/conversion
      await client.service('users').patch(userId, updates as Partial<User>);
      if (!options.silent) {
        showSuccess('User updated successfully!');
      }
    } catch (error) {
      if (!options.silent) {
        showError(
          `Failed to update user: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      throw error;
    }
  };

  const handleRestartOnboarding = async () => {
    if (!currentUser) return;

    const preferences = { ...(currentUser.preferences ?? {}) } as NonNullable<User['preferences']>;
    delete preferences.onboarding;

    try {
      await handleUpdateUser(currentUser.user_id, { preferences }, { silent: true });
    } catch (error) {
      showError(
        `Failed to restart onboarding: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    setOpenUserSettings(false);
    setOnboardingWizardInstance((value) => value + 1);
    setOnboardingWizardOpen(true);
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
    if (!currentUser?.email) throw new Error('Current user is unavailable');

    const signedIn = await completeForcedPasswordChange({
      client,
      userId,
      email: currentUser.email,
      newPassword,
      login,
      logout,
    });

    showSuccess(
      signedIn
        ? 'Password changed successfully!'
        : 'Password changed successfully. Please sign in again.'
    );
  };

  // Handle board CRUD
  const handleCreateBoard = async (board: Partial<Board>): Promise<Board | null> => {
    if (board.board_id) {
      // Board already exists (clone/import already persisted it) — return
      // the prebuilt row so callers can navigate to it without re-creating.
      return board as Board;
    }

    const created = await createBoard(board);
    if (created) {
      showSuccess('Board created successfully!');
    }
    return created;
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

    // POST /repos/clone returns `{ status: 'pending', repo_id }` immediately;
    // the daemon pre-creates the repo row with `clone_status: 'cloning'` and
    // the executor patches it to `'ready'`/`'failed'`. Listen for `patched`
    // (the durable outcome) — `created` only fires for the placeholder now,
    // unless the row is a legacy `create_local` (no `clone_status`).
    // `repo:cloneError` is kept as a belt-and-suspenders fallback so older
    // executors that don't patch still surface failures.
    const toastKey = `clone-repo-${data.slug}`;
    const CLONE_TIMEOUT_MS = 120_000;
    showLoading(`Cloning ${data.slug}...`, { key: toastKey });

    const reposService = client.service('repos');
    let settled = false;

    const cleanup = () => {
      reposService.removeListener('created', handleCreated);
      reposService.removeListener('patched', handlePatched);
      client.io.off('repo:cloneError', handleCloneError);
      clearTimeout(timeoutHandle);
    };
    const handleCreated = (repo: Repo) => {
      if (settled || repo.slug !== data.slug) return;
      // Skip the `'cloning'` placeholder — `handlePatched` will declare the
      // outcome once the executor finishes. `undefined` covers legacy rows
      // and any direct executor-path that bypasses the placeholder.
      if (repo.clone_status === 'cloning') return;
      settled = true;
      showSuccess(`Cloned ${data.slug}`, { key: toastKey });
      cleanup();
    };
    const handlePatched = (repo: Repo) => {
      if (settled || repo.slug !== data.slug) return;
      if (repo.clone_status === 'ready') {
        settled = true;
        showSuccess(`Cloned ${data.slug}`, { key: toastKey });
        cleanup();
      } else if (repo.clone_status === 'failed') {
        settled = true;
        const err = repo.clone_error;
        // Authoring-failed clones almost always mean the user has no
        // `GITHUB_TOKEN` configured (or it expired). Surface that hint
        // alongside the raw git message so the recovery path is one click.
        const hint =
          err?.category === 'auth_failed'
            ? ' — configure GITHUB_TOKEN in Settings → API Keys for private repos'
            : '';
        showError(`Failed to clone ${data.slug}: ${err?.message ?? 'unknown error'}${hint}`, {
          key: toastKey,
        });
        cleanup();
      }
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
    reposService.on('patched', handlePatched);
    client.io.on('repo:cloneError', handleCloneError);

    try {
      const result = await client.service('repos/clone').create({
        url: data.url,
        slug: data.slug,
        default_branch: data.default_branch,
      });

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
      throw error;
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

  const handleArchiveOrDeleteBranch = async (
    branchId: string,
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
      showLoading(`${options.metadataAction === 'archive' ? 'Archiving' : 'Deleting'} branch...`, {
        key: 'archive-delete',
      });
      await client.service(`branches/${branchId}/archive-or-delete`).create(options);
      showSuccess(`Branch ${action} successfully!`, { key: 'archive-delete' });
    } catch (error) {
      showError(
        `Failed to ${options.metadataAction} branch: ${error instanceof Error ? error.message : String(error)}`,
        { key: 'archive-delete' }
      );
      throw error;
    }
  };

  const handleUnarchiveBranch = async (branchId: string, options?: { boardId?: string }) => {
    if (!client) {
      throw new Error('Not connected to daemon');
    }
    try {
      showLoading('Unarchiving branch...', { key: 'unarchive' });
      await client.service(`branches/${branchId}/unarchive`).create(options || {});
      showSuccess('Branch unarchived successfully!', { key: 'unarchive' });
    } catch (error) {
      showError(
        `Failed to unarchive branch: ${error instanceof Error ? error.message : String(error)}`,
        { key: 'unarchive' }
      );
      throw error;
    }
  };

  const handleUpdateBranch = async (
    branchId: string,
    updates: BranchUpdate,
    options: { silent?: boolean } = {}
  ) => {
    if (!client) return;
    try {
      // Cast to Partial<Branch> to satisfy Feathers type checking
      // The backend MCP handler properly handles null values for clearing fields
      await client.service('branches').patch(branchId, updates as Partial<Branch>);
      if (!options.silent) showSuccess('Branch updated successfully!');
    } catch (error) {
      showError(
        `Failed to update branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleCreateBranch = async (
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
      custom_context?: Record<string, unknown>;
      notes?: string | null;
      position?: { x: number; y: number };
      storage_mode?: 'worktree' | 'clone';
      clone_depth?: number;
    }
  ): Promise<Branch | null> => {
    if (!client) return null;
    try {
      showLoading('Creating branch...', { key: 'create-branch' });

      const branch = (await client.service(`repos/${repoId}/branches`).create({
        name: data.name,
        ref: data.ref,
        refType: data.refType,
        createBranch: data.createBranch,
        pullLatest: data.pullLatest, // Fetch latest from remote before creating
        sourceBranch: data.sourceBranch, // Base new branch on specified source branch
        issue_url: data.issue_url,
        pull_request_url: data.pull_request_url,
        boardId: data.boardId, // Optional: add to board
        custom_context: data.custom_context,
        notes: data.notes,
        position: data.position, // Optional: position on board (defaults to center of viewport)
        storage_mode: data.storage_mode,
        clone_depth: data.clone_depth,
      })) as Branch;

      // Dismiss loading message - branch will appear on board via WebSocket broadcast
      destroy('create-branch');
      return branch;
    } catch (error) {
      showError(
        `Failed to create branch: ${error instanceof Error ? error.message : String(error)}`,
        { key: 'create-branch' }
      );
      return null;
    }
  };

  // Handle environment control
  const handleStartEnvironment = async (branchId: string) => {
    if (!client) return;
    const key = `start-env-${branchId}`;
    try {
      pendingEnvironmentToastsRef.current.set(branchId, {
        action: 'start',
        key,
        requestedAt: Date.now(),
      });
      showLoading('Starting environment...', { key });
      await client.service(`branches/${branchId}/start`).create({});
      showSuccess('Environment start requested', { key });
    } catch (error) {
      pendingEnvironmentToastsRef.current.delete(branchId);
      showError(
        `Failed to start environment: ${error instanceof Error ? error.message : String(error)}`,
        { key }
      );
    }
  };

  const handleStopEnvironment = async (branchId: string) => {
    if (!client) return;
    const key = `stop-env-${branchId}`;
    try {
      pendingEnvironmentToastsRef.current.set(branchId, {
        action: 'stop',
        key,
        requestedAt: Date.now(),
      });
      showLoading('Stopping environment...', { key });
      await client.service(`branches/${branchId}/stop`).create({});
      showSuccess('Environment stop requested', { key });
    } catch (error) {
      pendingEnvironmentToastsRef.current.delete(branchId);
      showError(
        `Failed to stop environment: ${error instanceof Error ? error.message : String(error)}`,
        { key }
      );
    }
  };

  const handleNukeEnvironment = async (branchId: string) => {
    if (!client) return;
    const key = `nuke-env-${branchId}`;
    try {
      pendingEnvironmentToastsRef.current.set(branchId, {
        action: 'nuke',
        key,
        requestedAt: Date.now(),
      });
      showLoading('Nuking environment...', { key });
      await client.service(`branches/${branchId}/nuke`).create({});
      showSuccess('Environment nuke requested', { key });
    } catch (error) {
      pendingEnvironmentToastsRef.current.delete(branchId);
      showError(
        `Failed to nuke environment: ${error instanceof Error ? error.message : String(error)}`,
        { key }
      );
    }
  };

  // Manually trigger a scheduled run for a branch (execute-now).
  // Reuses the scheduler's spawn path server-side so the session is a
  // first-class scheduled session, just with triggered_manually=true.
  const handleExecuteScheduleNow = async (branchId: string) => {
    if (!client) return;
    try {
      showLoading('Starting scheduled run...', { key: 'execute-now' });
      await client.service(`branches/${branchId}/execute-schedule-now`).create({});
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
      await updateSessionMcpServers(client, sessionId, currentIds, mcpServerIds);

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
        created_by: user?.user_id || 'unknown',
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
        created_by: user?.user_id || 'unknown',
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
        user_id: user?.user_id || 'unknown',
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
    Array.from(branchById.values())
  );
  const _branchOptions = allOptions.filter((opt) => opt.type === 'managed-branch');
  const _repoOptions = allOptions.filter((opt) => opt.type === 'managed');

  // Modal close handlers
  const handleSettingsClose = () => {
    setSettingsTabToOpen(null);
  };

  const handleUserSettingsClose = () => {
    setOpenUserSettings(false);
  };

  const handleNewBranchModalClose = () => {
    setOpenNewBranch(false);
  };

  const knowledgePageElement = (
    <KnowledgePage
      client={client}
      currentUser={currentUser}
      userById={userById}
      onUserSettingsClick={() => setOpenUserSettings(true)}
      onLogout={logout}
    />
  );

  const artifactFullscreenElement = (
    <ArtifactFullscreenPage
      client={client}
      currentUser={currentUser}
      onUserSettingsClick={() => setOpenUserSettings(true)}
      onLogout={logout}
    />
  );

  // All desktop entity URLs (/b/, /s/, /w/, /a/) render the same
  // AgorApp — the multiple routes exist so react-router's useParams
  // (read inside useUrlState) populates the right named params for
  // each URL shape (board / session / branch / artifact). Extract
  // the element once instead of duplicating the (long) prop list.
  const desktopAppElement = (
    <AgorApp
      client={client}
      user={currentUser}
      connected={connected}
      connecting={connecting}
      sessionById={sessionById}
      sessionsByBranch={sessionsByBranch}
      availableAgents={AVAILABLE_AGENTS}
      boardById={boardById}
      boardObjectById={boardObjectById}
      boardObjectsByBoardId={boardObjectsByBoardId}
      commentById={commentById}
      cardById={cardById}
      cardTypeById={cardTypeById}
      repoById={repoById}
      branchById={branchById}
      userById={userById}
      mcpServerById={mcpServerById}
      sessionMcpServerIds={sessionMcpServerIds}
      userAuthenticatedMcpServerIds={userAuthenticatedMcpServerIds}
      openSettingsTab={settingsTabToOpen}
      onSettingsClose={handleSettingsClose}
      openUserSettings={openUserSettings}
      onUserSettingsClose={handleUserSettingsClose}
      openNewBranchModal={openNewBranch}
      onNewBranchModalClose={handleNewBranchModalClose}
      suppressLeftPanel={onboardingWizardOpen}
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
      onArchiveOrDeleteBranch={handleArchiveOrDeleteBranch}
      onUnarchiveBranch={handleUnarchiveBranch}
      onUpdateBranch={handleUpdateBranch}
      onCreateBranch={handleCreateBranch}
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
      branchStorageConfig={featuresConfig?.branchStorage}
      onRestartOnboarding={handleRestartOnboarding}
    />
  );

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

        {/* Shared/current-user settings for lightweight surfaces. The full
            Workspace App still owns its existing settings stack; this wrapper
            lets Knowledge expose the user menu without mounting Workspace. */}
        {sharedSurfaceOwnsUserSettings && (
          <SharedUserSettingsModal
            open={openUserSettings}
            onClose={() => setOpenUserSettings(false)}
            user={currentUser}
            client={client}
            onUpdateUser={handleUpdateUser}
            onRefreshCurrentUser={reAuthenticate}
            onRestartOnboarding={handleRestartOnboarding}
          />
        )}

        {/* Onboarding Wizard - shown for new users.
            Key by user identity so the wizard's local React state (currentStep,
            resumedRef, createdRepoId, etc.) is bound to the signed-in user.
            On any user change (logout → login as someone else, or admin
            impersonate), React tears down + remounts the wizard with fresh
            state, eliminating any chance of one user's onboarding progress
            leaking into another user's session. */}
        <OnboardingWizard
          key={`${currentUser?.user_id ?? '__anon__'}:${onboardingWizardInstance}`}
          open={onboardingWizardOpen}
          onComplete={handleOnboardingComplete}
          repoById={repoById}
          branchById={branchById}
          boardById={boardById}
          user={currentUser}
          client={client}
          onCreateRepo={handleCreateRepo}
          onCreateLocalRepo={handleCreateLocalRepo}
          onCreateBranch={handleCreateBranch}
          onCreateSession={handleCreateSession}
          onUpdateUser={(userId, updates) => handleUpdateUser(userId, updates, { silent: true })}
          onUpdateBranch={(branchId, updates) =>
            handleUpdateBranch(branchId, updates, { silent: true })
          }
          onCheckAuth={async (tool, apiKey) => {
            if (!client) return { authenticated: false, method: 'none' as const };
            try {
              return (await client
                .service('check-auth')
                .create({ tool, apiKey })) as AuthCheckResult;
            } catch {
              return {
                authenticated: false,
                method: 'none' as const,
                hint: 'Connection check failed.',
              };
            }
          }}
          assistantPending={
            onboardingConfig?.assistantPending ?? onboardingConfig?.persistedAgentPending
          }
          frameworkRepoUrl={onboardingConfig?.frameworkRepoUrl}
        />

        <DeviceRouter />
        <Suspense fallback={routeFallback}>
          <Routes>
            {/* Demo routes */}
            <Route path="/demo/streamdown" element={<StreamdownDemoPage />} />
            <Route path="/demo/marketing-screenshots" element={<MarketingScreenshotPage />} />

            {/* Knowledge route shell. `/kb` is a short alias for the same surface. */}
            {KNOWLEDGE_ROUTE_PATHS.map((path) => (
              <Route key={path} path={path} element={knowledgePageElement} />
            ))}

            {/* Lightweight artifact fullscreen surface. Uses the shared auth shell,
                but does not start the Workspace board/session store on fresh loads. */}
            {ARTIFACT_FULLSCREEN_ROUTE_PATHS.map((path) => (
              <Route key={path} path={path} element={artifactFullscreenElement} />
            ))}

            {/* Mobile routes */}
            <Route
              path="/m/*"
              element={
                <MobileApp
                  client={client}
                  user={user}
                  sessionById={sessionById}
                  sessionsByBranch={sessionsByBranch}
                  boardById={boardById}
                  commentById={commentById}
                  repoById={repoById}
                  branchById={branchById}
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

            {/* Desktop routes — flat entity URLs. Boards have their own
                path because they're a destination; sub-entities (session,
                branch, artifact) get top-level paths keyed by short ID
                so they're stable across board moves. The app resolves the
                entity at click time, looks up its current board, and
                switches if needed. Path segments come from the shared
                `ENTITY_PATH_SEGMENTS` constant so this list and the
                URL/path builders can't drift. See
                `packages/core/src/utils/url.ts`. */}
            <Route
              path={`/${ENTITY_PATH_SEGMENTS.board}/:boardParam/`}
              element={desktopAppElement}
            />
            <Route
              path={`/${ENTITY_PATH_SEGMENTS.session}/:sessionShortId/`}
              element={desktopAppElement}
            />
            <Route
              path={`/${ENTITY_PATH_SEGMENTS.branch}/:branchShortId/`}
              element={desktopAppElement}
            />
            <Route
              path={`/${ENTITY_PATH_SEGMENTS.artifact}/:artifactShortId/`}
              element={desktopAppElement}
            />

            {/* Fallback for unknown / root paths */}
            <Route path="/*" element={desktopAppElement} />
          </Routes>
        </Suspense>
      </ConnectionProvider>
    </ServicesConfigContext.Provider>
  );
}

function AppWrapper() {
  const { getCurrentThemeConfig } = useTheme();
  const location = useLocation();
  const isMarketingScreenshotRoute = location.pathname === '/demo/marketing-screenshots';

  return (
    <ConfigProvider theme={getCurrentThemeConfig()}>
      <AntApp>
        <ErrorBoundary variant="global">
          {/* CanvasNavigationProvider lives outside the agor `App` body so
              hooks called in that body (useUrlState, useAppNavigation) can
              read the canvas-nav context. The inner App component used to
              wrap its own JSX in this provider; that's been removed. */}
          <CanvasNavigationProvider>
            {isMarketingScreenshotRoute ? (
              <Suspense fallback={<InitialLoadingScreen message="Loading demo fixture…" />}>
                <MarketingScreenshotPage />
              </Suspense>
            ) : (
              <AppContent />
            )}
          </CanvasNavigationProvider>
        </ErrorBoundary>
      </AntApp>
    </ConfigProvider>
  );
}

function App() {
  // Determine base path: '/ui' in production (served by daemon at that prefix)
  // and for branch-dev direct canonical links; '' for normal root-mounted Vite.
  const basename = getRouterBasename();

  return (
    <BrowserRouter basename={basename}>
      <ThemeProvider>
        <AppWrapper />
      </ThemeProvider>
    </BrowserRouter>
  );
}

export default App;
