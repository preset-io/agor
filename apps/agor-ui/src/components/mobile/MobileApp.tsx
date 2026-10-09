import type {
  AgenticToolName,
  AgorClient,
  Board,
  Branch,
  BranchArchiveOrDeleteOptions,
  CreateLocalRepoRequest,
  CreateRepoRequest,
  Repo,
  Session,
  SpawnConfig,
  User,
} from '@agor-live/client';
import { getTeammateConfig, hasMinimumRole, ROLES } from '@agor-live/client';
import { Alert, Button, Drawer, Layout, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import type { AppActionsContextValue } from '../../contexts/AppActionsContext';
import { useConnectionState } from '../../contexts/ConnectionContext';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { useBoardPartition } from '../../hooks/useBoardPartition';
import { useBranchSessions } from '../../hooks/useBranchSessions';
import { useCommentsForYou } from '../../hooks/useCommentsForYou';
import { type CreateBranchFn, useCreateFlows } from '../../hooks/useCreateFlows';
import { useIdentityGuardedAsync } from '../../hooks/useIdentityGuardedAsync';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { usePrimaryTeammate } from '../../hooks/usePrimaryTeammate';
import { useRecentBoards } from '../../hooks/useRecentBoards';
import { useStableCallback } from '../../hooks/useStableCallback';
import { agorStore, useAgorStore } from '../../store/agorStore';
import {
  selectBoardById,
  selectBoardObjectsByBoardId,
  selectBranchById,
  selectRepoById,
  selectSessionById,
  selectSessionsByBranch,
  selectUserById,
} from '../../store/selectors';
import { clearOpenedSessionFlags } from '../../utils/sessionAttention';
import { resolveBoardFromUrlPure, resolveSessionFromShortIdPure } from '../../utils/urlResolution';
import { buildNewSessionConfig } from '../AgenticToolConfigurationPicker/newSessionConfig';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { resolveAvailableUserAgenticTool } from '../AgentSelectionGrid/availableAgents';
import { BranchModal, type BranchModalTab } from '../BranchModal';
import type { BranchUpdate } from '../BranchModal/useBranchModalForm';
import { CreateModals } from '../CreateModals';
import { type HomeLocationState, HomePage } from '../HomePage';
import { useHomeNeeds } from '../HomePage/useHomeNeeds';
import { PrimaryTeammatePicker } from '../SettingsModal/PrimaryTeammatePicker';
import { TeammatesDirectory } from '../TeammatesDirectory';
import { mobilePageStyle } from './constants';
import { type MobileBoardLocationState, MobileBoardPage } from './MobileBoardPage';
import { MobileHeader } from './MobileHeader';
import { MobileMarketplacePage } from './MobileMarketplacePage';
import { MobileMoreSheet } from './MobileMoreSheet';
import { MobileSearchPage } from './MobileSearchPage';
import { MobileSessionsPage } from './MobileSessionsPage';
import { type MobileTab, MobileTabBar } from './MobileTabBar';
import { SessionPage } from './SessionPage';
import { sessionBoardId } from './sessionBoardId';
import { useMobileBack } from './useMobileBack';

const NO_BOARDS: never[] = [];

interface MobileAppProps {
  client: AgorClient | null;
  user?: User | null;
  /** Authentication generation; scopes caller-bound lookups and in-flight session creation. */
  authGeneration: number;
  isAuthenticationGenerationCurrent?: (generation: number) => boolean;
  /** Shared post-onboarding banners (e.g. "AI not connected"); shown above the shell content. */
  topBanner?: React.ReactNode;
  onSendPrompt?: (
    sessionId: string,
    prompt: string
  ) => boolean | undefined | Promise<boolean | undefined>;
  onCreateSession: (
    config: NewSessionConfig,
    boardId: string
  ) => Promise<SessionCreationResult | null>;
  // Create seams for the shared create flows (New teammate / branch / board /
  // repo), reached from the "More" sheet's "Create new" row.
  onCreateBranch?: CreateBranchFn;
  onCreateBoard?: (board: Partial<Board>) => Promise<Board | null>;
  onCreateRepo: (data: CreateRepoRequest) => unknown;
  onCreateLocalRepo: (data: CreateLocalRepoRequest) => void | Promise<void>;
  branchStorageConfig?: BranchStorageConfig;
  // Full session controls for the reused SessionPanel composer (parity with desktop).
  onForkSession: (sessionId: string, prompt: string) => Promise<void>;
  onBtwForkSession: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onUpdateSession: (sessionId: string, updates: Partial<Session>) => void;
  onDeleteSession: (sessionId: string) => void;
  onUpdateSessionMcpServers?: (
    sessionId: string,
    mcpServerIds: string[],
    /** The links the user was shown; the change is diffed against them. */
    baselineIds?: string[]
  ) => void;
  onUpdateSessionEnvSelections?: (sessionId: string, envVarNames: string[]) => void;
  onSendComment: (boardId: string, content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
  onLogout?: () => void;
  /** Settings link to an external app (e.g. a hosting console), opened in a new tab */
  externalAppLink?: string;
  externalAppLabel?: string;
  onOpenWorkspaceSettings: (section: string) => void;
  onOpenUserSettings: () => void;
  onOpenAgenticToolSettings?: AppActionsContextValue['onOpenAgenticToolSettings'];
  // The branch bottom sheet offers the same edit/archive controls as the
  // desktop modal, so it needs the same handlers behind them, without which
  // the controls render enabled and then do nothing when tapped.
  onUpdateBranch?: (branchId: string, updates: BranchUpdate) => void | Promise<void>;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onArchiveOrDeleteBranch?: (
    branchId: string,
    options: BranchArchiveOrDeleteOptions
  ) => void | Promise<void>;
  onExecuteScheduleNow?: (branchId: string) => Promise<void>;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void;
}

/** Board comments are a tab of the board screen; keeps old `/m/comments/:boardId` links working. */
const BoardCommentsRedirect: React.FC = () => {
  const { boardId } = useParams<{ boardId: string }>();
  return <Navigate to={`/m/board/${boardId}?tab=comments`} replace />;
};

export const MobileApp: React.FC<MobileAppProps> = ({
  client,
  user,
  authGeneration,
  isAuthenticationGenerationCurrent,
  topBanner,
  onSendPrompt,
  onCreateSession,
  onCreateBranch,
  onCreateBoard,
  onCreateRepo,
  onCreateLocalRepo,
  branchStorageConfig,
  onForkSession,
  onBtwForkSession,
  onSpawnSession,
  onUpdateSession,
  onDeleteSession,
  onUpdateSessionMcpServers,
  onUpdateSessionEnvSelections,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
  onDeleteComment,
  onLogout,
  externalAppLink,
  externalAppLabel,
  onOpenWorkspaceSettings,
  onOpenUserSettings,
  onOpenAgenticToolSettings,
  onUpdateBranch,
  onUpdateRepo,
  onArchiveOrDeleteBranch,
  onExecuteScheduleNow,
  onUpdateBoard,
}) => {
  const navigate = useNavigate();
  const navigation = useAppNavigation();
  const location = useLocation();
  const goBackHome = useMobileBack('/m');
  const { connected, connecting } = useConnectionState();
  const reducedMotion = usePrefersReducedMotion();
  // Self-subscribe to the entity maps this surface drills into. The subscription
  // used to live in the outer App shell; relocating it here makes MobileApp the
  // subscription boundary so the shell re-renders only on load-state.
  const sessionById = useAgorStore(selectSessionById);
  const sessionsByBranch = useAgorStore(selectSessionsByBranch);
  const boardById = useAgorStore(selectBoardById);
  const boardObjectsByBoardId = useAgorStore(selectBoardObjectsByBoardId);
  const repoById = useAgorStore(selectRepoById);
  const branchById = useAgorStore(selectBranchById);
  const userById = useAgorStore(selectUserById);
  const agenticToolSettings = useAgorStore((s) => s.agenticToolSettingsByName);

  const [moreOpen, setMoreOpen] = useState(false);
  const [askPickerOpen, setAskPickerOpen] = useState(false);
  const [newSessionBranchId, setNewSessionBranchId] = useState<string | null>(null);
  const [branchEditor, setBranchEditor] = useState<{
    branchId: string;
    tab: BranchModalTab;
  } | null>(null);
  const selectedBranch = branchEditor ? (branchById.get(branchEditor.branchId) ?? null) : null;
  const selectedRepo = selectedBranch ? (repoById.get(selectedBranch.repo_id) ?? null) : null;
  // The desktop BranchModal's on-open read: the store holds only the loaded scopes' sessions.
  const branchSessions = useBranchSessions(client, branchEditor?.branchId ?? null);

  // The caller's primary assistant: Home shows its name and emoji, and Ask starts its session.
  const {
    branch: resolvedPrimaryBranch,
    ownedByCaller: primaryBranchIsOwned,
    setBranch: setPrimaryBranch,
    refresh: refreshPrimaryBranch,
  } = usePrimaryTeammate(client, user?.user_id, authGeneration);
  // A branch resolved for a previous caller is never shown or used as an Ask target.
  const primaryBranch = primaryBranchIsOwned ? resolvedPrimaryBranch : null;
  const primaryTeammateName = primaryBranch
    ? getTeammateConfig(primaryBranch)?.displayName
    : undefined;
  // One creation at a time, like desktop quick compose: the ref refuses a repeated tap, the state shows it as pending.
  const [creatingSession, setCreatingSession] = useState(false);
  const creatingSessionRef = useRef(false);
  const markCreating = useCallback((pending: boolean) => {
    creatingSessionRef.current = pending;
    setCreatingSession(pending);
  }, []);
  // One guard for every create flow: the newest creation owns navigation, so an older one settling late cannot yank the user away.
  // A guarded call dropped by an identity change never settles, so the pending flag is released here rather than in its `finally`.
  const sessionCreationGuard = useIdentityGuardedAsync([user?.user_id, authGeneration], () =>
    markCreating(false)
  );

  // Track the board in view so the Board tab has a target from any screen.
  // Falls back to the last visited board, the user's main board, then any board.
  const { recentBoardIds } = useRecentBoards(NO_BOARDS, '', user?.user_id);
  const boardToken = location.pathname.match(/^\/m\/board\/([^/]+)/)?.[1];
  const sessionToken = location.pathname.match(/^\/m\/session\/([^/]+)/)?.[1];
  const routedSessionId = sessionToken
    ? sessionById.has(sessionToken)
      ? sessionToken
      : resolveSessionFromShortIdPure(sessionToken, sessionById)
    : null;
  const routeBoardId = boardToken
    ? boardById.has(boardToken)
      ? boardToken
      : resolveBoardFromUrlPure(boardToken, boardById)
    : sessionBoardId(
        routedSessionId ? sessionById.get(routedSessionId) : undefined,
        branchById,
        boardById
      );
  const [currentBoardId, setCurrentBoardId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (routeBoardId) setCurrentBoardId(routeBoardId);
  }, [routeBoardId]);
  const effectiveBoardId = useMemo(() => {
    if (routeBoardId && boardById.has(routeBoardId)) return routeBoardId;
    if (currentBoardId && boardById.has(currentBoardId)) return currentBoardId;
    const lastBoardId = recentBoardIds.find((id) => boardById.has(id));
    if (lastBoardId) return lastBoardId;
    const mainBoardId = user?.preferences?.mainBoardId;
    if (mainBoardId && boardById.has(mainBoardId)) return mainBoardId;
    return boardById.keys().next().value as string | undefined;
  }, [routeBoardId, currentBoardId, recentBoardIds, boardById, user?.preferences?.mainBoardId]);

  // Load the effective board's partition when it is not complete yet.
  const { boardReady } = useBoardPartition(client, effectiveBoardId, {
    canUseMemberWorkspaceServices: hasMinimumRole(user?.role, ROLES.MEMBER),
  });

  // Same create flows as desktop, via the shared hook. Mobile has no board
  // canvas, so branch positions aren't captured; navigation lands on /m routes.
  const createFlows = useCreateFlows({
    client,
    currentUser: user,
    currentBoardId: effectiveBoardId,
    availableAgents: AVAILABLE_AGENTS,
    branchStorageConfig,
    navigation: {
      goToBranch: (branchId) => {
        const boardId = agorStore.getState().branchById.get(branchId)?.board_id;
        navigate(boardId ? `/m/board/${boardId}` : '/m');
      },
      goToBoard: (boardId) => navigate(`/m/board/${boardId}`),
      goToSession: (sessionId) => navigate(`/m/session/${sessionId}`),
    },
    onCreateBranch,
    onUpdateBranch,
    onCreateSession,
    onCreateBoard,
    onCreateRepo,
    onCreateLocalRepo,
  });

  // NB: match `/m/session/` (detail) with the trailing slash so it never
  // swallows `/m/sessions` (the sessions list under Home).
  const isSubView = location.pathname.startsWith('/m/session/');
  // Sessions folded into Home: /m and the sessions list both read as Home.
  const activeTab: MobileTab | null = location.pathname.startsWith('/m/board')
    ? 'board'
    : location.pathname.startsWith('/m/marketplace')
      ? 'marketplace'
      : isSubView
        ? null
        : 'home';

  const commentsBadge = useCommentsForYou(client, user).length;

  // Home's "need you" result, computed once here: the tab bar and Home both read it.
  const homeNeeds = useHomeNeeds(user?.user_id);
  const homeBadge = homeNeeds.needsCount + commentsBadge;

  // Start a FRESH session and land in its full-screen composer; an identity change mid-flight drops the result.
  const createAndOpenSession = useCallback(
    async (
      branch: { branch_id: string } & Pick<Branch, 'board_id' | 'mcp_server_ids'>,
      tool: AgenticToolName
    ) => {
      if (creatingSessionRef.current) return;
      markCreating(true);
      const operationGeneration = authGeneration;
      try {
        const result = await sessionCreationGuard.run(() =>
          onCreateSession(
            buildNewSessionConfig({ user, tool, branch, initialPrompt: '' }),
            branch.board_id ?? ''
          )
        );
        if (isAuthenticationGenerationCurrent?.(operationGeneration) === false) return;
        if (result?.sessionId) navigate(`/m/session/${result.sessionId}`);
      } finally {
        markCreating(false);
      }
    },
    [
      navigate,
      user,
      onCreateSession,
      sessionCreationGuard,
      markCreating,
      authGeneration,
      isAuthenticationGenerationCurrent,
    ]
  );

  // Every Ask tap creates a new session on the primary branch (never continues one).
  const startPrimarySession = useCallback(
    (branch: Branch) =>
      createAndOpenSession(
        branch,
        resolveAvailableUserAgenticTool(user, agenticToolSettings, AVAILABLE_AGENTS)
      ),
    [createAndOpenSession, user, agenticToolSettings]
  );

  const askPrimaryAssistant = useCallback(async () => {
    if (!client || creatingSessionRef.current) return;
    const branch = primaryBranch ?? (await refreshPrimaryBranch());
    if (branch === undefined) return;
    // No primary (or a transient resolve failure): open the mobile-native
    // picker — never fall through to the desktop Settings modal.
    if (!branch) {
      setAskPickerOpen(true);
      return;
    }
    await startPrimarySession(branch);
  }, [client, primaryBranch, refreshPrimaryBranch, startPrimarySession]);

  const handleTabSelect = useCallback(
    (tab: MobileTab) => {
      switch (tab) {
        case 'home':
          navigate('/m');
          break;
        case 'board':
          navigate(effectiveBoardId ? `/m/board/${effectiveBoardId}` : '/m/board');
          break;
        case 'ask':
          void askPrimaryAssistant();
          break;
        case 'marketplace':
          navigate('/m/marketplace');
          break;
        case 'more':
          setMoreOpen(true);
          break;
      }
    },
    [effectiveBoardId, navigate, askPrimaryAssistant]
  );

  const openHomeBoard = useCallback(
    (boardId: string) => navigate(`/m/board/${boardId}`),
    [navigate]
  );
  const openHomeSession = useCallback(
    (sessionId: string) => {
      clearOpenedSessionFlags(client, sessionId);
      navigate(`/m/session/${sessionId}`);
    },
    [client, navigate]
  );
  // A branch this shell hasn't loaded still opens the board its comment names.
  const openHomeBranch = useCallback(
    (branchId: string, boardId: string) =>
      openHomeBoard(agorStore.getState().branchById.get(branchId)?.board_id ?? boardId),
    [openHomeBoard]
  );
  const openBoardList = useCallback(
    () =>
      navigate(effectiveBoardId ? `/m/board/${effectiveBoardId}` : '/m/board', {
        state: { openBoardSwitcher: true } satisfies MobileBoardLocationState,
      }),
    [effectiveBoardId, navigate]
  );
  const openSessionList = useCallback(() => navigate('/m/sessions'), [navigate]);
  const openTeammates = useCallback(() => navigation.goToTeammates(), [navigation]);
  const createSession = useStableCallback(onCreateSession);

  // Comments for you across boards (Home › Needs you). Already on Home, it replaces the entry so Back still leaves.
  const onHome = location.pathname.replace(/\/$/, '') === '/m';
  const openComments = useCallback(
    () =>
      navigate('/m', {
        replace: onHome,
        state: { needsFilter: 'comments' } satisfies HomeLocationState,
      }),
    [navigate, onHome]
  );

  const canCreateSessions = hasMinimumRole(user?.role, ROLES.MEMBER);

  const withHeader = (title: string, page: React.ReactNode, onBack: () => void) => (
    <div style={mobilePageStyle}>
      <MobileHeader title={title} onBack={onBack} />
      <div style={{ flex: 1, minHeight: 0 }}>{page}</div>
    </div>
  );

  return (
    // Exactly the visible viewport (#root is 100dvh too, see index.html), so the
    // document never scrolls and iOS cannot lift the shell (and its tab bar) when
    // the toolbar hides; only page content scrolls. Clipping horizontally keeps
    // any wide descendant from widening it. Top and side insets apply here; the
    // tab bar alone owns the bottom inset.
    <Layout
      style={{
        height: '100dvh',
        boxSizing: 'border-box',
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        overflowX: 'hidden',
        overscrollBehavior: 'none',
      }}
    >
      {!connected && (
        <Alert
          banner
          type={connecting ? 'info' : 'warning'}
          showIcon
          message={
            connecting
              ? 'Reconnecting...'
              : "You're offline. Changes may not be saved until you reconnect."
          }
          style={{ flexShrink: 0 }}
        />
      )}
      {/* Proactive connect-AI / integrations banner, shared with desktop. Hidden
          on the session sub-view. */}
      {topBanner && !isSubView && <div style={{ flexShrink: 0 }}>{topBanner}</div>}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          overflowX: 'hidden',
        }}
      >
        {/* Descendant routes under `/m/*`; paths are RELATIVE to /m. */}
        <Routes>
          <Route
            index
            element={
              <div style={{ flex: 1, minHeight: 0 }}>
                <HomePage
                  client={client}
                  currentUser={user}
                  recentBoardIds={recentBoardIds}
                  onBoardClick={openHomeBoard}
                  onBranchClick={openHomeBranch}
                  onSessionClick={openHomeSession}
                  onCreateSession={canCreateSessions ? createSession : undefined}
                  onOpenCreateDialog={canCreateSessions ? createFlows.openCreate : undefined}
                  onOpenSettings={onOpenWorkspaceSettings}
                  onAllBoards={openBoardList}
                  onSeeAllSessions={openSessionList}
                  onSeeAllTeammates={openTeammates}
                  homeNeeds={homeNeeds}
                />
              </div>
            }
          />
          <Route
            path="teammates"
            element={withHeader(
              'AI teammates',
              <TeammatesDirectory
                client={client}
                currentUser={user}
                checkAccess={canCreateSessions}
                onOpenBoard={openHomeBoard}
              />,
              goBackHome
            )}
          />
          <Route
            path="sessions"
            element={
              <MobileSessionsPage
                sessionById={sessionById}
                branchById={branchById}
                userById={userById}
                sessionsByBranch={sessionsByBranch}
                currentUser={user}
                client={client}
                primaryBranch={primaryBranch}
                primaryTeammateName={primaryTeammateName}
                onForkSession={onForkSession}
                onSpawnSession={onSpawnSession}
                onCreateSessionOnBranch={(branchId) => setNewSessionBranchId(branchId)}
                onBack={goBackHome}
              />
            }
          />
          <Route
            path="marketplace"
            element={
              <MobileMarketplacePage
                client={client}
                currentUser={user}
                authGeneration={authGeneration}
              />
            }
          />
          <Route
            path="search"
            element={
              <MobileSearchPage
                client={client}
                currentUser={user}
                onOpenWorkspaceSettings={onOpenWorkspaceSettings}
                onOpenBranch={(branchId) => setBranchEditor({ branchId, tab: 'general' })}
              />
            }
          />
          <Route
            path="board"
            element={
              <Navigate
                to={effectiveBoardId ? `/m/board/${effectiveBoardId}` : '/m/sessions'}
                replace
              />
            }
          />
          <Route
            path="board/:boardId"
            element={
              <MobileBoardPage
                boardById={boardById}
                branchById={branchById}
                onOpenBranch={(branchId, tab) => setBranchEditor({ branchId, tab })}
                onNewSession={(branchId) => setNewSessionBranchId(branchId)}
                client={client}
                currentUser={user}
                onForkSession={onForkSession}
                onSpawnSession={onSpawnSession}
                onUpdateBoard={onUpdateBoard}
                onSendComment={onSendComment}
                onReplyComment={onReplyComment}
                onResolveComment={onResolveComment}
                onToggleReaction={onToggleReaction}
                onDeleteComment={onDeleteComment}
                boardReady={boardReady}
              />
            }
          />
          <Route
            path="session/:sessionId"
            element={
              <SessionPage
                client={client}
                boardById={boardById}
                sessionById={sessionById}
                branchById={branchById}
                currentUser={user}
                onSendPrompt={onSendPrompt}
                onForkSession={onForkSession}
                onBtwForkSession={onBtwForkSession}
                onSpawnSession={onSpawnSession}
                onUpdateSession={onUpdateSession}
                onDeleteSession={onDeleteSession}
                onUpdateSessionMcpServers={onUpdateSessionMcpServers}
                onUpdateSessionEnvSelections={onUpdateSessionEnvSelections}
                onOpenBranch={(branchId, tab = 'general') => setBranchEditor({ branchId, tab })}
                onOpenAgenticToolSettings={onOpenAgenticToolSettings}
              />
            }
          />
          <Route path="comments/:boardId" element={<BoardCommentsRedirect />} />
        </Routes>
      </div>

      {/* Docked as the last flex child of the fixed shell on EVERY /m screen,
          including session detail, so content (and the session composer) lays
          out above it with no overlap. On sub-views no tab is highlighted. */}
      <MobileTabBar
        activeTab={activeTab}
        onSelect={handleTabSelect}
        homeBadge={homeBadge}
        moreBadge={commentsBadge}
        askPending={creatingSession}
      />

      <Drawer
        open={askPickerOpen}
        onClose={() => setAskPickerOpen(false)}
        placement="bottom"
        height="auto"
        title="Choose your primary assistant"
        {...reducedMotionSurface(reducedMotion)}
        styles={{ body: { paddingBottom: 'env(safe-area-inset-bottom)' } }}
      >
        <Typography.Paragraph type="secondary">
          Pick the teammate to message from the Ask button. You can change it later in Settings.
        </Typography.Paragraph>
        <PrimaryTeammatePicker
          key={`${user?.user_id ?? 'anonymous'}:${authGeneration}`}
          client={client}
          currentUserId={user?.user_id}
          authenticationGeneration={authGeneration}
          compact
          onPicked={(branch) => {
            setPrimaryBranch(branch);
            setAskPickerOpen(false);
            void startPrimarySession(branch);
          }}
        />
        <Button
          type="link"
          style={{ paddingInline: 0 }}
          onClick={() => {
            setAskPickerOpen(false);
            onOpenWorkspaceSettings('teammates');
          }}
        >
          Create a new teammate
        </Button>
      </Drawer>

      <Drawer
        open={newSessionBranchId !== null}
        onClose={() => setNewSessionBranchId(null)}
        placement="bottom"
        height="auto"
        title="Choose a coding agent"
        {...reducedMotionSurface(reducedMotion)}
        styles={{ body: { paddingBottom: 'env(safe-area-inset-bottom)' } }}
      >
        <AgentSelectionGrid
          agents={AVAILABLE_AGENTS}
          selectedAgentId={null}
          onSelect={(agent) => {
            if (!newSessionBranchId) return;
            const branch = branchById.get(newSessionBranchId) ?? { branch_id: newSessionBranchId };
            setNewSessionBranchId(null);
            void createAndOpenSession(branch, agent as AgenticToolName);
          }}
          columns={2}
          size="small"
          showComparisonLink={false}
        />
      </Drawer>

      <MobileMoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        user={user}
        commentsBadge={commentsBadge}
        onOpenComments={openComments}
        onOpenWorkspaceSettings={onOpenWorkspaceSettings}
        onOpenUserSettings={onOpenUserSettings}
        onLogout={onLogout}
        externalAppLink={externalAppLink}
        externalAppLabel={externalAppLabel}
        onCreate={canCreateSessions ? createFlows.openCreate : undefined}
        isAdmin={hasMinimumRole(user?.role, ROLES.ADMIN)}
      />

      <CreateModals {...createFlows.createModalsProps} fullScreen />

      <BranchModal
        open={branchEditor !== null}
        onClose={() => setBranchEditor(null)}
        branch={selectedBranch}
        repo={selectedRepo}
        sessions={branchSessions}
        boardObjects={
          selectedBranch?.board_id ? (boardObjectsByBoardId.get(selectedBranch.board_id) ?? []) : []
        }
        client={client}
        currentUser={user}
        defaultTab={branchEditor?.tab}
        presentation="bottom-sheet"
        onUpdateBranch={onUpdateBranch}
        onUpdateRepo={onUpdateRepo}
        onArchiveOrDelete={onArchiveOrDeleteBranch}
        onExecuteScheduleNow={onExecuteScheduleNow}
        onSessionClick={(sessionId) => {
          setBranchEditor(null);
          navigate(`/m/session/${sessionId}`);
        }}
        onOpenSettings={() => {
          setBranchEditor(null);
          onOpenWorkspaceSettings('repos');
        }}
      />
    </Layout>
  );
};
