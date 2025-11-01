import type { AgorClient } from '@agor/core/api';
import type { Board, Repo, Session, Task, User, Worktree } from '@agor/core/types';
import { Drawer, Layout } from 'antd';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
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
  repos: Repo[];
  worktrees: Worktree[];
  users: User[];
  onSendPrompt?: (sessionId: string, prompt: string) => void;
  onLogout?: () => void;
}

export const MobileApp: React.FC<MobileAppProps> = ({
  client,
  user,
  sessions,
  tasks,
  boards,
  repos,
  worktrees,
  users,
  onSendPrompt,
  onLogout,
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
            />
          }
        />
      </Routes>
    </Layout>
  );
};
