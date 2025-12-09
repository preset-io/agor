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
  UpdateUserInput,
  User,
  Worktree,
} from '@agor/core/types';
import { PermissionScope } from '@agor/core/types';
import { Layout } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ImperativePanelHandle,
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from 'react-resizable-panels';
import { mapToArray } from '@/utils/mapHelpers';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { AppDataProvider } from '../../contexts/AppDataContext';
import { useEventStream } from '../../hooks/useEventStream';
import { useFaviconStatus } from '../../hooks/useFaviconStatus';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { usePresence } from '../../hooks/usePresence';
import { useSettingsRoute } from '../../hooks/useSettingsRoute';
import { useUrlState } from '../../hooks/useUrlState';
import type { AgenticToolOption } from '../../types';
import { initializeAudioOnInteraction } from '../../utils/audio';
import { useThemedMessage } from '../../utils/message';
import { AppHeader } from '../AppHeader';
import { CommentsPanel } from '../CommentsPanel';
import { EnvironmentLogsModal } from '../EnvironmentLogsModal';
import { EventStreamPanel } from '../EventStreamPanel';
import { NewSessionButton } from '../NewSessionButton';
import { type NewSessionConfig, NewSessionModal } from '../NewSessionModal';
import { type NewWorktreeConfig, NewWorktreeModal } from '../NewWorktreeModal';
import { SessionCanvas, type SessionCanvasRef } from '../SessionCanvas';
import { SessionPanel } from '../SessionPanel';
import { SessionSettingsModal } from '../SessionSettingsModal';
import { SettingsModal, UserSettingsModal } from '../SettingsModal';
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
  sessionById: Map<string, Session>; // O(1) lookups by session_id - efficient, stable references
  sessionsByWorktree: Map<string, Session[]>; // O(1) worktree-scoped filtering
  availableAgents: AgenticToolOption[];
  boardById: Map<string, Board>; // Map-based board storage
  boardObjectById: Map<string, BoardEntityObject>; // Map-based board object storage
  commentById: Map<string, BoardComment>; // Map-based comment storage
  repoById: Map<string, Repo>; // Map-based repo storage
  worktreeById: Map<string, Worktree>; // Efficient worktree lookups
  userById: Map<string, User>; // Map-based user storage
  mcpServerById: Map<string, MCPServer>; // Map-based MCP server storage
  sessionMcpServerIds: Map<string, string[]>; // Map-based session-MCP relationships
  initialBoardId?: string;
  openSettingsTab?: string | null; // Open settings modal to a specific tab
  onSettingsClose?: () => void; // Called when settings modal closes
  openUserSettings?: boolean; // Open user settings modal directly (e.g., from onboarding)
  onUserSettingsClose?: () => void; // Called when user settings modal closes
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
  onCreateLocalRepo?: (data: { path: string; slug?: string }) => void;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onDeleteRepo?: (repoId: string, cleanup: boolean) => void;
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
      refType?: 'branch' | 'tag';
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      issue_url?: string;
      pull_request_url?: string;
    }
  ) => Promise<Worktree | null>;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onNukeEnvironment?: (worktreeId: string) => void;
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
  sessionById,
  sessionsByWorktree,
  availableAgents,
  boardById,
  boardObjectById,
  commentById,
  repoById,
  worktreeById,
  userById,
  mcpServerById,
  sessionMcpServerIds,
  initialBoardId,
  openSettingsTab,
  onSettingsClose,
  openUserSettings,
  onUserSettingsClose,
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
  onCreateLocalRepo,
  onUpdateRepo,
  onDeleteRepo,
  onArchiveOrDeleteWorktree,
  onUnarchiveWorktree,
  onUpdateWorktree,
  onCreateWorktree,
  onStartEnvironment,
  onStopEnvironment,
  onNukeEnvironment,
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
  const sessionCanvasRef = useRef<SessionCanvasRef>(null);
  const [newSessionWorktreeId, setNewSessionWorktreeId] = useState<string | null>(null);
  const [newWorktreeModalOpen, setNewWorktreeModalOpen] = useState(false);
  const [newWorktreeDefaultPosition, setNewWorktreeDefaultPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [listDrawerOpen, setListDrawerOpen] = useState(false);
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);

  // Settings modal state via URL routing
  const {
    isOpen: settingsRouteOpen,
    section: settingsRouteSection,
    // itemId: settingsRouteItemId, // TODO: wire up to nested modals
    openSettings,
    closeSettings,
    setSection: setSettingsSection,
  } = useSettingsRoute();

  // Combine route-based and prop-based settings state
  // Props take precedence for backward compatibility with onboarding flow
  const settingsOpen = settingsRouteOpen || !!openSettingsTab;
  const effectiveSettingsTab = openSettingsTab || settingsRouteSection;

  // Handle external user settings modal control (e.g., from onboarding "Configure API Keys")
  const effectiveUserSettingsOpen = userSettingsOpen || !!openUserSettings;

  // Initialize comments panel state from localStorage (collapsed by default)
  const [commentsPanelCollapsed, setCommentsPanelCollapsed] = useLocalStorage<boolean>(
    'agor:commentsPanelCollapsed',
    true
  );

  // Comments panel size persistence (percentage of available width)
  const [commentsPanelSize, setCommentsPanelSize] = useLocalStorage<number>(
    'agor:commentsPanelSize',
    25
  );

  // Ref for programmatically controlling the comments panel
  const commentsPanelRef = useRef<ImperativePanelHandle>(null);

  // Session panel size persistence (percentage of available width)
  const [sessionPanelSize, setSessionPanelSize] = useLocalStorage<number>(
    'agor:sessionPanelSize',
    50
  );

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
  const [eventStreamPanelCollapsed, setEventStreamPanelCollapsed] = useLocalStorage<boolean>(
    'agor:eventStreamPanelCollapsed',
    true
  );

  // Initialize current board from localStorage or fallback to first board or initialBoardId
  const [currentBoardId, setCurrentBoardIdInternal] = useState(() => {
    const stored = localStorage.getItem('agor:currentBoardId');
    if (stored && boardById.has(stored)) {
      return stored;
    }
    const firstBoard = mapToArray(boardById)[0];
    return initialBoardId || firstBoard?.board_id || '';
  });

  // Persist current board to localStorage when it changes
  useEffect(() => {
    if (currentBoardId) {
      localStorage.setItem('agor:currentBoardId', currentBoardId);
    }
  }, [currentBoardId]);

  // Initialize audio on first user interaction (for browser autoplay policy)
  useEffect(() => {
    initializeAudioOnInteraction();
  }, []);

  // Programmatically collapse/expand the comments panel when toggle state changes
  useEffect(() => {
    if (commentsPanelRef.current) {
      if (commentsPanelCollapsed) {
        commentsPanelRef.current.collapse();
      } else {
        commentsPanelRef.current.expand();
      }
    }
  }, [commentsPanelCollapsed]);

  // URL state synchronization - bidirectional sync between URL and state
  useUrlState({
    currentBoardId,
    currentSessionId: selectedSessionId,
    boardById,
    sessionById,
    onBoardChange: (boardId) => {
      setCurrentBoardIdInternal(boardId);
    },
    onSessionChange: (sessionId) => {
      setSelectedSessionId(sessionId);
    },
  });

  // Wrapper to update board ID (updates both state and URL via hook)
  const setCurrentBoardId = useCallback((boardId: string) => {
    setCurrentBoardIdInternal(boardId);
  }, []);

  // If the stored board no longer exists (e.g., deleted), fallback to first board
  useEffect(() => {
    if (currentBoardId && !boardById.has(currentBoardId)) {
      const fallback = mapToArray(boardById)[0]?.board_id || '';
      setCurrentBoardId(fallback);
    }
  }, [boardById, currentBoardId, setCurrentBoardId]);

  // Recalculate default position when board changes while modal is open
  // This ensures worktrees spawn at the center of the new board's viewport
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentBoardId is intentionally included to trigger recalculation on board switch
  useEffect(() => {
    if (newWorktreeModalOpen) {
      const center = sessionCanvasRef.current?.getViewportCenter();
      setNewWorktreeDefaultPosition(center || null);
    }
  }, [currentBoardId, newWorktreeModalOpen]);

  // Update favicon based on session activity on current board
  useFaviconStatus(currentBoardId, sessionsByWorktree, mapToArray(boardObjectById));

  // Check if event stream is enabled in user preferences (default: true)
  const eventStreamEnabled = user?.preferences?.eventStream?.enabled ?? true;

  // Event stream hook - only captures events when panel is open
  const { events, clearEvents } = useEventStream({
    client,
    enabled: !eventStreamPanelCollapsed,
  });

  const handleOpenTerminal = useCallback((commands: string[] = [], worktreeId?: string) => {
    setTerminalCommands(commands);
    setTerminalWorktreeId(worktreeId);
    setTerminalOpen(true);
  }, []);

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
      refType: config.refType,
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
    const session = sessionById.get(sessionId);
    if (session?.ready_for_prompt) {
      onUpdateSession?.(sessionId, { ready_for_prompt: false });
    }

    // Clear the worktree's needs_attention flag when user interacts with it
    const worktree = session?.worktree_id ? worktreeById.get(session.worktree_id) : undefined;
    if (worktree?.needs_attention) {
      onUpdateWorktree?.(worktree.worktree_id, { needs_attention: false });
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

  const selectedSession = selectedSessionId ? sessionById.get(selectedSessionId) || null : null;
  const selectedSessionWorktree = selectedSession
    ? worktreeById.get(selectedSession.worktree_id)
    : null;
  const sessionSettingsSession = sessionSettingsId ? sessionById.get(sessionSettingsId) : null;
  const currentBoard = boardById.get(currentBoardId);

  // Find worktree and repo for WorktreeModal
  const selectedWorktree = worktreeModalWorktreeId
    ? worktreeById.get(worktreeModalWorktreeId)
    : null;
  const selectedWorktreeRepo = selectedWorktree ? repoById.get(selectedWorktree.repo_id) : null;
  const worktreeSessions = selectedWorktree
    ? sessionsByWorktree.get(selectedWorktree.worktree_id) || []
    : [];

  // Find worktree for NewSessionModal
  const newSessionWorktree = newSessionWorktreeId ? worktreeById.get(newSessionWorktreeId) : null;

  // Filter worktrees by current board (via board_objects)
  // Optimized: use Map lookups instead of array.filter
  const boardWorktrees = mapToArray(boardObjectById)
    .filter((bo: BoardEntityObject) => bo.board_id === currentBoard?.board_id)
    .map((bo: BoardEntityObject) => worktreeById.get(bo.worktree_id))
    .filter((wt): wt is Worktree => wt !== undefined);

  // Track global presence for navbar facepile (across all boards)
  const { activeUsers: globalActiveUsers } = usePresence({
    client,
    boardId: currentBoard?.board_id as BoardID | null,
    users: mapToArray(userById),
    enabled: !!client,
    globalPresence: true,
  });

  // Include current user in the global facepile (always first)
  // Filter out current user from globalActiveUsers to avoid duplication
  const allActiveUsers = user
    ? [
        {
          user,
          lastSeen: Date.now(),
          boardId: currentBoard?.board_id,
          cursor: undefined, // Current user doesn't have a remote cursor
        },
        ...globalActiveUsers.filter((activeUser) => activeUser.user.user_id !== user.user_id),
      ]
    : globalActiveUsers;

  // Check if current user is mentioned in active comments
  const activeComments = mapToArray(commentById).filter(
    (c: BoardComment) => c.board_id === currentBoardId && !c.resolved
  );

  const currentUserName = user?.name || user?.email?.split('@')[0] || '';
  const hasUserMentions =
    !!currentUserName &&
    activeComments.some((comment) => {
      // Check if comment content mentions the user
      const mentionPatterns = [
        `@${currentUserName}`,
        `@"${currentUserName}"`,
        `@${user?.email}`,
        `@"${user?.email}"`,
      ];
      return mentionPatterns.some((pattern) => comment.content.includes(pattern));
    });

  // Memoize AppDataContext value to prevent unnecessary re-renders
  const appDataValue = useMemo(
    () => ({
      sessionById,
      worktreeById,
      sessionsByWorktree,
      repoById,
      mcpServerById,
      sessionMcpServerIds,
      userById,
      boardById,
      boardObjectById,
      commentById,
    }),
    [
      sessionById,
      worktreeById,
      sessionsByWorktree,
      repoById,
      mcpServerById,
      sessionMcpServerIds,
      userById,
      boardById,
      boardObjectById,
      commentById,
    ]
  );

  // Memoize AppActionsContext value with useCallback-wrapped handlers
  const appActionsValue = useMemo(
    () => ({
      onSendPrompt,
      onFork: onForkSession,
      onSubsession: onSpawnSession,
      onUpdateSession,
      onDeleteSession,
      onPermissionDecision: handlePermissionDecision,
      onStartEnvironment,
      onStopEnvironment,
      onNukeEnvironment,
      onViewLogs: (worktreeId: string) => setLogsModalWorktreeId(worktreeId),
      onOpenSettings: (sessionId: string) => setSessionSettingsId(sessionId),
      onOpenWorktree: (worktreeId: string) => setWorktreeModalWorktreeId(worktreeId),
      onOpenTerminal: handleOpenTerminal,
    }),
    [
      onSendPrompt,
      onForkSession,
      onSpawnSession,
      onUpdateSession,
      onDeleteSession,
      handlePermissionDecision,
      onStartEnvironment,
      onStopEnvironment,
      onNukeEnvironment,
      handleOpenTerminal,
    ]
  );

  return (
    <AppDataProvider value={appDataValue}>
      <AppActionsProvider value={appActionsValue}>
        <Layout style={{ height: '100vh' }}>
          <AppHeader
            user={user}
            activeUsers={allActiveUsers}
            currentUserId={user?.user_id}
            connected={connected}
            connecting={connecting}
            onMenuClick={() => setListDrawerOpen(true)}
            onCommentsClick={() => setCommentsPanelCollapsed(!commentsPanelCollapsed)}
            onEventStreamClick={() => {
              // If session is open, close it and show event stream
              if (selectedSessionId) {
                setSelectedSessionId(null);
                setEventStreamPanelCollapsed(false);
              } else {
                // Toggle event stream panel
                setEventStreamPanelCollapsed(!eventStreamPanelCollapsed);
              }
            }}
            onSettingsClick={() => openSettings()}
            onUserSettingsClick={() => setUserSettingsOpen(true)}
            onThemeEditorClick={() => setThemeEditorOpen(true)}
            onLogout={onLogout}
            onRetryConnection={onRetryConnection}
            currentBoardName={currentBoard?.name}
            currentBoardIcon={currentBoard?.icon}
            unreadCommentsCount={
              activeComments.filter((c: BoardComment) => !c.parent_comment_id).length
            }
            eventStreamEnabled={eventStreamEnabled}
            hasUserMentions={hasUserMentions}
            boards={mapToArray(boardById)}
            currentBoardId={currentBoardId}
            onBoardChange={setCurrentBoardId}
            worktreeById={worktreeById}
            repoCount={repoById.size}
            worktreeCount={worktreeById.size}
            hasAuthentication={
              // Check if user has any AI provider credentials configured
              !!(
                user?.api_keys?.ANTHROPIC_API_KEY ||
                user?.api_keys?.OPENAI_API_KEY ||
                user?.api_keys?.GEMINI_API_KEY ||
                user?.env_vars?.ANTHROPIC_API_KEY ||
                user?.env_vars?.OPENAI_API_KEY ||
                user?.env_vars?.GEMINI_API_KEY
              )
            }
            onDismissOnboarding={
              onUpdateUser
                ? () => {
                    if (user) {
                      onUpdateUser(user.user_id, { onboarding_completed: true });
                    }
                  }
                : undefined
            }
            onOpenRepoSettings={() => openSettings('repos')}
            onOpenAuthSettings={() => openSettings('agentic-tools')}
            onOpenNewWorktree={() => {
              const center = sessionCanvasRef.current?.getViewportCenter();
              setNewWorktreeDefaultPosition(center || null);
              setNewWorktreeModalOpen(true);
            }}
            boardById={boardById}
            onUserClick={(userId: string, boardId?: BoardID, cursor?: { x: number; y: number }) => {
              // Navigate to the user's board
              if (boardId) {
                setCurrentBoardId(boardId);
                // TODO: If cursor position is provided, we could pan to that position
                // This would require exposing a method on SessionCanvasRef
              }
            }}
          />
          <Content style={{ position: 'relative', overflow: 'hidden', display: 'flex' }}>
            <PanelGroup
              id="main-layout"
              direction="horizontal"
              style={{ flex: 1 }}
              onLayout={(sizes) => {
                // Save left panel size when user resizes (only when panel is open)
                if (!commentsPanelCollapsed && sizes.length >= 2) {
                  // Comments panel is the first panel (index 0)
                  setCommentsPanelSize(sizes[0]);
                }
              }}
            >
              <Panel
                ref={commentsPanelRef}
                collapsible
                defaultSize={commentsPanelCollapsed ? 0 : commentsPanelSize}
                collapsedSize={0}
                minSize={commentsPanelCollapsed ? 0 : 15}
                maxSize={40}
              >
                {!commentsPanelCollapsed && (
                  <CommentsPanel
                    client={client}
                    boardId={currentBoardId || ''}
                    comments={mapToArray(commentById).filter(
                      (c: BoardComment) => c.board_id === currentBoardId
                    )}
                    userById={userById}
                    currentUserId={user?.user_id || 'anonymous'}
                    boardObjects={currentBoard?.objects}
                    worktreeById={worktreeById}
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
                )}
              </Panel>
              <PanelResizeHandle
                style={{
                  width: commentsPanelCollapsed ? '0px' : '4px',
                  background: 'var(--ant-color-border-secondary)',
                  cursor: commentsPanelCollapsed ? 'default' : 'col-resize',
                  transition: 'background 0.2s',
                  pointerEvents: commentsPanelCollapsed ? 'none' : 'auto',
                }}
                onMouseEnter={(e) => {
                  if (!commentsPanelCollapsed) {
                    (e.currentTarget as unknown as HTMLDivElement).style.background =
                      'var(--ant-color-primary)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!commentsPanelCollapsed) {
                    (e.currentTarget as unknown as HTMLDivElement).style.background =
                      'var(--ant-color-border-secondary)';
                  }
                }}
              />
              <Panel
                defaultSize={commentsPanelCollapsed ? 100 : 100 - commentsPanelSize}
                minSize={40}
              >
                <PanelGroup
                  id="canvas-session"
                  direction="horizontal"
                  style={{ flex: 1 }}
                  onLayout={(sizes) => {
                    // Save right panel size when user resizes (only when panel is open)
                    if (selectedSessionId && sizes.length === 2) {
                      setSessionPanelSize(sizes[1]);
                    }
                  }}
                >
                  <Panel
                    defaultSize={selectedSessionId ? 100 - sessionPanelSize : 100}
                    minSize={20}
                  >
                    <div style={{ position: 'relative', overflow: 'hidden', height: '100%' }}>
                      <SessionCanvas
                        ref={sessionCanvasRef}
                        board={currentBoard || null}
                        client={client}
                        sessionById={sessionById}
                        sessionsByWorktree={sessionsByWorktree}
                        userById={userById}
                        repoById={repoById}
                        worktrees={boardWorktrees}
                        worktreeById={worktreeById}
                        boardObjectById={boardObjectById}
                        commentById={commentById}
                        currentUserId={user?.user_id}
                        selectedSessionId={selectedSessionId}
                        availableAgents={availableAgents}
                        mcpServerById={mcpServerById}
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
                        onNukeEnvironment={onNukeEnvironment}
                        onOpenCommentsPanel={() => setCommentsPanelCollapsed(false)}
                        onCommentHover={setHoveredCommentId}
                        onCommentSelect={(commentId) => {
                          // Toggle selection: if clicking same comment, deselect
                          setSelectedCommentId((prev) => (prev === commentId ? null : commentId));
                        }}
                      />
                      <NewSessionButton
                        onClick={() => {
                          if (repoById.size === 0) {
                            showWarning('Please create a repository first in Settings');
                          } else {
                            const center = sessionCanvasRef.current?.getViewportCenter();
                            setNewWorktreeDefaultPosition(center || null);
                            setNewWorktreeModalOpen(true);
                          }
                        }}
                        hasRepos={repoById.size > 0}
                      />
                    </div>
                  </Panel>
                  {(selectedSessionId || !eventStreamPanelCollapsed) && (
                    <>
                      <PanelResizeHandle
                        style={{
                          width: '4px',
                          background: 'var(--ant-color-border-secondary)',
                          cursor: 'col-resize',
                          transition: 'background 0.2s',
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as unknown as HTMLDivElement).style.background =
                            'var(--ant-color-primary)';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as unknown as HTMLDivElement).style.background =
                            'var(--ant-color-border-secondary)';
                        }}
                      />
                      <Panel defaultSize={sessionPanelSize} minSize={25} maxSize={75}>
                        {selectedSessionId ? (
                          <SessionPanel
                            client={client}
                            session={selectedSession}
                            worktree={selectedSessionWorktree}
                            currentUserId={user?.user_id}
                            sessionMcpServerIds={
                              selectedSessionId
                                ? sessionMcpServerIds.get(selectedSessionId) || []
                                : []
                            }
                            open={!!selectedSessionId}
                            onClose={() => {
                              setSelectedSessionId(null);
                            }}
                          />
                        ) : (
                          <EventStreamPanel
                            collapsed={false}
                            onToggleCollapse={() => setEventStreamPanelCollapsed(true)}
                            events={events}
                            onClear={clearEvents}
                            currentUserId={user?.user_id}
                            selectedSessionId={selectedSessionId}
                            currentBoard={currentBoard}
                            client={client}
                            worktreeActions={{
                              onSessionClick: setSelectedSessionId,
                              onCreateSession: (worktreeId) => setNewSessionWorktreeId(worktreeId),
                              onOpenSettings: (worktreeId) =>
                                setWorktreeModalWorktreeId(worktreeId),
                              onNukeEnvironment,
                            }}
                          />
                        )}
                      </Panel>
                    </>
                  )}
                </PanelGroup>
              </Panel>
            </PanelGroup>
          </Content>
          {newSessionWorktreeId && (
            <NewSessionModal
              open={true}
              onClose={() => setNewSessionWorktreeId(null)}
              onCreate={handleCreateSession}
              availableAgents={availableAgents}
              worktreeId={newSessionWorktreeId}
              worktree={newSessionWorktree || undefined}
              mcpServerById={mcpServerById}
              currentUser={user}
              client={client}
              userById={userById}
            />
          )}
          <SettingsModal
            open={settingsOpen}
            onClose={() => {
              closeSettings();
              onSettingsClose?.();
            }}
            client={client}
            currentUser={user}
            boardById={boardById}
            boardObjects={mapToArray(boardObjectById)}
            repoById={repoById}
            worktreeById={worktreeById}
            sessionById={sessionById}
            sessionsByWorktree={sessionsByWorktree}
            userById={userById}
            mcpServerById={mcpServerById}
            activeTab={effectiveSettingsTab}
            onTabChange={(newTab) => {
              setSettingsSection(newTab as Parameters<typeof setSettingsSection>[0]);
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
            onCreateLocalRepo={onCreateLocalRepo}
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
              mcpServerById={mcpServerById}
              sessionMcpServerIds={
                sessionSettingsId ? sessionMcpServerIds.get(sessionSettingsId) || [] : []
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
            boardById={boardById}
            mcpServerById={mcpServerById}
            client={client}
            currentUser={user}
            onUpdateWorktree={onUpdateWorktree}
            onUpdateRepo={onUpdateRepo}
            onArchiveOrDelete={onArchiveOrDeleteWorktree}
            onOpenSettings={() => {
              setWorktreeModalWorktreeId(null);
              openSettings();
            }}
          />
          <WorktreeListDrawer
            open={listDrawerOpen}
            onClose={() => setListDrawerOpen(false)}
            boards={mapToArray(boardById)}
            currentBoardId={currentBoardId}
            onBoardChange={setCurrentBoardId}
            sessionsByWorktree={sessionsByWorktree}
            worktreeById={worktreeById}
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
            open={newWorktreeModalOpen}
            onClose={() => {
              setNewWorktreeModalOpen(false);
              setNewWorktreeDefaultPosition(null);
            }}
            onCreate={handleCreateWorktree}
            repoById={repoById}
            currentBoardId={currentBoardId}
            defaultPosition={newWorktreeDefaultPosition || undefined}
          />
          {logsModalWorktreeId && (
            <EnvironmentLogsModal
              open={!!logsModalWorktreeId}
              onClose={() => setLogsModalWorktreeId(null)}
              worktree={worktreeById.get(logsModalWorktreeId)!}
              client={client}
            />
          )}
          <ThemeEditorModal open={themeEditorOpen} onClose={() => setThemeEditorOpen(false)} />
          <UserSettingsModal
            open={effectiveUserSettingsOpen}
            onClose={() => {
              setUserSettingsOpen(false);
              onUserSettingsClose?.();
            }}
            user={user || null}
            mcpServerById={mcpServerById}
            onUpdate={onUpdateUser}
          />
        </Layout>
      </AppActionsProvider>
    </AppDataProvider>
  );
};
