import type { AgorClient } from '@agor/core/api';
import type {
  Board,
  BoardComment,
  BoardEntityObject,
  BoardID,
  CreateUserInput,
  MCPServer,
  PermissionMode,
  Repo,
  Session,
  SpawnConfig,
  Task,
  UpdateUserInput,
  User,
  Worktree,
} from '@agor/core/types';
import { PermissionScope } from '@agor/core/types';
import { Layout } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useEventStream } from '../../hooks/useEventStream';
import { useFaviconStatus } from '../../hooks/useFaviconStatus';
import { usePresence } from '../../hooks/usePresence';
import type { AgenticToolOption } from '../../types';
import { useThemedMessage } from '../../utils/message';
import { AppHeader } from '../AppHeader';
import { CommentsPanel } from '../CommentsPanel';
import { EnvironmentLogsModal } from '../EnvironmentLogsModal';
import { EventStreamPanel } from '../EventStreamPanel';
import { NewSessionButton } from '../NewSessionButton';
import { type NewSessionConfig, NewSessionModal } from '../NewSessionModal';
import { type NewWorktreeConfig, NewWorktreeModal } from '../NewWorktreeModal';
import { SessionCanvas } from '../SessionCanvas';
import SessionDrawer from '../SessionDrawer';
import { SessionSettingsModal } from '../SessionSettingsModal';
import { SettingsModal } from '../SettingsModal';
import { TerminalModal } from '../TerminalModal';
import { ThemeEditorModal } from '../ThemeEditorModal';
import { WorktreeListDrawer } from '../WorktreeListDrawer';
import { WorktreeModal } from '../WorktreeModal';
import type { WorktreeUpdate } from '../WorktreeModal/tabs/GeneralTab';

const { Content } = Layout;

export interface AppProps {
  client: AgorClient | null;
  user?: User | null;
  connected?: boolean;
  connecting?: boolean;
  sessions: Session[];
  tasks: Record<string, Task[]>;
  availableAgents: AgenticToolOption[];
  boards: Board[];
  boardObjects: BoardEntityObject[]; // Positioned worktrees on boards
  comments: BoardComment[]; // Board comments for collaboration
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
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onSendPrompt?: (sessionId: string, prompt: string, permissionMode?: PermissionMode) => void;
  onUpdateSession?: (sessionId: string, updates: Partial<Session>) => void;
  onDeleteSession?: (sessionId: string) => void;
  onCreateBoard?: (board: Partial<Board>) => void;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void;
  onDeleteBoard?: (boardId: string) => void;
  onCreateRepo?: (data: { url: string; slug: string; default_branch: string }) => void;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onDeleteRepo?: (repoId: string) => void;
  onArchiveOrDeleteWorktree?: (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onUnarchiveWorktree?: (worktreeId: string, options?: { boardId?: string }) => void;
  onUpdateWorktree?: (worktreeId: string, updates: WorktreeUpdate) => void;
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
  onRetryConnection?: () => void;
}

export const App: React.FC<AppProps> = ({
  client,
  user,
  connected = false,
  connecting = false,
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
  onArchiveOrDeleteWorktree,
  onUnarchiveWorktree,
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
  onRetryConnection,
}) => {
  const { showWarning } = useThemedMessage();
  const [newSessionWorktreeId, setNewSessionWorktreeId] = useState<string | null>(null);
  const [newWorktreeModalOpen, setNewWorktreeModalOpen] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [listDrawerOpen, setListDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsActiveTab, setSettingsActiveTab] = useState<string>('boards');
  const [settingsEditUserId, setSettingsEditUserId] = useState<string | undefined>(undefined);

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
  const [terminalWorktreeId, setTerminalWorktreeId] = useState<string | undefined>(undefined);
  const [sessionSettingsId, setSessionSettingsId] = useState<string | null>(null);
  const [worktreeModalWorktreeId, setWorktreeModalWorktreeId] = useState<string | null>(null);
  const [logsModalWorktreeId, setLogsModalWorktreeId] = useState<string | null>(null);
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);

  // Initialize event stream panel state from localStorage (collapsed by default)
  const [eventStreamPanelCollapsed, setEventStreamPanelCollapsed] = useState(() => {
    const stored = localStorage.getItem('agor:eventStreamPanelCollapsed');
    return stored ? stored === 'true' : true; // Default to collapsed (hidden)
  });

  // Initialize current board from localStorage or fallback to first board or initialBoardId
  const [currentBoardId, setCurrentBoardId] = useState(() => {
    const stored = localStorage.getItem('agor:currentBoardId');
    if (stored && boards.some((b) => b.board_id === stored)) {
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

  // Persist event stream panel collapsed state to localStorage
  useEffect(() => {
    localStorage.setItem('agor:eventStreamPanelCollapsed', String(eventStreamPanelCollapsed));
  }, [eventStreamPanelCollapsed]);

  // If the stored board no longer exists (e.g., deleted), fallback to first board
  useEffect(() => {
    if (currentBoardId && !boards.some((b) => b.board_id === currentBoardId)) {
      const fallback = boards[0]?.board_id || '';
      setCurrentBoardId(fallback);
    }
  }, [boards, currentBoardId]);

  // Update favicon based on session activity on current board
  useFaviconStatus(currentBoardId, sessions, boardObjects);

  // Check if event stream is enabled in user preferences
  const eventStreamEnabled = user?.preferences?.eventStream?.enabled ?? false;

  // Event stream hook - only captures events when panel is open
  const { events, clearEvents } = useEventStream({
    client,
    enabled: !eventStreamPanelCollapsed,
  });

  const handleOpenTerminal = (commands: string[] = [], worktreeId?: string) => {
    setTerminalCommands(commands);
    setTerminalWorktreeId(worktreeId);
    setTerminalOpen(true);
  };

  const handleCloseTerminal = () => {
    setTerminalOpen(false);
    setTerminalCommands([]);
    setTerminalWorktreeId(undefined);
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
        board_id: config.board_id as BoardID,
      });
    }

    setNewWorktreeModalOpen(false);
  };

  const handleSessionClick = (sessionId: string) => {
    setSelectedSessionId(sessionId);

    // Clear the ready_for_prompt flag when opening the conversation
    const session = sessions.find((s) => s.session_id === sessionId);
    if (session?.ready_for_prompt) {
      onUpdateSession?.(sessionId, { ready_for_prompt: false });
    }

    // Clear the worktree's needs_attention flag when user interacts with it
    const worktree = worktrees.find((w) => w.worktree_id === session?.worktree_id);
    if (worktree?.needs_attention) {
      onUpdateWorktree?.(worktree.worktree_id, { needs_attention: false });
    }
  };

  const handleSendPrompt = async (prompt: string, permissionMode?: PermissionMode) => {
    if (selectedSessionId) {
      const session = sessions.find((s) => s.session_id === selectedSessionId);
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

  const handleSubsession = (config: string | Partial<SpawnConfig>) => {
    if (selectedSessionId) {
      // Handle both legacy string prompt and new SpawnConfig
      const spawnConfig = typeof config === 'string' ? { prompt: config } : config;
      onSpawnSession?.(selectedSessionId, spawnConfig);
    }
  };

  const handlePermissionDecision = useCallback(
    async (
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
    },
    [client, user?.user_id]
  );

  const selectedSession = sessions.find((s) => s.session_id === selectedSessionId) || null;
  const selectedSessionWorktree = selectedSession
    ? worktrees.find((w) => w.worktree_id === selectedSession.worktree_id)
    : null;
  const sessionSettingsSession = sessionSettingsId
    ? sessions.find((s) => s.session_id === sessionSettingsId)
    : null;
  const _selectedSessionTasks = selectedSessionId ? tasks[selectedSessionId] || [] : [];
  const currentBoard = boards.find((b) => b.board_id === currentBoardId);

  // Find worktree and repo for WorktreeModal
  const selectedWorktree = worktreeModalWorktreeId
    ? worktrees.find((w) => w.worktree_id === worktreeModalWorktreeId)
    : null;
  const selectedWorktreeRepo = selectedWorktree
    ? repos.find((r) => r.repo_id === selectedWorktree.repo_id)
    : null;
  const worktreeSessions = selectedWorktree
    ? sessions.filter((s) => s.worktree_id === selectedWorktree.worktree_id)
    : [];

  // Find worktree for NewSessionModal
  const newSessionWorktree = newSessionWorktreeId
    ? worktrees.find((w) => w.worktree_id === newSessionWorktreeId)
    : null;

  // Filter worktrees by current board (via board_objects)
  const boardWorktreeIds = boardObjects
    .filter((bo) => bo.board_id === currentBoard?.board_id)
    .map((bo) => bo.worktree_id);

  const boardWorktrees = worktrees.filter((wt) => boardWorktreeIds.includes(wt.worktree_id));

  // Filter sessions by current board's worktrees
  const boardSessions = sessions.filter((session) =>
    boardWorktreeIds.includes(session.worktree_id)
  );

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
        ...activeUsers.filter((activeUser) => activeUser.user.user_id !== user.user_id),
      ]
    : activeUsers;

  return (
    <Layout style={{ height: '100vh' }}>
      <AppHeader
        user={user}
        activeUsers={allActiveUsers}
        currentUserId={user?.user_id}
        connected={connected}
        connecting={connecting}
        onMenuClick={() => setListDrawerOpen(true)}
        onCommentsClick={() => setCommentsPanelCollapsed(!commentsPanelCollapsed)}
        onEventStreamClick={() => setEventStreamPanelCollapsed(!eventStreamPanelCollapsed)}
        onSettingsClick={() => setSettingsOpen(true)}
        onUserSettingsClick={() => {
          setSettingsActiveTab('users');
          setSettingsEditUserId(user?.user_id);
          setSettingsOpen(true);
        }}
        onThemeEditorClick={() => setThemeEditorOpen(true)}
        onLogout={onLogout}
        onRetryConnection={onRetryConnection}
        currentBoardName={currentBoard?.name}
        currentBoardIcon={currentBoard?.icon}
        unreadCommentsCount={
          comments.filter(
            (c) => c.board_id === currentBoardId && !c.resolved && !c.parent_comment_id
          ).length
        }
        eventStreamEnabled={eventStreamEnabled}
      />
      <Content style={{ position: 'relative', overflow: 'hidden', display: 'flex' }}>
        <CommentsPanel
          client={client}
          boardId={currentBoardId || ''}
          comments={comments.filter((c) => c.board_id === currentBoardId)}
          users={users}
          currentUserId={user?.user_id || 'anonymous'}
          boardObjects={currentBoard?.objects}
          worktrees={boardWorktrees}
          collapsed={commentsPanelCollapsed}
          onToggleCollapse={() => setCommentsPanelCollapsed(!commentsPanelCollapsed)}
          onSendComment={(content) => onSendComment?.(currentBoardId || '', content)}
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
            repos={repos}
            worktrees={boardWorktrees}
            boardObjects={boardObjects}
            comments={comments}
            currentUserId={user?.user_id}
            selectedSessionId={selectedSessionId}
            availableAgents={availableAgents}
            mcpServers={mcpServers}
            sessionMcpServerIds={sessionMcpServerIds}
            onSessionClick={handleSessionClick}
            onSessionUpdate={onUpdateSession}
            onSessionDelete={onDeleteSession}
            onForkSession={onForkSession}
            onSpawnSession={onSpawnSession}
            onUpdateSessionMcpServers={onUpdateSessionMcpServers}
            onOpenSettings={(sessionId) => {
              setSessionSettingsId(sessionId);
            }}
            onCreateSessionForWorktree={(worktreeId) => {
              setNewSessionWorktreeId(worktreeId);
            }}
            onOpenWorktree={(worktreeId) => {
              setWorktreeModalWorktreeId(worktreeId);
            }}
            onArchiveOrDeleteWorktree={onArchiveOrDeleteWorktree}
            onOpenTerminal={handleOpenTerminal}
            onStartEnvironment={onStartEnvironment}
            onStopEnvironment={onStopEnvironment}
            onViewLogs={setLogsModalWorktreeId}
            onOpenCommentsPanel={() => setCommentsPanelCollapsed(false)}
            onCommentHover={setHoveredCommentId}
            onCommentSelect={(commentId) => {
              // Toggle selection: if clicking same comment, deselect
              setSelectedCommentId((prev) => (prev === commentId ? null : commentId));
            }}
          />
          <NewSessionButton
            onClick={() => {
              if (repos.length === 0) {
                showWarning('Please create a repository first in Settings');
              } else {
                setNewWorktreeModalOpen(true);
              }
            }}
            hasRepos={repos.length > 0}
          />
        </div>
        <EventStreamPanel
          collapsed={eventStreamPanelCollapsed}
          onToggleCollapse={() => setEventStreamPanelCollapsed(!eventStreamPanelCollapsed)}
          events={events}
          onClear={clearEvents}
        />
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
          currentUser={user}
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
        onClose={() => {
          setSelectedSessionId(null);
          // Note: highlight flags already cleared in handleSessionClick when drawer opened
        }}
        onSendPrompt={handleSendPrompt}
        onFork={handleFork}
        onSubsession={handleSubsession}
        onPermissionDecision={handlePermissionDecision}
        onOpenSettings={(sessionId) => {
          setSessionSettingsId(sessionId);
        }}
        onOpenWorktree={(worktreeId) => {
          setWorktreeModalWorktreeId(worktreeId);
        }}
        onOpenTerminal={handleOpenTerminal}
        onUpdateSession={onUpdateSession}
        onDelete={onDeleteSession}
        onStartEnvironment={onStartEnvironment}
        onStopEnvironment={onStopEnvironment}
        onViewLogs={setLogsModalWorktreeId}
      />
      <SettingsModal
        open={effectiveSettingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsEditUserId(undefined);
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
        editUserId={settingsEditUserId}
        onTabChange={(newTab) => {
          setSettingsActiveTab(newTab);
          setSettingsEditUserId(undefined); // Clear editUserId when switching tabs
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
        onArchiveOrDeleteWorktree={onArchiveOrDeleteWorktree}
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
        onArchiveOrDelete={onArchiveOrDeleteWorktree}
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
        user={user}
        worktreeId={terminalWorktreeId}
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
      {logsModalWorktreeId && (
        <EnvironmentLogsModal
          open={!!logsModalWorktreeId}
          onClose={() => setLogsModalWorktreeId(null)}
          worktree={worktrees.find((w) => w.worktree_id === logsModalWorktreeId)!}
          client={client}
        />
      )}
      <ThemeEditorModal open={themeEditorOpen} onClose={() => setThemeEditorOpen(false)} />
    </Layout>
  );
};
