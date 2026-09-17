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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { AppActionsContextValue } from '../../contexts/AppActionsContext';
import { useConnectionState } from '../../contexts/ConnectionContext';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { useAgorStore } from '../../store/agorStore';
import {
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
import { getSessionStatusTone } from '../../utils/sessionStatus';
import { buildNewSessionConfig } from '../AgenticToolConfigurationPicker/newSessionConfig';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { resolveAvailableUserAgenticTool } from '../AgentSelectionGrid/availableAgents';
import { BranchModal, type BranchModalTab } from '../BranchModal';
import type { BranchUpdate } from '../BranchModal/useBranchModalForm';
import { PrimaryTeammatePicker } from '../SettingsModal/PrimaryTeammatePicker';
import { resolveAskPrimaryTarget } from './askPrimary';
import { MobileBoardPage } from './MobileBoardPage';
import { MobileCommentsPage } from './MobileCommentsPage';
import { MobileHomePage } from './MobileHomePage';
import { MobileMarketplacePage } from './MobileMarketplacePage';
import { MobileMoreSheet } from './MobileMoreSheet';
import { MobileSearchPage } from './MobileSearchPage';
import { MobileSessionsPage } from './MobileSessionsPage';
import { type MobileTab, MobileTabBar } from './MobileTabBar';
import { SessionPage } from './SessionPage';

interface MobileAppProps {
  client: AgorClient | null;
  user?: User | null;
  /** Authentication generation, forwarded to the reused Marketplace catalog. */
  authGeneration: number;
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
  topBanner,
  onSendPrompt,
  onCreateSession,
  onForkSession,
  onBtwForkSession,
  onSpawnSession,
  onUpdateSession,
  onDeleteSession,
  onUpdateSessionMcpServers,
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
  const [primaryBranch, setPrimaryBranch] = useState<Branch | null>(null);
  const [branchEditor, setBranchEditor] = useState<{
    branchId: string;
    tab: BranchModalTab;
  } | null>(null);
  const selectedBranch = branchEditor ? (branchById.get(branchEditor.branchId) ?? null) : null;
  const selectedRepo = selectedBranch ? (repoById.get(selectedBranch.repo_id) ?? null) : null;

  // Resolve the caller's primary assistant so the center Ask action can show its
  // emoji and continue/start its session. Re-resolves when the caller changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: caller change deliberately re-resolves the caller-scoped primary teammate
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .service('users')
      .getPrimaryTeammate()
      .then((branch) => {
        if (!cancelled) setPrimaryBranch(branch);
      })
      .catch(() => {
        if (!cancelled) setPrimaryBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, user?.user_id]);

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
    const userId = user?.user_id;
    let count = 0;
    for (const session of sessionById.values()) {
      if (session.archived) continue;
      if (userId && session.created_by !== userId) continue;
      if (getSessionStatusTone(session.status) === 'processing') count++;
    }
    return count;
  }, [sessionById, user?.user_id]);

  const commentsBadge = useMemo(() => {
    if (!effectiveBoardId) return 0;
    let count = 0;
    for (const comment of commentById.values()) {
      if (comment.board_id === effectiveBoardId && !comment.resolved && !comment.parent_comment_id)
        count++;
    }
    return count;
  }, [commentById, effectiveBoardId]);

  // Always start a FRESH session on the primary branch and land in the
  // full-screen composer; every Ask tap creates a new one (never continues).
  const startPrimarySession = useCallback(
    async (branch: Branch) => {
      const target = resolveAskPrimaryTarget(branch);
      if (target.kind !== 'create') return; // a real branch never resolves to 'pick'
      const tool = resolveAvailableUserAgenticTool(user, agenticToolSettings, AVAILABLE_AGENTS);
      const result = await onCreateSession(
        buildNewSessionConfig({ user, tool, branch, initialPrompt: '' }),
        target.boardId
      );
      if (result?.sessionId) navigate(`/m/session/${result.sessionId}`);
    },
    [navigate, user, agenticToolSettings, onCreateSession]
  );

  // Create a session on any branch with a chosen agent, then open its composer.
  const createSessionOnBranch = useCallback(
    async (branchId: string, agent: string) => {
      const branch = branchById.get(branchId);
      setNewSessionBranchId(null);
      const result = await onCreateSession(
        buildNewSessionConfig({
          user,
          tool: agent as AgenticToolName,
          branch: branch ?? { branch_id: branchId },
          initialPrompt: '',
        }),
        branch?.board_id ?? ''
      );
      if (result?.sessionId) navigate(`/m/session/${result.sessionId}`);
    },
    [branchById, onCreateSession, navigate, user]
  );

  const askPrimaryAssistant = useCallback(async () => {
    if (!client) return;
    let branch = primaryBranch;
    if (!branch) {
      try {
        branch = await client.service('users').getPrimaryTeammate();
        if (branch) setPrimaryBranch(branch);
      } catch {
        branch = null;
      }
    }
    // No primary (or a transient resolve failure): open the mobile-native
    // picker — never fall through to the desktop Settings modal.
    if (!branch) {
      setAskPickerOpen(true);
      return;
    }
    await startPrimarySession(branch);
  }, [client, primaryBranch, startPrimarySession]);

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
                primaryTeammateName={
                  primaryBranch ? getTeammateConfig(primaryBranch)?.displayName : undefined
                }
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
                primaryTeammateName={
                  primaryBranch ? getTeammateConfig(primaryBranch)?.displayName : undefined
                }
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
                firstTaskAssistantName={
                  primaryBranch ? getTeammateConfig(primaryBranch)?.displayName : undefined
                }
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
                onBack={() => (location.key !== 'default' ? navigate(-1) : navigate('/m'))}
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
          client={client}
          currentUserId={user?.user_id}
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
            if (newSessionBranchId) void createSessionOnBranch(newSessionBranchId, agent);
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
        currentUser={user}
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
