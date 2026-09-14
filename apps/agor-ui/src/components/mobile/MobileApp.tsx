import type {
  AgorClient,
  Branch,
  BranchArchiveOrDeleteOptions,
  Repo,
  Session,
  SpawnConfig,
  User,
} from '@agor-live/client';
import { DEFAULT_AGENTIC_TOOL_NAME, getTeammateConfig } from '@agor-live/client';
import { Alert, Button, Drawer, Layout, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useConnectionState } from '../../contexts/ConnectionContext';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
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
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { resolveAvailableUserAgenticTool } from '../AgentSelectionGrid/availableAgents';
import { BranchModal, type BranchModalTab } from '../BranchModal';
import type { BranchUpdate } from '../BranchModal/useBranchModalForm';
import { PrimaryTeammatePicker } from '../SettingsModal/PrimaryTeammatePicker';
import { resolveAskPrimaryTarget } from './askPrimary';
import { MobileBoardPage } from './MobileBoardPage';
import { MobileCommentsPage } from './MobileCommentsPage';
import { MobileMoreSheet } from './MobileMoreSheet';
import { MobileSessionsPage } from './MobileSessionsPage';
import { type MobileTab, MobileTabBar } from './MobileTabBar';
import { SessionPage } from './SessionPage';

interface MobileAppProps {
  client: AgorClient | null;
  user?: User | null;
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
  onUpdateBranch,
  onUpdateRepo,
  onArchiveOrDeleteBranch,
  onExecuteScheduleNow,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { connected, connecting } = useConnectionState();
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
  // swallows `/m/sessions` (the Sessions tab).
  const isSessionRoute = location.pathname.startsWith('/m/session/');
  const activeTab: MobileTab | null = location.pathname.startsWith('/m/board')
    ? 'board'
    : location.pathname.startsWith('/m/comments')
      ? 'comments'
      : isSessionRoute
        ? null
        : 'sessions';

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

  // Continue the branch's live session, else start a fresh one, and land in the
  // full-screen composer.
  const startPrimarySession = useCallback(
    async (branch: Branch) => {
      const target = resolveAskPrimaryTarget(branch, sessionsByBranch.get(branch.branch_id) ?? []);
      if (target.kind === 'continue') {
        navigate(`/m/session/${target.sessionId}`);
        return;
      }
      if (target.kind !== 'create') return; // a real branch never resolves to 'pick'
      const agent = resolveAvailableUserAgenticTool(user, agenticToolSettings, AVAILABLE_AGENTS);
      const result = await onCreateSession(
        {
          branch_id: target.branchId,
          agent: agent ?? DEFAULT_AGENTIC_TOOL_NAME,
          initialPrompt: '',
        },
        target.boardId
      );
      if (result?.sessionId) navigate(`/m/session/${result.sessionId}`);
    },
    [sessionsByBranch, navigate, user, agenticToolSettings, onCreateSession]
  );

  // Create a session on any branch with a chosen agent, then open its composer.
  const createSessionOnBranch = useCallback(
    async (branchId: string, agent: string) => {
      const boardId = branchById.get(branchId)?.board_id ?? '';
      setNewSessionBranchId(null);
      const result = await onCreateSession(
        { branch_id: branchId, agent, initialPrompt: '' },
        boardId
      );
      if (result?.sessionId) navigate(`/m/session/${result.sessionId}`);
    },
    [branchById, onCreateSession, navigate]
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
        case 'board':
          if (effectiveBoardId) navigate(`/m/board/${effectiveBoardId}`);
          else setMoreOpen(true);
          break;
        case 'sessions':
          navigate('/m/sessions');
          break;
        case 'ask':
          void askPrimaryAssistant();
          break;
        case 'comments':
          if (effectiveBoardId) navigate(`/m/comments/${effectiveBoardId}`);
          else setMoreOpen(true);
          break;
        case 'more':
          setMoreOpen(true);
          break;
      }
    },
    [effectiveBoardId, navigate, askPrimaryAssistant]
  );

  return (
    <Layout style={{ height: '100dvh' }}>
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
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Descendant routes under `/m/*`; paths are RELATIVE to /m. */}
        <Routes>
          <Route index element={<Navigate to="/m/sessions" replace />} />
          <Route
            path="sessions"
            element={
              <MobileSessionsPage
                sessionById={sessionById}
                branchById={branchById}
                currentUser={user}
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

      {!isSessionRoute && (
        <MobileTabBar
          activeTab={activeTab}
          onSelect={handleTabSelect}
          askEmoji={primaryBranch ? getTeammateConfig(primaryBranch)?.emoji : undefined}
          sessionsBadge={sessionsBadge}
          commentsBadge={commentsBadge}
        />
      )}

      <Drawer
        open={askPickerOpen}
        onClose={() => setAskPickerOpen(false)}
        placement="bottom"
        height="auto"
        title="Choose your primary assistant"
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
