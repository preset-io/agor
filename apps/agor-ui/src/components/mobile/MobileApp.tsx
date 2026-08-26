import type {
  AgorClient,
  BranchArchiveOrDeleteOptions,
  Repo,
  UpdateUserInput,
  User,
} from '@agor-live/client';
import { Drawer, Layout } from 'antd';
import { useState } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
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
import { BranchModal, type BranchModalTab } from '../BranchModal';
import type { BranchUpdate } from '../BranchModal/useBranchModalForm';
import { TeammateChatCollectionsModal } from '../TeammateChatCollections';
import { MobileBoardPage } from './MobileBoardPage';
import { MobileCommentsPage } from './MobileCommentsPage';
import { MobileHomePage } from './MobileHomePage';
import { MobileNavTree } from './MobileNavTree';
import { SessionPage } from './SessionPage';

interface MobileAppProps {
  client: AgorClient | null;
  user?: User | null;
  onSendPrompt?: (
    sessionId: string,
    prompt: string
  ) => boolean | undefined | Promise<boolean | undefined>;
  onSendComment: (boardId: string, content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
  onLogout?: () => void;
  onOpenWorkspaceSettings: (section: string) => void;
  onOpenUserSettings: () => void;
  // The branch bottom sheet offers the same edit/archive controls as the
  // desktop modal, so it needs the same handlers behind them — without these
  // the controls render enabled and then do nothing when tapped.
  onUpdateBranch?: (branchId: string, updates: BranchUpdate) => void | Promise<void>;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onArchiveOrDeleteBranch?: (branchId: string, options: BranchArchiveOrDeleteOptions) => void;
  onExecuteScheduleNow?: (branchId: string) => Promise<void>;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => Promise<void>;
}

export const MobileApp: React.FC<MobileAppProps> = ({
  client,
  user,
  onSendPrompt,
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
  onUpdateUser,
}) => {
  const navigate = useNavigate();
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [teammateChatsSessionId, setTeammateChatsSessionId] = useState<string>();
  const [teammateChatsOpen, setTeammateChatsOpen] = useState(false);
  const openTeammateChats = (sessionId?: string) => {
    setTeammateChatsSessionId(sessionId);
    setTeammateChatsOpen(true);
  };
  const closeTeammateChats = () => {
    setTeammateChatsOpen(false);
    setTeammateChatsSessionId(undefined);
  };
  const [branchEditor, setBranchEditor] = useState<{
    branchId: string;
    tab: BranchModalTab;
  } | null>(null);
  const selectedBranch = branchEditor ? (branchById.get(branchEditor.branchId) ?? null) : null;
  const selectedRepo = selectedBranch ? (repoById.get(selectedBranch.repo_id) ?? null) : null;

  return (
    <Layout style={{ height: '100vh' }}>
      {/* Navigation Drawer - shared across all routes */}
      <Drawer
        title="Navigation"
        placement="left"
        onClose={() => setDrawerOpen(false)}
        open={drawerOpen}
        size="85%"
        styles={{
          body: { padding: 0 },
        }}
      >
        <MobileNavTree
          boardById={boardById}
          branchById={branchById}
          sessionsByBranch={sessionsByBranch}
          commentById={commentById}
          onNavigate={() => setDrawerOpen(false)}
          onOpenWorkspaceSettings={onOpenWorkspaceSettings}
          onOpenUserSettings={onOpenUserSettings}
          onLogout={onLogout}
          currentUser={user}
        />
      </Drawer>

      <Routes>
        {/* Home page - just shows header, drawer opened by hamburger */}
        <Route
          path="/"
          element={
            <MobileHomePage
              user={user}
              boardById={boardById}
              branchById={branchById}
              sessionById={sessionById}
              onMenuClick={() => setDrawerOpen(true)}
              onOpenSettings={onOpenWorkspaceSettings}
              onManageTeammateChats={() => openTeammateChats()}
            />
          }
        />

        <Route
          path="/board/:boardId"
          element={
            <MobileBoardPage
              boardById={boardById}
              branchById={branchById}
              repoById={repoById}
              sessionsByBranch={sessionsByBranch}
              boardObjectsByBoardId={boardObjectsByBoardId}
              cardById={cardById}
              artifactById={artifactById}
              onMenuClick={() => setDrawerOpen(true)}
              onOpenBranch={(branchId, tab) => setBranchEditor({ branchId, tab })}
            />
          }
        />

        {/* Session conversation page */}
        <Route
          path="/session/:sessionId"
          element={
            <SessionPage
              client={client}
              sessionById={sessionById}
              branchById={branchById}
              repoById={repoById}
              userById={userById}
              currentUser={user}
              onSendPrompt={onSendPrompt}
              onMenuClick={() => setDrawerOpen(true)}
              onPinToChatCollection={openTeammateChats}
            />
          }
        />

        {/* Comments page */}
        <Route
          path="/comments/:boardId"
          element={
            <MobileCommentsPage
              client={client}
              boardById={boardById}
              commentById={commentById}
              branchById={branchById}
              userById={userById}
              currentUser={user}
              onMenuClick={() => setDrawerOpen(true)}
              onSendComment={onSendComment}
              onReplyComment={onReplyComment}
              onResolveComment={onResolveComment}
              onToggleReaction={onToggleReaction}
              onDeleteComment={onDeleteComment}
            />
          }
        />
      </Routes>
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
          // Sessions live on their own mobile route, so this stays inside /m
          // rather than reusing the desktop board-switching navigation.
          setBranchEditor(null);
          navigate(`/m/session/${sessionId}`);
        }}
        onOpenSettings={() => {
          setBranchEditor(null);
          onOpenWorkspaceSettings('repos');
        }}
      />
      <TeammateChatCollectionsModal
        open={teammateChatsOpen}
        currentUser={user}
        preselectedSessionId={teammateChatsSessionId}
        onClose={closeTeammateChats}
        onUpdateUser={onUpdateUser}
      />
    </Layout>
  );
};
