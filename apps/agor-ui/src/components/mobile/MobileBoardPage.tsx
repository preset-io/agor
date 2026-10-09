import type { AgorClient, Board, Branch, SpawnConfig, User } from '@agor-live/client';
import { Empty, Spin, theme } from 'antd';
import { lazy, Suspense, useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { resolveBoardFromUrlPure } from '@/utils/urlResolution';
import { useTrackBoardVisit } from '../../hooks/useRecentBoards';
import { useStableCallback } from '../../hooks/useStableCallback';
import { agorStore, shallow, useAgorStore, useStoreWithEqualityFn } from '../../store/agorStore';
import {
  makeBranchesForBoardSelector,
  makeBranchSelector,
  makeCommentMentionSelector,
  makeRepoSelector,
  makeUnreadCommentCountSelector,
} from '../../store/selectors';
import { OPEN_BOARD_SWITCHER_EVENT, requestShellPicker } from '../../utils/shellEvents';
import { BoardSwitcher } from '../BoardSwitcher';
import { BoardTeammatePanel, type BoardTeammatePanelTab } from '../BoardTeammatePanel';
import type { BranchModalTab } from '../BranchModal';
import { mobilePageStyle } from './constants';

// React Flow stays out of the shell bundle until a board is opened.
const SessionCanvas = lazy(() => import('../SessionCanvas/SessionCanvas'));

const BOARD_TABS: BoardTeammatePanelTab[] = ['board', 'teammate', 'all-sessions', 'comments'];

/** Route state that opens the board switcher on arrival (Home's "All boards"). */
export interface MobileBoardLocationState {
  openBoardSwitcher?: boolean;
}

interface MobileBoardPageProps {
  client: AgorClient | null;
  currentUser?: User | null;
  boardById: Map<string, Board>;
  branchById: Map<string, Branch>;
  onOpenBranch: (branchId: string, tab: BranchModalTab) => void;
  /** Start a new session on a branch (opens the agent picker). */
  onNewSession: (branchId: string) => void;
  onForkSession: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void;
  onSendComment: (boardId: string, content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
  /**
   * The board's partition is complete (`useBoardPartition`). Until then rows
   * may be missing, so the panel never infers "empty" or "no access".
   */
  boardReady?: boolean;
}

/** Board screen: board switcher, then the desktop board panel tabs led by a view-only canvas. */
export const MobileBoardPage: React.FC<MobileBoardPageProps> = ({
  client,
  currentUser,
  boardById,
  branchById,
  onOpenBranch,
  onNewSession,
  onForkSession,
  onSpawnSession,
  onUpdateBoard,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
  onDeleteComment,
  boardReady = true,
}) => {
  const { boardId = '' } = useParams<{ boardId: string }>();
  const navigate = useNavigate();
  const { state } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { token } = theme.useToken();
  const userId = currentUser?.user_id;
  const resolvedBoardId = boardById.has(boardId)
    ? boardId
    : resolveBoardFromUrlPure(boardId, boardById);
  const board = resolvedBoardId ? boardById.get(resolvedBoardId) : undefined;
  const visitedBoardId = board?.board_id;
  const trackBoardVisit = useTrackBoardVisit(userId);
  useEffect(() => {
    if (visitedBoardId) trackBoardVisit(visitedBoardId);
  }, [visitedBoardId, trackBoardVisit]);

  const openBoardSwitcher = (state as MobileBoardLocationState | null)?.openBoardSwitcher;
  useEffect(() => {
    if (openBoardSwitcher) requestShellPicker(OPEN_BOARD_SWITCHER_EVENT);
  }, [openBoardSwitcher]);

  const tabParam = searchParams.get('tab') as BoardTeammatePanelTab | null;
  const activeTab = tabParam && BOARD_TABS.includes(tabParam) ? tabParam : 'board';
  const setActiveTab = (tab: BoardTeammatePanelTab) =>
    setSearchParams(tab === 'board' ? {} : { tab }, { replace: true });

  const boards = useMemo(() => Array.from(boardById.values()), [boardById]);
  // Shallow-equal like desktop: unrelated socket churn keeps the array, so the canvas stays put.
  const boardBranches = useStoreWithEqualityFn(
    agorStore,
    useMemo(() => makeBranchesForBoardSelector(visitedBoardId), [visitedBoardId]),
    shallow
  );
  const primaryTeammateId = board?.primary_teammate_id ?? null;
  const primaryTeammateBranch = useAgorStore(
    useMemo(() => makeBranchSelector(primaryTeammateId), [primaryTeammateId])
  );
  const primaryTeammateRepoId = primaryTeammateBranch?.repo_id;
  const primaryTeammateRepo = useAgorStore(
    useMemo(() => makeRepoSelector(primaryTeammateRepoId), [primaryTeammateRepoId])
  );
  const unreadCommentsCount = useAgorStore(
    useMemo(() => makeUnreadCommentCountSelector(visitedBoardId), [visitedBoardId])
  );
  const userName = currentUser?.name || currentUser?.email?.split('@')[0] || undefined;
  const hasUserMentions = useAgorStore(
    useMemo(
      () => makeCommentMentionSelector(visitedBoardId, userName, currentUser?.email),
      [visitedBoardId, userName, currentUser?.email]
    )
  );

  const openSession = useStableCallback((sessionId: string) => navigate(`/m/session/${sessionId}`));
  const openBranch = useStableCallback((branchId: string, tab?: BranchModalTab) =>
    onOpenBranch(branchId, tab ?? 'general')
  );
  // Same element across shell re-renders (every session patch), so React skips the canvas subtree.
  const canvas = useMemo(
    () =>
      board ? (
        <Suspense fallback={<Spin style={{ display: 'block', margin: token.marginLG }} />}>
          <SessionCanvas
            readOnly
            height="100%"
            board={board}
            client={client}
            branches={boardBranches}
            primaryTeammateId={primaryTeammateId}
            currentUserId={userId}
            onSessionClick={openSession}
            onOpenBranch={openBranch}
          />
        </Suspense>
      ) : null,
    [board, client, boardBranches, primaryTeammateId, userId, openSession, openBranch, token]
  );

  return (
    <div style={mobilePageStyle}>
      <div
        style={{
          flexShrink: 0,
          paddingInline: token.paddingXXS,
          background: token.colorBgContainer,
          borderBottom: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
        }}
      >
        <BoardSwitcher
          boards={boards}
          currentBoardId={resolvedBoardId}
          onBoardChange={(id) => navigate(`/m/board/${id}`)}
          onHomeClick={() => navigate('/m')}
          branchById={branchById}
          client={client}
          currentUser={currentUser}
          onUpdateBoard={onUpdateBoard}
        />
      </div>
      {board ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <BoardTeammatePanel
            client={client}
            board={board}
            boardTab={canvas}
            showBranchesTab={false}
            touch
            activeTab={activeTab}
            onTabChange={setActiveTab}
            primaryTeammateBranch={primaryTeammateBranch}
            primaryTeammateRepo={primaryTeammateRepo}
            primaryTeammateInaccessible={Boolean(
              primaryTeammateId && !primaryTeammateBranch && boardReady
            )}
            boardReady={boardReady}
            currentUserId={userId}
            unreadCommentsCount={unreadCommentsCount}
            hasUserMentions={hasUserMentions}
            onSessionClick={openSession}
            onCreateSession={onNewSession}
            onForkSession={onForkSession}
            onSpawnSession={onSpawnSession}
            onOpenSettings={openBranch}
            onSendComment={(content) => onSendComment(board.board_id, content)}
            onReplyComment={onReplyComment}
            onResolveComment={onResolveComment}
            onToggleReaction={onToggleReaction}
            onDeleteComment={onDeleteComment}
          />
        </div>
      ) : (
        <Empty description="Board not found" style={{ marginBlock: token.marginXL }} />
      )}
    </div>
  );
};
