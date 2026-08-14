import type { AgorClient, User } from '@agor-live/client';
import { Drawer, Layout, Typography } from 'antd';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
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
import { BrandMark } from '../BrandMark';
import { MobileBoardPage } from './MobileBoardPage';
import { MobileCommentsPage } from './MobileCommentsPage';
import { MobileHeader } from './MobileHeader';
import { MobileNavTree } from './MobileNavTree';
import { SessionPage } from './SessionPage';

const { Content } = Layout;
const { Text } = Typography;

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
}) => {
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
        />
      </Drawer>

      <Routes>
        {/* Home page - just shows header, drawer opened by hamburger */}
        <Route
          path="/"
          element={
            <>
              <MobileHeader
                showLogo
                user={user}
                onMenuClick={() => setDrawerOpen(true)}
                onLogout={onLogout}
              />
              <Content
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 24,
                  flexDirection: 'column',
                  gap: 24,
                }}
              >
                <BrandMark size={160} style={{ opacity: 0.5 }} />
                <Text type="secondary" style={{ textAlign: 'center' }}>
                  Tap the menu icon to browse boards and sessions
                </Text>
              </Content>
            </>
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
    </Layout>
  );
};
