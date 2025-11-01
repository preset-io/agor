import type { AgorClient } from '@agor/core/api';
import type { Board, Repo, Session, Task, User, Worktree } from '@agor/core/types';
import { Layout } from 'antd';
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
  return (
    <Layout style={{ height: '100vh' }}>
      <Routes>
        {/* Navigation tree page */}
        <Route
          path="/"
          element={
            <>
              <MobileHeader title="Agor" user={user} onLogout={onLogout} />
              <Content style={{ overflowY: 'auto' }}>
                <MobileNavTree
                  boards={boards}
                  worktrees={worktrees}
                  sessions={sessions}
                  tasks={tasks}
                />
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
            />
          }
        />
      </Routes>
    </Layout>
  );
};
