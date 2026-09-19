import type {
  AgenticToolName,
  AgorClient,
  Branch,
  BranchArchiveOrDeleteOptions,
  Repo,
  Session,
  SpawnConfig,
  User,
} from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { Alert, Button, Drawer, Layout, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { AppActionsContextValue } from '../../contexts/AppActionsContext';
import { useConnectionState } from '../../contexts/ConnectionContext';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import { useIdentityGuardedAsync } from '../../hooks/useIdentityGuardedAsync';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { usePrimaryTeammate } from '../../hooks/usePrimaryTeammate';
import { useAgorStore } from '../../store/agorStore';
import {
  makeUnreadCommentCountSelector,
  selectArtifactById,
  selectBoardById,
  selectBoardObjectsByBoardId,
  selectBranchById,
  selectCardById,
  selectCommentById,
  selectRepoById,
  selectSessionById,
  selectSessionsByBranch,
  selectUserById,
} from '../../store/selectors';
import { isOwnActiveSession } from '../../utils/sessionSearch';
import { getSessionStatusTone } from '../../utils/sessionStatus';
import { buildNewSessionConfig } from '../AgenticToolConfigurationPicker/newSessionConfig';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { resolveAvailableUserAgenticTool } from '../AgentSelectionGrid/availableAgents';
import { BranchModal, type BranchModalTab } from '../BranchModal';
import type { BranchUpdate } from '../BranchModal/useBranchModalForm';
import { PrimaryTeammatePicker } from '../SettingsModal/PrimaryTeammatePicker';
import { MobileBoardPage } from './MobileBoardPage';
import { MobileCommentsPage } from './MobileCommentsPage';
import { MobileHomePage } from './MobileHomePage';
import { MobileMarketplacePage } from './MobileMarketplacePage';
import { MobileMoreSheet } from './MobileMoreSheet';
import { MobileSearchPage } from './MobileSearchPage';
import { MobileSessionsPage } from './MobileSessionsPage';
import { type MobileTab, MobileTabBar } from './MobileTabBar';
import { SessionPage } from './SessionPage';
import { useMobileBack } from './useMobileBack';

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
  // Full session controls for the reused SessionPanel composer (parity with desktop).
  onForkSession: (sessionId: string, prompt: string) => Promise<void>;
  onBtwForkSession: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onUpdateSession: (sessionId: string, updates: Partial<Session>) => void;
  onDeleteSession: (sessionId: string) => void;
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
  onUpdateSessionEnvSelections?: (sessionId: string, envVarNames: string[]) => void;
  onSendComment: (boardId: string, content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
  onLogout?: () => void;
  onOpenWorkspaceSettings: (section: string) => void;
  onOpenUserSettings: () => void;
  onOpenAgenticToolSettings?: AppActionsContextValue['onOpenAgenticToolSettings'];
  // The branch bottom sheet offers the same edit/archive controls as the
  // desktop modal, so it needs the same handlers behind them, without which
  // the controls render enabled and then do nothing when tapped.
  onUpdateBranch?: (branchId: string, updates: BranchUpdate) => void | Promise<void>;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onArchiveOrDeleteBranch?: (branchId: string, options: BranchArchiveOrDeleteOptions) => void;
  onExecuteScheduleNow?: (branchId: string) => Promise<void>;
}

export const MobileApp: React.FC<MobileAppProps> = ({
  client,
  user,
  authGeneration,
  isAuthenticationGenerationCurrent,
  topBanner,
  onSendPrompt,
  onCreateSession,
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
  onOpenWorkspaceSettings,
  onOpenUserSettings,
  onOpenAgenticToolSettings,
  onUpdateBranch,
  onUpdateRepo,
  onArchiveOrDeleteBranch,
  onExecuteScheduleNow,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const goBackFromComments = useMobileBack('/m');
  const { connected, connecting } = useConnectionState();
  const reducedMotion = usePrefersReducedMotion();
  // Self-subscribe to the entity maps this surface drills into. The subscription
  // used to live in the outer App shell; relocating it here makes MobileApp the
  // subscription boundary so the shell re-renders only on load-state.
  const sessionById = useAgorStore(selectSessionById);
  const sessionsByBranch = useAgorStore(selectSessionsByBranch);
  const boardById = useAgorStore(selectBoardById);
  const boardObjectsByBoardId = useAgorStore(selectBoardObjectsByBoardId);
  const cardById = useAgorStore(selectCardById);
  const artifactById = useAgorStore(selectArtifactById);
  const commentById = useAgorStore(selectCommentById);
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

  // The caller's primary assistant: Home shows its name and emoji, and Ask starts its session.
  const {
    branch: resolvedPrimaryBranch,
    current: primaryBranchIsCurrent,
    setBranch: setPrimaryBranch,
    refresh: refreshPrimaryBranch,
  } = usePrimaryTeammate(client, user?.user_id, authGeneration);
  // A held branch that is not the current caller's settled answer may be a previous caller's, so it is never an Ask target.
  const primaryBranch = primaryBranchIsCurrent ? resolvedPrimaryBranch : null;
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

  // Track the board in view so the Board / Comments tabs have a target even from
  // the Sessions tab. Falls back to the user's main board, then any board.
  const routeBoardId = location.pathname.match(/^\/m\/(?:board|comments)\/([^/]+)/)?.[1];
  const [currentBoardId, setCurrentBoardId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (routeBoardId) setCurrentBoardId(routeBoardId);
  }, [routeBoardId]);
  const effectiveBoardId = useMemo(() => {
    if (currentBoardId && boardById.has(currentBoardId)) return currentBoardId;
    const mainBoardId = user?.preferences?.mainBoardId;
    if (mainBoardId && boardById.has(mainBoardId)) return mainBoardId;
    return boardById.keys().next().value as string | undefined;
  }, [currentBoardId, boardById, user?.preferences?.mainBoardId]);

  // NB: match `/m/session/` (detail) with the trailing slash so it never
  // swallows `/m/sessions` (the Sessions tab). Comments open from the top-bar
  // bell as a full-screen sub-view (like session detail), not a bottom tab.
  const isSessionRoute = location.pathname.startsWith('/m/session/');
  const isCommentsRoute = location.pathname.startsWith('/m/comments');
  const isSubView = isSessionRoute || isCommentsRoute;
  // Sessions folded into Home: /m and the sessions list both read as Home.
  const activeTab: MobileTab | null = location.pathname.startsWith('/m/board')
    ? 'board'
    : location.pathname.startsWith('/m/marketplace')
      ? 'marketplace'
      : isSubView
        ? null
        : 'home';

  const sessionsBadge = useMemo(() => {
    let count = 0;
    for (const session of sessionById.values()) {
      if (!isOwnActiveSession(session, user?.user_id)) continue;
      if (getSessionStatusTone(session.status) === 'processing') count++;
    }
    return count;
  }, [sessionById, user?.user_id]);

  const commentsBadge = useAgorStore(
    useMemo(() => makeUnreadCommentCountSelector(effectiveBoardId), [effectiveBoardId])
  );

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
          if (effectiveBoardId) navigate(`/m/board/${effectiveBoardId}`);
          else setMoreOpen(true);
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

  // The top-bar bell opens the current board's comments/mentions (a full-screen
  // sub-view). No board yet -> the More sheet, which lists boards.
  const openComments = useCallback(() => {
    if (effectiveBoardId) navigate(`/m/comments/${effectiveBoardId}`);
    else setMoreOpen(true);
  }, [effectiveBoardId, navigate]);

  return (
    // The shell root is pinned to exactly the viewport and clips horizontally,
    // so no descendant on any tab can widen the document and clip the content
    // AND the in-flow bottom nav at the same right edge. Content is laid out
    // fluid (width:100%), so this never cuts anything legitimate.
    <Layout
      style={{
        height: '100dvh',
        width: '100%',
        maxWidth: '100%',
        margin: 0,
        overflowX: 'hidden',
        boxSizing: 'border-box',
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
          on full-screen sub-views (session detail, comments). */}
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
              <MobileHomePage
                sessionById={sessionById}
                branchById={branchById}
                boardById={boardById}
                currentUser={user}
                onAsk={() => void askPrimaryAssistant()}
                askPending={creatingSession}
                primaryTeammateName={primaryTeammateName}
                primaryTeammateEmoji={
                  primaryBranch ? getTeammateConfig(primaryBranch)?.emoji : undefined
                }
                assistantSessionCount={
                  primaryBranch ? (sessionsByBranch.get(primaryBranch.branch_id)?.length ?? 0) : 0
                }
                onOpenAssistantSessions={
                  primaryBranch ? () => navigate('/m/sessions?scope=assistant') : undefined
                }
                commentsBadge={commentsBadge}
                onOpenComments={openComments}
              />
            }
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
                commentsBadge={commentsBadge}
                onOpenComments={openComments}
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
                commentsBadge={commentsBadge}
                onOpenComments={openComments}
              />
            }
          />
          <Route
            path="search"
            element={
              <MobileSearchPage
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
                repoById={repoById}
                sessionsByBranch={sessionsByBranch}
                boardObjectsByBoardId={boardObjectsByBoardId}
                cardById={cardById}
                artifactById={artifactById}
                onOpenBranch={(branchId, tab) => setBranchEditor({ branchId, tab })}
                onNewSession={(branchId) => setNewSessionBranchId(branchId)}
                onGiveFirstTask={() => void askPrimaryAssistant()}
                firstTaskAssistantName={primaryTeammateName}
                commentsBadge={commentsBadge}
                onOpenComments={openComments}
              />
            }
          />
          <Route
            path="session/:sessionId"
            element={
              <SessionPage
                client={client}
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
          <Route
            path="comments/:boardId"
            element={
              <MobileCommentsPage
                client={client}
                boardById={boardById}
                commentById={commentById}
                branchById={branchById}
                userById={userById}
                currentUser={user}
                onBack={goBackFromComments}
                onSendComment={onSendComment}
                onReplyComment={onReplyComment}
                onResolveComment={onResolveComment}
                onToggleReaction={onToggleReaction}
                onDeleteComment={onDeleteComment}
              />
            }
          />
        </Routes>
      </div>

      {!isSubView && (
        <MobileTabBar
          activeTab={activeTab}
          onSelect={handleTabSelect}
          sessionsBadge={sessionsBadge}
          askPending={creatingSession}
        />
      )}

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
        boardById={boardById}
        branchById={branchById}
        sessionsByBranch={sessionsByBranch}
        commentById={commentById}
        onOpenWorkspaceSettings={onOpenWorkspaceSettings}
        onOpenUserSettings={onOpenUserSettings}
        onLogout={onLogout}
      />

      <BranchModal
        open={branchEditor !== null}
        onClose={() => setBranchEditor(null)}
        branch={selectedBranch}
        repo={selectedRepo}
        sessions={selectedBranch ? (sessionsByBranch.get(selectedBranch.branch_id) ?? []) : []}
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
