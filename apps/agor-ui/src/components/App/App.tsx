import type { AgorClient } from '@agor/core/api';
import type {
  Board,
  BoardEntityObject,
  BoardID,
  CreateUserInput,
  MCPServer,
  PermissionMode,
  Repo,
  Session,
  Task,
  UpdateUserInput,
  User,
  Worktree,
} from '@agor/core/types';
import { PermissionScope } from '@agor/core/types';
import { Layout } from 'antd';
import { useEffect, useState } from 'react';
import { usePresence } from '../../hooks/usePresence';
import { AppHeader } from '../AppHeader';
import type { ModelConfig } from '../ModelSelector';

// UI-only type for agent selection dropdown (different from AgenticTool which has UUIDv7 ID)
interface AgenticToolOption {
  id: string; // AgenticToolName as string
  name: string;
  icon: string;
  installed: boolean;
  installable?: boolean;
  version?: string;
  description?: string;
}

import { CommentsPanel } from '../CommentsPanel';
import { NewSessionButton } from '../NewSessionButton';
import { type NewSessionConfig, NewSessionModal } from '../NewSessionModal';
import { type NewWorktreeConfig, NewWorktreeModal } from '../NewWorktreeModal';
import { SessionCanvas } from '../SessionCanvas';
import SessionDrawer from '../SessionDrawer';
import { SessionSettingsModal } from '../SessionSettingsModal';
import { SettingsModal } from '../SettingsModal';
import { TerminalModal } from '../TerminalModal';
import { WorktreeListDrawer } from '../WorktreeListDrawer';
import { WorktreeModal } from '../WorktreeModal';

const { Content } = Layout;

export interface AppProps {
  client: AgorClient | null;
  user?: User | null;
  sessions: Session[];
  tasks: Record<string, Task[]>;
  availableAgents: AgenticToolOption[];
  boards: Board[];
  boardObjects: BoardEntityObject[]; // Positioned worktrees on boards
  comments: import('@agor/core/types').BoardComment[]; // Board comments for collaboration
  repos: Repo[];
  worktrees: Worktree[];
  users: User[]; // All users for multiplayer metadata
  mcpServers: MCPServer[];
  sessionMcpServerIds: Record<string, string[]>; // Map: sessionId -> mcpServerIds[]
  initialBoardId?: string;
  openSettingsTab?: string | null; // Open settings modal to a specific tab
  onSettingsClose?: () => void; // Called when settings modal closes
  openNewWorktreeModal?: boolean; // Open new worktree modal
  onNewWorktreeModalClose?: () => void; // Called when new worktree modal closes
  onCreateSession?: (config: NewSessionConfig, boardId: string) => Promise<string | null>;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSendPrompt?: (sessionId: string, prompt: string, permissionMode?: PermissionMode) => void;
  onUpdateSession?: (sessionId: string, updates: Partial<Session>) => void;
  onDeleteSession?: (sessionId: string) => void;
  onCreateBoard?: (board: Partial<Board>) => void;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void;
  onDeleteBoard?: (boardId: string) => void;
  onCreateRepo?: (data: { url: string; slug: string; default_branch: string }) => void;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onDeleteRepo?: (repoId: string) => void;
  onDeleteWorktree?: (worktreeId: string, deleteFromFilesystem: boolean) => void;
  onUpdateWorktree?: (worktreeId: string, updates: Partial<Worktree>) => void;
  onCreateWorktree?: (
    repoId: string,
    data: {
      name: string;
      ref: string;
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      issue_url?: string;
      pull_request_url?: string;
    }
  ) => Promise<Worktree | null>;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onCreateUser?: (data: CreateUserInput) => void;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => void;
  onDeleteUser?: (userId: string) => void;
  onCreateMCPServer?: (data: Partial<MCPServer>) => void;
  onUpdateMCPServer?: (mcpServerId: string, updates: Partial<MCPServer>) => void;
  onDeleteMCPServer?: (mcpServerId: string) => void;
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
  onSendComment?: (boardId: string, content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
  onLogout?: () => void;
}

export const App: React.FC<AppProps> = ({
  client,
  user,
  sessions,
  tasks,
  availableAgents,
  boards,
  boardObjects,
  comments,
  repos,
  worktrees,
  users,
  mcpServers,
  sessionMcpServerIds,
  initialBoardId,
  openSettingsTab,
  onSettingsClose,
  openNewWorktreeModal,
  onNewWorktreeModalClose,
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
  onUpdateRepo,
  onDeleteRepo,
  onDeleteWorktree,
  onUpdateWorktree,
  onCreateWorktree,
  onStartEnvironment,
  onStopEnvironment,
  onCreateUser,
  onUpdateUser,
  onDeleteUser,
  onCreateMCPServer,
  onUpdateMCPServer,
  onDeleteMCPServer,
  onUpdateSessionMcpServers,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
  onDeleteComment,
  onLogout,
}) => {
  const [newSessionWorktreeId, setNewSessionWorktreeId] = useState<string | null>(null);
  const [newWorktreeModalOpen, setNewWorktreeModalOpen] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [listDrawerOpen, setListDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsActiveTab, setSettingsActiveTab] = useState<string>('boards');

  // Handle external settings tab control (e.g., from welcome modal)
  const effectiveSettingsOpen = settingsOpen || !!openSettingsTab;
  const effectiveSettingsTab = openSettingsTab || settingsActiveTab;

  // Handle external new worktree modal control (e.g., from welcome modal)
  const effectiveNewWorktreeModalOpen = newWorktreeModalOpen || !!openNewWorktreeModal;

  // Initialize comments panel state from localStorage (collapsed by default)
  const [commentsPanelCollapsed, setCommentsPanelCollapsed] = useState(() => {
    const stored = localStorage.getItem('agor:commentsPanelCollapsed');
    return stored ? stored === 'true' : true; // Default to collapsed (hidden)
  });

  // Comment highlight state (hover and sticky selection)
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);

  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalCommands, setTerminalCommands] = useState<string[]>([]);
  const [sessionSettingsId, setSessionSettingsId] = useState<string | null>(null);
  const [worktreeModalWorktreeId, setWorktreeModalWorktreeId] = useState<string | null>(null);

  // Initialize current board from localStorage or fallback to first board or initialBoardId
  const [currentBoardId, setCurrentBoardId] = useState(() => {
    const stored = localStorage.getItem('agor:currentBoardId');
    if (stored && boards.some(b => b.board_id === stored)) {
      return stored;
    }
    return initialBoardId || boards[0]?.board_id || '';
  });

  // Persist current board to localStorage when it changes
  useEffect(() => {
    if (currentBoardId) {
      localStorage.setItem('agor:currentBoardId', currentBoardId);
    }
  }, [currentBoardId]);

  // Persist comments panel collapsed state to localStorage
  useEffect(() => {
    localStorage.setItem('agor:commentsPanelCollapsed', String(commentsPanelCollapsed));
  }, [commentsPanelCollapsed]);

  // If the stored board no longer exists (e.g., deleted), fallback to first board
  useEffect(() => {
    if (currentBoardId && !boards.some(b => b.board_id === currentBoardId)) {
      const fallback = boards[0]?.board_id || '';
      setCurrentBoardId(fallback);
    }
  }, [boards, currentBoardId]);

  const handleOpenTerminal = (commands: string[] = []) => {
    setTerminalCommands(commands);
    setTerminalOpen(true);
  };

  const handleCloseTerminal = () => {
    setTerminalOpen(false);
    setTerminalCommands([]);
  };

  const handleCreateSession = async (config: NewSessionConfig) => {
    console.log('Creating session with config:', config, 'for board:', currentBoardId);
    const sessionId = await onCreateSession?.(config, currentBoardId);
    setNewSessionWorktreeId(null);

    // If session was created successfully, open the drawer to show it
    if (sessionId) {
      setSelectedSessionId(sessionId);
    }
  };

  const handleCreateWorktree = async (config: NewWorktreeConfig) => {
    const worktree = await onCreateWorktree?.(config.repoId, {
      name: config.name,
      ref: config.ref,
      createBranch: config.createBranch,
      sourceBranch: config.sourceBranch,
      pullLatest: config.pullLatest,
      issue_url: config.issue_url,
      pull_request_url: config.pull_request_url,
    });

    // If board_id is provided and worktree was created, assign it to the board
    if (worktree && config.board_id) {
      await onUpdateWorktree?.(worktree.worktree_id, {
        board_id: config.board_id as import('@agor/core/types').BoardID,
      });
    }

    setNewWorktreeModalOpen(false);
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

  const handleSubsession = (prompt: string) => {
    if (selectedSessionId) {
      onSpawnSession?.(selectedSessionId, prompt);
    }
  };

  const handlePermissionDecision = async (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
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
        remember: scope !== PermissionScope.ONCE, // Only remember if not 'once'
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
  const selectedSessionWorktree = selectedSession
    ? worktrees.find(w => w.worktree_id === selectedSession.worktree_id)
    : null;
  const sessionSettingsSession = sessionSettingsId
    ? sessions.find(s => s.session_id === sessionSettingsId)
    : null;
  const _selectedSessionTasks = selectedSessionId ? tasks[selectedSessionId] || [] : [];
  const currentBoard = boards.find(b => b.board_id === currentBoardId);

  // Find worktree and repo for WorktreeModal
  const selectedWorktree = worktreeModalWorktreeId
    ? worktrees.find(w => w.worktree_id === worktreeModalWorktreeId)
    : null;
  const selectedWorktreeRepo = selectedWorktree
    ? repos.find(r => r.repo_id === selectedWorktree.repo_id)
    : null;
  const worktreeSessions = selectedWorktree
    ? sessions.filter(s => s.worktree_id === selectedWorktree.worktree_id)
    : [];

  // Find worktree for NewSessionModal
  const newSessionWorktree = newSessionWorktreeId
    ? worktrees.find(w => w.worktree_id === newSessionWorktreeId)
    : null;

  // Filter worktrees by current board (via board_objects)
  const boardWorktreeIds = boardObjects
    .filter(bo => bo.board_id === currentBoard?.board_id)
    .map(bo => bo.worktree_id);

  const boardWorktrees = worktrees.filter(wt => boardWorktreeIds.includes(wt.worktree_id));

  // Filter sessions by current board's worktrees
  const boardSessions = sessions.filter(session => boardWorktreeIds.includes(session.worktree_id));

  // Track active users via cursor presence
  const { activeUsers } = usePresence({
    client,
    boardId: currentBoard?.board_id as BoardID | null,
    users,
    enabled: !!currentBoard && !!client,
  });

  // Include current user in the facepile (always first)
  // Filter out current user from activeUsers to avoid duplication
  const allActiveUsers = user
    ? [
        {
          user,
          lastSeen: Date.now(),
          cursor: undefined, // Current user doesn't have a remote cursor
        },
        ...activeUsers.filter(activeUser => activeUser.user.user_id !== user.user_id),
      ]
    : activeUsers;

  return (
    <Layout style={{ height: '100vh' }}>
      <AppHeader
        user={user}
        activeUsers={allActiveUsers}
        currentUserId={user?.user_id}
        onMenuClick={() => setListDrawerOpen(true)}
        onCommentsClick={() => setCommentsPanelCollapsed(!commentsPanelCollapsed)}
        onSettingsClick={() => setSettingsOpen(true)}
        onTerminalClick={() => handleOpenTerminal()}
        onLogout={onLogout}
        currentBoardName={currentBoard?.name}
        currentBoardIcon={currentBoard?.icon}
        unreadCommentsCount={
          comments.filter(c => c.board_id === currentBoardId && !c.resolved && !c.parent_comment_id)
            .length
        }
      />
      <Content style={{ position: 'relative', overflow: 'hidden', display: 'flex' }}>
        <CommentsPanel
          client={client}
          boardId={currentBoardId || ''}
          comments={comments.filter(c => c.board_id === currentBoardId)}
          users={users}
          currentUserId={user?.user_id || 'anonymous'}
          boardObjects={currentBoard?.objects}
          worktrees={boardWorktrees}
          collapsed={commentsPanelCollapsed}
          onToggleCollapse={() => setCommentsPanelCollapsed(!commentsPanelCollapsed)}
          onSendComment={content => onSendComment?.(currentBoardId || '', content)}
          onReplyComment={onReplyComment}
          onResolveComment={onResolveComment}
          onToggleReaction={onToggleReaction}
          onDeleteComment={onDeleteComment}
          hoveredCommentId={hoveredCommentId}
          selectedCommentId={selectedCommentId}
        />
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <SessionCanvas
            board={currentBoard || null}
            client={client}
            sessions={boardSessions}
            tasks={tasks}
            users={users}
            worktrees={boardWorktrees}
            boardObjects={boardObjects}
            comments={comments}
            currentUserId={user?.user_id}
            availableAgents={availableAgents}
            mcpServers={mcpServers}
            sessionMcpServerIds={sessionMcpServerIds}
            onSessionClick={handleSessionClick}
            onSessionUpdate={onUpdateSession}
            onSessionDelete={onDeleteSession}
            onForkSession={onForkSession}
            onSpawnSession={onSpawnSession}
            onUpdateSessionMcpServers={onUpdateSessionMcpServers}
            onOpenSettings={sessionId => {
              setSessionSettingsId(sessionId);
            }}
            onCreateSessionForWorktree={worktreeId => {
              setNewSessionWorktreeId(worktreeId);
            }}
            onOpenWorktree={worktreeId => {
              setWorktreeModalWorktreeId(worktreeId);
            }}
            onDeleteWorktree={onDeleteWorktree}
            onOpenTerminal={handleOpenTerminal}
            onOpenCommentsPanel={() => setCommentsPanelCollapsed(false)}
            onCommentHover={setHoveredCommentId}
            onCommentSelect={commentId => {
              // Toggle selection: if clicking same comment, deselect
              setSelectedCommentId(prev => (prev === commentId ? null : commentId));
            }}
          />
          <NewSessionButton onClick={() => setNewWorktreeModalOpen(true)} />
        </div>
      </Content>
      {newSessionWorktreeId && (
        <NewSessionModal
          open={true}
          onClose={() => setNewSessionWorktreeId(null)}
          onCreate={handleCreateSession}
          availableAgents={availableAgents}
          worktreeId={newSessionWorktreeId}
          worktree={newSessionWorktree || undefined}
          mcpServers={mcpServers}
        />
      )}
      <SessionDrawer
        client={client}
        session={selectedSession}
        worktree={selectedSessionWorktree}
        users={users}
        currentUserId={user?.user_id}
        repos={repos}
        worktrees={worktrees}
        mcpServers={mcpServers}
        sessionMcpServerIds={selectedSessionId ? sessionMcpServerIds[selectedSessionId] || [] : []}
        open={!!selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
        onSendPrompt={handleSendPrompt}
        onFork={handleFork}
        onSubsession={handleSubsession}
        onPermissionDecision={handlePermissionDecision}
        onOpenSettings={sessionId => {
          setSessionSettingsId(sessionId);
        }}
        onOpenWorktree={worktreeId => {
          setWorktreeModalWorktreeId(worktreeId);
        }}
        onOpenTerminal={handleOpenTerminal}
        onUpdateSession={onUpdateSession}
        onDelete={onDeleteSession}
        onStartEnvironment={onStartEnvironment}
        onStopEnvironment={onStopEnvironment}
      />
      <SettingsModal
        open={effectiveSettingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          onSettingsClose?.();
        }}
        client={client}
        currentUser={user}
        boards={boards}
        boardObjects={boardObjects}
        repos={repos}
        worktrees={worktrees}
        sessions={sessions}
        users={users}
        mcpServers={mcpServers}
        activeTab={effectiveSettingsTab}
        onTabChange={newTab => {
          setSettingsActiveTab(newTab);
          // Clear openSettingsTab when user manually changes tabs
          // This allows normal tab switching after opening from onboarding
          if (openSettingsTab) {
            onSettingsClose?.();
          }
        }}
        onCreateBoard={onCreateBoard}
        onUpdateBoard={onUpdateBoard}
        onDeleteBoard={onDeleteBoard}
        onCreateRepo={onCreateRepo}
        onUpdateRepo={onUpdateRepo}
        onDeleteRepo={onDeleteRepo}
        onDeleteWorktree={onDeleteWorktree}
        onUpdateWorktree={onUpdateWorktree}
        onCreateWorktree={onCreateWorktree}
        onStartEnvironment={onStartEnvironment}
        onStopEnvironment={onStopEnvironment}
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
      <WorktreeModal
        open={!!worktreeModalWorktreeId}
        onClose={() => setWorktreeModalWorktreeId(null)}
        worktree={selectedWorktree || null}
        repo={selectedWorktreeRepo || null}
        sessions={worktreeSessions}
        client={client}
        onUpdateWorktree={onUpdateWorktree}
        onUpdateRepo={onUpdateRepo}
        onDelete={onDeleteWorktree}
        onOpenSettings={() => {
          setWorktreeModalWorktreeId(null);
          setSettingsOpen(true);
        }}
      />
      <WorktreeListDrawer
        open={listDrawerOpen}
        onClose={() => setListDrawerOpen(false)}
        boards={boards}
        currentBoardId={currentBoardId}
        onBoardChange={setCurrentBoardId}
        sessions={sessions}
        worktrees={worktrees}
        onSessionClick={setSelectedSessionId}
      />
      <TerminalModal
        open={terminalOpen}
        onClose={handleCloseTerminal}
        client={client}
        initialCommands={terminalCommands}
      />
      <NewWorktreeModal
        open={effectiveNewWorktreeModalOpen}
        onClose={() => {
          setNewWorktreeModalOpen(false);
          onNewWorktreeModalClose?.();
        }}
        onCreate={handleCreateWorktree}
        repos={repos}
        currentBoardId={currentBoardId}
      />
    </Layout>
  );
};
