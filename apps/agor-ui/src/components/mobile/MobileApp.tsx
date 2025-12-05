import type { AgorClient } from '@agor/core/api';
import type { Board, BoardComment, Repo, Session, User, Worktree } from '@agor/core/types';
import { Drawer, Layout, Typography } from 'antd';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { MobileCommentsPage } from './MobileCommentsPage';
import { MobileHeader } from './MobileHeader';
import { MobileNavTree } from './MobileNavTree';
import { SessionPage } from './SessionPage';

const { Content } = Layout;
const { Text } = Typography;

interface MobileAppProps {
  client: AgorClient | null;
  user?: User | null;
  sessionById: Map<string, Session>; // O(1) ID lookups
  sessionsByWorktree: Map<string, Session[]>; // O(1) worktree filtering
  boardById: Map<string, Board>;
  commentById: Map<string, BoardComment>;
  repoById: Map<string, Repo>;
  worktreeById: Map<string, Worktree>;
  userById: Map<string, User>;
  onSendPrompt?: (sessionId: string, prompt: string) => void;
  onSendComment: (boardId: string, content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
  onLogout?: () => void;
  promptDrafts: Map<string, string>;
  onUpdateDraft: (sessionId: string, draft: string) => void;
}

export const MobileApp: React.FC<MobileAppProps> = ({
  client,
  user,
  sessionById,
  sessionsByWorktree,
  boardById,
  commentById,
  repoById,
  worktreeById,
  userById,
  onSendPrompt,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
  onDeleteComment,
  onLogout,
  promptDrafts,
  onUpdateDraft,
}) => {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <Layout style={{ height: '100vh' }}>
      {/* Navigation Drawer - shared across all routes */}
      <Drawer
        title="Navigation"
        placement="left"
        onClose={() => setDrawerOpen(false)}
        open={drawerOpen}
        width="85%"
        styles={{
          body: { padding: 0 },
        }}
      >
        <MobileNavTree
          boardById={boardById}
          worktreeById={worktreeById}
          sessionsByWorktree={sessionsByWorktree}
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
                <img
                  src={`${import.meta.env.BASE_URL}favicon.png`}
                  alt="Agor"
                  style={{
                    width: 160,
                    height: 160,
                    opacity: 0.5,
                    borderRadius: '50%',
                  }}
                />
                <Text type="secondary" style={{ textAlign: 'center' }}>
                  Tap the menu icon to browse boards and sessions
                </Text>
              </Content>
            </>
          }
        />

        {/* Session conversation page */}
        <Route
          path="/session/:sessionId"
          element={
            <SessionPage
              client={client}
              sessionById={sessionById}
              worktreeById={worktreeById}
              repoById={repoById}
              userById={userById}
              currentUser={user}
              onSendPrompt={onSendPrompt}
              onMenuClick={() => setDrawerOpen(true)}
              promptDrafts={promptDrafts}
              onUpdateDraft={onUpdateDraft}
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
              worktreeById={worktreeById}
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
