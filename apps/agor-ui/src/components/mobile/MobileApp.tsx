import type { AgorClient } from '@agor/core/api';
import type { Board, BoardComment, Repo, Session, Task, User, Worktree } from '@agor/core/types';
import { Drawer, Layout } from 'antd';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { MobileCommentsPage } from './MobileCommentsPage';
import { MobileHeader } from './MobileHeader';
import { MobileNavTree } from './MobileNavTree';
import { SessionPage } from './SessionPage';

const { Content } = Layout;

interface MobileAppProps {
  client: AgorClient | null;
  user?: User | null;
  sessions: Session[];
  tasks: Record<string, Task[]>;
  boards: Board[];
  comments: BoardComment[];
  repos: Repo[];
  worktrees: Worktree[];
  users: User[];
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
  sessions,
  tasks,
  boards,
  comments,
  repos,
  worktrees,
  users,
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
          boards={boards}
          worktrees={worktrees}
          sessions={sessions}
          tasks={tasks}
          comments={comments}
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
                }}
              >
                <div style={{ textAlign: 'center', color: 'rgba(255, 255, 255, 0.45)' }}>
                  <p>Tap the menu icon to browse boards and sessions</p>
                </div>
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
              sessions={sessions}
              worktrees={worktrees}
              repos={repos}
              users={users}
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
              boards={boards}
              comments={comments}
              worktrees={worktrees}
              users={users}
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
