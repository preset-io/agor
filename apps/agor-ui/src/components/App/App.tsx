import type { AgorClient } from '@agor/core/api';
import type { CreateUserInput, MCPServer, Repo, UpdateUserInput, User } from '@agor/core/types';
import { Layout } from 'antd';
import { useState } from 'react';
import type { Agent, Board, Session, Task } from '../../types';
import { AppHeader } from '../AppHeader';
import { NewSessionButton } from '../NewSessionButton';
import {
  type NewSessionConfig,
  NewSessionModal,
  type RepoReferenceOption,
} from '../NewSessionModal';
import { SessionCanvas } from '../SessionCanvas';
import SessionDrawer from '../SessionDrawer';
import { SessionListDrawer } from '../SessionListDrawer';
import { SettingsModal } from '../SettingsModal';

const { Content } = Layout;

export interface AppProps {
  client: AgorClient | null;
  user?: import('@agor/core/types').User | null;
  sessions: Session[];
  tasks: Record<string, Task[]>;
  availableAgents: Agent[];
  boards: Board[];
  repos: Repo[];
  users: User[]; // All users for multiplayer metadata
  mcpServers: MCPServer[];
  sessionMcpServerIds: Record<string, string[]>; // Map: sessionId -> mcpServerIds[]
  worktreeOptions: RepoReferenceOption[];
  repoOptions: RepoReferenceOption[];
  initialBoardId?: string;
  onCreateSession?: (config: NewSessionConfig, boardId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => void;
  onSpawnSession?: (sessionId: string, prompt: string) => void;
  onSendPrompt?: (sessionId: string, prompt: string) => void;
  onUpdateSession?: (sessionId: string, updates: Partial<Session>) => void;
  onDeleteSession?: (sessionId: string) => void;
  onCreateBoard?: (board: Partial<Board>) => void;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void;
  onDeleteBoard?: (boardId: string) => void;
  onCreateRepo?: (data: { url: string; slug: string }) => void;
  onDeleteRepo?: (repoId: string) => void;
  onDeleteWorktree?: (repoId: string, worktreeName: string) => void;
  onCreateWorktree?: (
    repoId: string,
    data: { name: string; ref: string; createBranch: boolean }
  ) => void;
  onCreateUser?: (data: CreateUserInput) => void;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => void;
  onDeleteUser?: (userId: string) => void;
  onCreateMCPServer?: (data: Partial<MCPServer>) => void;
  onUpdateMCPServer?: (mcpServerId: string, updates: Partial<MCPServer>) => void;
  onDeleteMCPServer?: (mcpServerId: string) => void;
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
  onLogout?: () => void;
}

export const App: React.FC<AppProps> = ({
  client,
  user,
  sessions,
  tasks,
  availableAgents,
  boards,
  repos,
  users,
  mcpServers,
  sessionMcpServerIds,
  worktreeOptions,
  repoOptions,
  initialBoardId,
  onCreateSession,
  onForkSession,
  onSpawnSession,
  onSendPrompt,
  onUpdateSession,
  onDeleteSession,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
  onCreateRepo,
  onDeleteRepo,
  onDeleteWorktree,
  onCreateWorktree,
  onCreateUser,
  onUpdateUser,
  onDeleteUser,
  onCreateMCPServer,
  onUpdateMCPServer,
  onDeleteMCPServer,
  onUpdateSessionMcpServers,
  onLogout,
}) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [listDrawerOpen, setListDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [currentBoardId, setCurrentBoardId] = useState(initialBoardId || boards[0]?.board_id || '');

  const handleCreateSession = (config: NewSessionConfig) => {
    console.log('Creating session with config:', config, 'for board:', currentBoardId);
    onCreateSession?.(config, currentBoardId);
    setModalOpen(false);
  };

  const handleSessionClick = (sessionId: string) => {
    setSelectedSessionId(sessionId);
  };

  const handleSendPrompt = async (prompt: string) => {
    if (selectedSessionId) {
      // Show loading state
      console.log('Sending prompt to Claude...', { sessionId: selectedSessionId, prompt });

      // Call the prompt endpoint
      // Note: onSendPrompt should be implemented in the parent to call the daemon
      onSendPrompt?.(selectedSessionId, prompt);
    }
  };

  const handleFork = (prompt: string) => {
    if (selectedSessionId) {
      onForkSession?.(selectedSessionId, prompt);
    }
  };

  const handleSubtask = (prompt: string) => {
    if (selectedSessionId) {
      onSpawnSession?.(selectedSessionId, prompt);
    }
  };

  const selectedSession = sessions.find(s => s.session_id === selectedSessionId) || null;
  const selectedSessionTasks = selectedSessionId ? tasks[selectedSessionId] || [] : [];
  const currentBoard = boards.find(b => b.board_id === currentBoardId);

  // Filter sessions by current board
  const boardSessions = sessions.filter(session =>
    currentBoard?.sessions.includes(session.session_id)
  );

  return (
    <Layout style={{ height: '100vh' }}>
      <AppHeader
        user={user}
        onMenuClick={() => setListDrawerOpen(true)}
        onSettingsClick={() => setSettingsOpen(true)}
        onLogout={onLogout}
        currentBoardName={currentBoard?.name}
        currentBoardIcon={currentBoard?.icon}
      />
      <Content style={{ position: 'relative', overflow: 'hidden' }}>
        <SessionCanvas
          board={currentBoard || null}
          client={client}
          sessions={boardSessions}
          tasks={tasks}
          users={users}
          currentUserId={user?.user_id}
          mcpServers={mcpServers}
          sessionMcpServerIds={sessionMcpServerIds}
          onSessionClick={handleSessionClick}
          onSessionUpdate={onUpdateSession}
          onSessionDelete={onDeleteSession}
          onUpdateSessionMcpServers={onUpdateSessionMcpServers}
          onOpenSettings={sessionId => {
            console.log('Open settings for session:', sessionId);
            // TODO: Programmatically open SessionCard modal
          }}
        />
        <NewSessionButton onClick={() => setModalOpen(true)} />
      </Content>
      <NewSessionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreate={handleCreateSession}
        availableAgents={availableAgents}
        worktreeOptions={worktreeOptions}
        repoOptions={repoOptions}
        mcpServers={mcpServers}
      />
      <SessionDrawer
        client={client}
        session={selectedSession}
        users={users}
        currentUserId={user?.user_id}
        mcpServers={mcpServers}
        sessionMcpServerIds={selectedSessionId ? sessionMcpServerIds[selectedSessionId] || [] : []}
        open={!!selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
        onSendPrompt={handleSendPrompt}
        onFork={handleFork}
        onSubtask={handleSubtask}
        onOpenSettings={sessionId => {
          console.log('Open settings for session from drawer:', sessionId);
          // TODO: Programmatically trigger SessionCard modal
        }}
      />
      <SessionListDrawer
        open={listDrawerOpen}
        onClose={() => setListDrawerOpen(false)}
        boards={boards}
        currentBoardId={currentBoardId}
        onBoardChange={setCurrentBoardId}
        sessions={sessions}
        onSessionClick={setSelectedSessionId}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        boards={boards}
        repos={repos}
        users={users}
        mcpServers={mcpServers}
        onCreateBoard={onCreateBoard}
        onUpdateBoard={onUpdateBoard}
        onDeleteBoard={onDeleteBoard}
        onCreateRepo={onCreateRepo}
        onDeleteRepo={onDeleteRepo}
        onDeleteWorktree={onDeleteWorktree}
        onCreateWorktree={onCreateWorktree}
        onCreateUser={onCreateUser}
        onUpdateUser={onUpdateUser}
        onDeleteUser={onDeleteUser}
        onCreateMCPServer={onCreateMCPServer}
        onUpdateMCPServer={onUpdateMCPServer}
        onDeleteMCPServer={onDeleteMCPServer}
      />
    </Layout>
  );
};
