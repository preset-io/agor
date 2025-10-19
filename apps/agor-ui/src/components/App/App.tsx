import type { AgorClient } from '@agor/core/api';
import type {
  BoardID,
  CreateUserInput,
  MCPServer,
  Repo,
  UpdateUserInput,
  User,
} from '@agor/core/types';
import { Layout } from 'antd';
import { useState } from 'react';
import { usePresence } from '../../hooks/usePresence';
import type { Agent, Board, Session, Task } from '../../types';
import { AppHeader } from '../AppHeader';
import type { ModelConfig } from '../ModelSelector';
import { NewSessionButton } from '../NewSessionButton';
import {
  type NewSessionConfig,
  NewSessionModal,
  type RepoReferenceOption,
} from '../NewSessionModal';
import { SessionCanvas } from '../SessionCanvas';
import SessionDrawer from '../SessionDrawer';
import { SessionListDrawer } from '../SessionListDrawer';
import { SessionSettingsModal } from '../SessionSettingsModal';
import { SettingsModal } from '../SettingsModal';

const { Content } = Layout;

export interface AppProps {
  client: AgorClient | null;
  user?: User | null;
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
  onSendPrompt?: (sessionId: string, prompt: string, permissionMode?: PermissionMode) => void;
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
  const [sessionSettingsId, setSessionSettingsId] = useState<string | null>(null);
  const [currentBoardId, setCurrentBoardId] = useState(initialBoardId || boards[0]?.board_id || '');

  const handleCreateSession = (config: NewSessionConfig) => {
    console.log('Creating session with config:', config, 'for board:', currentBoardId);
    onCreateSession?.(config, currentBoardId);
    setModalOpen(false);
  };

  const handleSessionClick = (sessionId: string) => {
    setSelectedSessionId(sessionId);
  };

  const handleSendPrompt = async (prompt: string, permissionMode?: PermissionMode) => {
    if (selectedSessionId) {
      const session = sessions.find(s => s.session_id === selectedSessionId);
      const agentName = session?.agentic_tool || 'agentic_tool';

      // Show loading state
      console.log(`Sending prompt to ${agentName}...`, {
        sessionId: selectedSessionId,
        prompt,
        permissionMode,
      });

      // Call the prompt endpoint
      // Note: onSendPrompt should be implemented in the parent to call the daemon
      onSendPrompt?.(selectedSessionId, prompt, permissionMode);
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

  const handlePermissionDecision = async (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: 'once' | 'session' | 'project'
  ) => {
    if (!client) return;

    try {
      console.log(
        `📋 Permission decision: ${allow ? 'ALLOW' : 'DENY'} (${scope}) for task ${taskId}`
      );

      // Call the permission decision endpoint
      await client.service(`sessions/${sessionId}/permission-decision`).create({
        requestId,
        taskId,
        allow,
        reason: allow ? 'Approved by user' : 'Denied by user',
        remember: scope !== 'once', // Only remember if not 'once'
        scope,
        decidedBy: user?.user_id || 'anonymous',
      });

      console.log(`✅ Permission decision sent successfully`);
    } catch (error) {
      console.error('❌ Failed to send permission decision:', error);
    }
  };

  const handleUpdateModelConfig = (sessionId: string, modelConfig: ModelConfig) => {
    onUpdateSession?.(sessionId, {
      model_config: {
        ...modelConfig,
        updated_at: new Date().toISOString(),
      },
    });
  };

  const selectedSession = sessions.find(s => s.session_id === selectedSessionId) || null;
  const sessionSettingsSession = sessionSettingsId
    ? sessions.find(s => s.session_id === sessionSettingsId)
    : null;
  const _selectedSessionTasks = selectedSessionId ? tasks[selectedSessionId] || [] : [];
  const currentBoard = boards.find(b => b.board_id === currentBoardId);

  // Filter sessions by current board
  const boardSessions = sessions.filter(session =>
    currentBoard?.sessions.includes(session.session_id)
  );

  // Track active users via cursor presence
  const { activeUsers } = usePresence({
    client,
    boardId: currentBoard?.board_id as BoardID | null,
    users,
    enabled: !!currentBoard && !!client,
  });

  // Include current user in the facepile (always first)
  const allActiveUsers = user
    ? [
        {
          user,
          lastSeen: Date.now(),
          cursor: undefined, // Current user doesn't have a remote cursor
        },
        ...activeUsers,
      ]
    : activeUsers;

  return (
    <Layout style={{ height: '100vh' }}>
      <AppHeader
        user={user}
        activeUsers={allActiveUsers}
        currentUserId={user?.user_id}
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
            setSessionSettingsId(sessionId);
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
        onPermissionDecision={handlePermissionDecision}
        onOpenSettings={sessionId => {
          setSessionSettingsId(sessionId);
        }}
        onUpdateSession={onUpdateSession}
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
        client={client}
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
      {sessionSettingsSession && (
        <SessionSettingsModal
          open={!!sessionSettingsId}
          onClose={() => setSessionSettingsId(null)}
          session={sessionSettingsSession}
          mcpServers={mcpServers}
          sessionMcpServerIds={
            sessionSettingsId ? sessionMcpServerIds[sessionSettingsId] || [] : []
          }
          onUpdate={onUpdateSession}
          onUpdateSessionMcpServers={onUpdateSessionMcpServers}
          onUpdateModelConfig={handleUpdateModelConfig}
        />
      )}
    </Layout>
  );
};
