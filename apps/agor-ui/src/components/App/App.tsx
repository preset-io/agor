import type {
  AgorClient,
  Artifact,
  Board,
  BoardComment,
  BoardEntityObject,
  BoardID,
  CardType,
  CardWithType,
  CreateLocalRepoRequest,
  CreateMCPServerInput,
  CreateRepoRequest,
  CreateUserInput,
  GatewayChannel,
  MCPServer,
  PermissionMode,
  Repo,
  Session,
  SpawnConfig,
  UpdateUserInput,
  User,
  Worktree,
} from '@agor-live/client';
import { hasMinimumRole, PermissionScope } from '@agor-live/client';
import { Layout, Upload } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ImperativePanelHandle,
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from 'react-resizable-panels';
import { mapToArray } from '@/utils/mapHelpers';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { AppEntityDataProvider, AppLiveDataProvider } from '../../contexts/AppDataContext';
import { useBoardTitle } from '../../hooks/useBoardTitle';
import { useEventStream } from '../../hooks/useEventStream';
import { useFaviconStatus } from '../../hooks/useFaviconStatus';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { usePresence } from '../../hooks/usePresence';
import { useRecentBoards } from '../../hooks/useRecentBoards';
import { useSettingsRoute } from '../../hooks/useSettingsRoute';
import { useTaskCompletionChime } from '../../hooks/useTaskCompletionChime';
import { useUrlState } from '../../hooks/useUrlState';
import type { AgenticToolOption } from '../../types';
import { createAssistantWorktree } from '../../utils/assistantCreation';
import { initializeAudioOnInteraction } from '../../utils/audio';
import { AppHeader } from '../AppHeader';
import { CommentsPanel } from '../CommentsPanel';
import { CreateDialog } from '../CreateDialog';
import type { AssistantTabResult } from '../CreateDialog/tabs/AssistantTab';
import type { WorktreeTabConfig } from '../CreateDialog/tabs/WorktreeTab';
import { EnvironmentLogsModal } from '../EnvironmentLogsModal';
import { EventStreamPanel } from '../EventStreamPanel';
import { NewSessionButton } from '../NewSessionButton';
import { type NewSessionConfig, NewSessionModal } from '../NewSessionModal';
import { SessionCanvas, type SessionCanvasRef } from '../SessionCanvas';
import { SessionPanel } from '../SessionPanel';
import { SessionSettingsModal } from '../SessionSettingsModal';
import { SettingsModal, UserSettingsModal } from '../SettingsModal';
import { TerminalModal, WEB_TERMINAL_MIN_ROLE } from '../TerminalModal';
import { ThemeEditorModal } from '../ThemeEditorModal';
import { WorktreeListDrawer } from '../WorktreeListDrawer';
import { WorktreeModal, type WorktreeModalTab } from '../WorktreeModal';
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
  cardById: Map<string, CardWithType>; // Map-based card storage
  cardTypeById: Map<string, CardType>; // Map-based card type storage
  repoById: Map<string, Repo>; // Map-based repo storage
  worktreeById: Map<string, Worktree>; // Efficient worktree lookups
  userById: Map<string, User>; // Map-based user storage
  mcpServerById: Map<string, MCPServer>; // Map-based MCP server storage
  sessionMcpServerIds: Map<string, string[]>; // Map-based session-MCP relationships
  userAuthenticatedMcpServerIds: Set<string>; // Per-user OAuth auth status
  initialBoardId?: string;
  openSettingsTab?: string | null; // Open settings modal to a specific tab
  onSettingsClose?: () => void; // Called when settings modal closes
  openUserSettings?: boolean; // Open user settings modal directly (e.g., from onboarding)
  onUserSettingsClose?: () => void; // Called when user settings modal closes
  openNewWorktreeModal?: boolean; // Open new worktree modal
  onNewWorktreeModalClose?: () => void; // Called when new worktree modal closes
  onCreateSession?: (config: NewSessionConfig, boardId: string) => Promise<string | null>;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onBtwForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onSendPrompt?: (sessionId: string, prompt: string, permissionMode?: PermissionMode) => void;
  onUpdateSession?: (sessionId: string, updates: Partial<Session>) => void;
  onDeleteSession?: (sessionId: string) => void;
  onCreateBoard?: (board: Partial<Board>) => void;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void;
  onDeleteBoard?: (boardId: string) => void;
  onArchiveBoard?: (boardId: string) => void;
  onUnarchiveBoard?: (boardId: string) => void;
  onCreateRepo?: (data: CreateRepoRequest) => void | Promise<void>;
  onCreateLocalRepo?: (data: CreateLocalRepoRequest) => void | Promise<void>;
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
  onExecuteScheduleNow?: (worktreeId: string) => Promise<void>;
  onCreateUser?: (data: CreateUserInput) => void;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => void;
  onDeleteUser?: (userId: string) => void;
  onCreateMCPServer?: (data: CreateMCPServerInput) => void;
  onDeleteMCPServer?: (mcpServerId: string) => void;
  gatewayChannelById: Map<string, GatewayChannel>;
  onCreateGatewayChannel?: (data: Partial<GatewayChannel>) => void;
  onUpdateGatewayChannel?: (channelId: string, updates: Partial<GatewayChannel>) => void;
  onDeleteGatewayChannel?: (channelId: string) => void;
  artifactById: Map<string, Artifact>;
  onUpdateArtifact?: (artifactId: string, updates: Partial<Artifact>) => void;
  onDeleteArtifact?: (artifactId: string) => void;
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
  onUpdateSessionEnvSelections?: (sessionId: string, envVarNames: string[]) => void;
  onSendComment?: (boardId: string, content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
  onLogout?: () => void;
  onRetryConnection?: () => void;
  /** Instance label for deployment identification (displayed as a Tag in navbar) */
  instanceLabel?: string;
  /** Instance description (markdown) shown in popover around the instance label */
  instanceDescription?: string;
  /** Whether the web terminal is enabled on this instance (execution.allow_web_terminal) */
  webTerminalEnabled?: boolean;
}

// Stable empty-array sentinel: keeps prop refs equal across renders for the
// common no-MCP case so that downstream React.memo bailouts are not defeated.
// Frozen at runtime; the consuming components only read it.
const EMPTY_STRING_ARRAY: string[] = Object.freeze([] as string[]) as string[];

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
  cardById,
  cardTypeById,
  repoById,
  worktreeById,
  userById,
  mcpServerById,
  sessionMcpServerIds,
  userAuthenticatedMcpServerIds,
  initialBoardId,
  openSettingsTab,
  onSettingsClose,
  openUserSettings,
  onUserSettingsClose,
  openNewWorktreeModal,
  onNewWorktreeModalClose,
  onCreateSession,
  onForkSession,
  onBtwForkSession,
  onSpawnSession,
  onSendPrompt,
  onUpdateSession,
  onDeleteSession,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
  onArchiveBoard,
  onUnarchiveBoard,
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
  onExecuteScheduleNow,
  onCreateUser,
  onUpdateUser,
  onDeleteUser,
  onCreateMCPServer,
  onDeleteMCPServer,
  gatewayChannelById,
  onCreateGatewayChannel,
  onUpdateGatewayChannel,
  onDeleteGatewayChannel,
  artifactById,
  onUpdateArtifact,
  onDeleteArtifact,
  onUpdateSessionMcpServers,
  onUpdateSessionEnvSelections,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
  onDeleteComment,
  onLogout,
  onRetryConnection,
  instanceLabel,
  instanceDescription,
  webTerminalEnabled = false,
}) => {
  const sessionCanvasRef = useRef<SessionCanvasRef>(null);
  const [newSessionWorktreeId, setNewSessionWorktreeId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newWorktreeDefaultPosition, setNewWorktreeDefaultPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Synchronously derive the effective session selection. When a session is
  // archived/deleted, it vanishes from sessionById. Without this, there is a
  // two-phase unmount: first SessionPanel renders null (session gone but
  // selectedSessionId still set), then a useEffect clears selectedSessionId
  // on the *next* render. During that intermediate render, every antd
  // component inside SessionPanel unmounts while the Panel container stays,
  // causing @ant-design/cssinjs to GC component-level CSS-variable <style>
  // tags (via useCSSVarRegister ref-counting) and potentially the global
  // theme token styles. By computing the effective ID synchronously, the
  // Panel conditional evaluates to false in the *same* render, producing a
  // single-phase unmount identical to the explicit-close path.
  const effectiveSelectedSessionId = useMemo(
    () => (selectedSessionId && sessionById.has(selectedSessionId) ? selectedSessionId : null),
    [selectedSessionId, sessionById]
  );

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
  const [worktreeModalTab, setWorktreeModalTab] = useState<WorktreeModalTab | undefined>(undefined);
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

  // Track recent boards (single instance — passed down to AppHeader as props)
  const { recentBoards, trackBoardVisit } = useRecentBoards(mapToArray(boardById), currentBoardId);

  // Persist current board to localStorage when it changes
  useEffect(() => {
    if (currentBoardId) {
      localStorage.setItem('agor:currentBoardId', currentBoardId);
      trackBoardVisit(currentBoardId);
    }
  }, [currentBoardId, trackBoardVisit]);

  // Initialize audio on first user interaction (for browser autoplay policy)
  useEffect(() => {
    initializeAudioOnInteraction();
  }, []);

  // Play chime when tasks transition from RUNNING → COMPLETED/FAILED.
  // Subscribed globally so it fires regardless of which session panel is open.
  useTaskCompletionChime(client, user?.user_id, user?.preferences?.audio);

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
    currentSessionId: effectiveSelectedSessionId,
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
  // Also closes conversation panel when switching to a different board
  const setCurrentBoardId = useCallback(
    (boardId: string) => {
      if (boardId !== currentBoardId) {
        setSelectedSessionId(null);
      }
      setCurrentBoardIdInternal(boardId);
    },
    [currentBoardId]
  );

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
    if (createDialogOpen) {
      const center = sessionCanvasRef.current?.getViewportCenter();
      setNewWorktreeDefaultPosition(center || null);
    }
  }, [currentBoardId, createDialogOpen]);

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

  // Stable callbacks passed into SessionCanvas. These previously lived as
  // inline arrows in JSX, which gave them a fresh identity on every App
  // render — that propagated into the canvas's `initialNodes` useMemo deps
  // and triggered a full node-list recompute on every socket event.
  const handleOpenCommentsPanel = useCallback(() => {
    setCommentsPanelCollapsed(false);
  }, [setCommentsPanelCollapsed]);

  const handleCommentSelect = useCallback((commentId: string | null) => {
    // Toggle selection: if clicking same comment, deselect
    setSelectedCommentId((prev) => (prev === commentId ? null : commentId));
  }, []);

  // Stable handler so SessionPanel's React.memo bailout isn't defeated by a
  // fresh inline arrow on every App render (App re-renders on every live patch).
  const handleCloseSessionPanel = useCallback(() => {
    setSelectedSessionId(null);
  }, []);

  const handleCloseTerminal = () => {
    setTerminalOpen(false);
    setTerminalCommands([]);
    setTerminalWorktreeId(undefined);
  };

  const handleCreateSession = async (config: NewSessionConfig) => {
    const sessionId = await onCreateSession?.(config, currentBoardId);
    setNewSessionWorktreeId(null);

    // If session was created successfully, open the drawer to show it
    if (sessionId) {
      setSelectedSessionId(sessionId);
    }
  };

  const handleCreateWorktree = async (config: WorktreeTabConfig) => {
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

    setCreateDialogOpen(false);
  };

  const handleCreateAssistant = async (result: AssistantTabResult) => {
    const repoId = result.repoId;
    if (!repoId || !onCreateWorktree || !onUpdateWorktree) return;

    await createAssistantWorktree(
      {
        displayName: result.displayName,
        description: result.description,
        emoji: result.emoji,
        boardChoice: result.boardChoice,
        repoId,
        worktreeName: result.worktreeName,
        sourceBranch: result.sourceBranch,
      },
      { client, repoById, onCreateWorktree, onUpdateWorktree }
    );
  };

  // Refs for the data this handler reads. Using refs (vs useCallback deps)
  // means `handleSessionClick` keeps a stable identity across renders even
  // as `sessionById` / `worktreeById` change on every socket event. Without
  // this, the handler reference flips on every patch and gets passed into
  // SessionCanvas → initialNodes deps → recomputed → every WorktreeCard
  // memo fails. Pattern: ref holds latest values; closure never changes.
  const sessionByIdRef = useRef(sessionById);
  sessionByIdRef.current = sessionById;
  const worktreeByIdRef = useRef(worktreeById);
  worktreeByIdRef.current = worktreeById;

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      setSelectedSessionId(sessionId);

      const session = sessionByIdRef.current.get(sessionId);

      // Best-effort: clear highlight flags when opening the conversation.
      // These updates may fail silently if the user lacks write permission (e.g. read-only
      // access via RBAC). We suppress errors to avoid spurious toasts for read-only users.
      if (client && session?.ready_for_prompt) {
        client
          .service('sessions')
          .patch(sessionId, { ready_for_prompt: false })
          .catch(() => {});
      }

      const worktree = session?.worktree_id
        ? worktreeByIdRef.current.get(session.worktree_id)
        : undefined;
      if (client && worktree?.needs_attention) {
        client
          .service('worktrees')
          .patch(worktree.worktree_id, { needs_attention: false })
          .catch(() => {});
      }
    },
    [client]
  );

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
        // Call the permission decision endpoint
        await client.service(`sessions/${sessionId}/permission-decision`).create({
          requestId,
          taskId,
          allow,
          reason: allow ? 'Approved by user' : 'Denied by user',
          remember: scope !== PermissionScope.ONCE, // Only remember if not 'once'
          scope,
          decidedBy: user?.user_id || 'unknown',
        });
      } catch (error) {
        console.error('❌ Failed to send permission decision:', error);
      }
    },
    [client, user?.user_id]
  );

  const selectedSession = effectiveSelectedSessionId
    ? sessionById.get(effectiveSelectedSessionId) || null
    : null;
  const selectedSessionWorktree = selectedSession
    ? worktreeById.get(selectedSession.worktree_id)
    : null;

  // Sync the actual state when a session disappears (for URL, localStorage, etc.).
  // The rendering already uses effectiveSelectedSessionId so this is cosmetic.
  useEffect(() => {
    if (selectedSessionId && !sessionById.has(selectedSessionId)) {
      setSelectedSessionId(null);
    }
  }, [selectedSessionId, sessionById]);

  const sessionSettingsSession = sessionSettingsId ? sessionById.get(sessionSettingsId) : null;
  const currentBoard = boardById.get(currentBoardId);

  // Update browser tab title based on current board
  useBoardTitle(currentBoard);

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

  // Filter worktrees by current board (via board_objects). Memoized so that
  // unrelated socket churn (e.g. another user's session patch) doesn't
  // produce a fresh array reference on every render — that array flows into
  // SessionCanvas's `initialNodes` deps and would otherwise cascade into
  // every WorktreeCard re-rendering.
  const boardWorktrees = useMemo(
    () =>
      mapToArray(boardObjectById)
        .filter((bo: BoardEntityObject) => bo.board_id === currentBoard?.board_id && bo.worktree_id)
        .map((bo: BoardEntityObject) => worktreeById.get(bo.worktree_id!))
        .filter((wt): wt is Worktree => wt !== undefined),
    [boardObjectById, currentBoard?.board_id, worktreeById]
  );

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

  // Two separately memoized context values so that high-frequency live
  // updates (sessions / worktrees / boards / board-objects / comments)
  // don't invalidate the slow-moving entity context that SessionPanel etc.
  // subscribe to. See AppDataContext for the rationale.
  const appEntityDataValue = useMemo(
    () => ({
      repoById,
      userById,
      mcpServerById,
      userAuthenticatedMcpServerIds,
    }),
    [repoById, userById, mcpServerById, userAuthenticatedMcpServerIds]
  );

  const appLiveDataValue = useMemo(
    () => ({
      sessionById,
      worktreeById,
      sessionsByWorktree,
    }),
    [sessionById, worktreeById, sessionsByWorktree]
  );

  // Web terminal is gated by both the instance-level feature flag and the
  // user's role (`WEB_TERMINAL_MIN_ROLE`, shared with TerminalModal so the
  // threshold lives in one place). When disabled, we pass `undefined` so
  // consumers (WorktreeCard, SessionPanel, EventStreamPanel) can hide their
  // terminal buttons via `{onOpenTerminal && ...}`.
  const canOpenTerminal = webTerminalEnabled && hasMinimumRole(user?.role, WEB_TERMINAL_MIN_ROLE);

  // Memoize AppActionsContext value with useCallback-wrapped handlers
  const appActionsValue = useMemo(
    () => ({
      onSendPrompt,
      onFork: onForkSession,
      onBtwFork: onBtwForkSession,
      onSubsession: onSpawnSession,
      onUpdateSession,
      onDeleteSession,
      onPermissionDecision: handlePermissionDecision,
      onStartEnvironment,
      onStopEnvironment,
      onNukeEnvironment,
      onViewLogs: (worktreeId: string) => setLogsModalWorktreeId(worktreeId),
      onOpenSettings: (sessionId: string) => setSessionSettingsId(sessionId),
      onOpenWorktree: (worktreeId: string, tab?: WorktreeModalTab) => {
        setWorktreeModalWorktreeId(worktreeId);
        setWorktreeModalTab(tab);
      },
      onOpenTerminal: canOpenTerminal ? handleOpenTerminal : undefined,
    }),
    [
      onSendPrompt,
      onForkSession,
      onBtwForkSession,
      onSpawnSession,
      onUpdateSession,
      onDeleteSession,
      handlePermissionDecision,
      onStartEnvironment,
      onStopEnvironment,
      onNukeEnvironment,
      handleOpenTerminal,
      canOpenTerminal,
    ]
  );

  return (
    <AppEntityDataProvider value={appEntityDataValue}>
      <AppLiveDataProvider value={appLiveDataValue}>
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
                if (effectiveSelectedSessionId) {
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
              boardById={boardById}
              onUserClick={(
                userId: string,
                boardId?: BoardID,
                cursor?: { x: number; y: number }
              ) => {
                // Navigate to the user's board
                if (boardId) {
                  setCurrentBoardId(boardId);
                  // TODO: If cursor position is provided, we could pan to that position
                  // This would require exposing a method on SessionCanvasRef
                }
              }}
              instanceLabel={instanceLabel}
              recentBoards={recentBoards}
              instanceDescription={instanceDescription}
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
                  id="comments-panel"
                  order={1}
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
                      currentUserId={user?.user_id || 'unknown'}
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
                  id="content-panel"
                  order={2}
                  defaultSize={commentsPanelCollapsed ? 100 : 100 - commentsPanelSize}
                  minSize={40}
                >
                  <PanelGroup
                    id="canvas-session"
                    direction="horizontal"
                    style={{ flex: 1 }}
                    onLayout={(sizes) => {
                      // Save right panel size when user resizes (only when panel is open)
                      if (effectiveSelectedSessionId && sizes.length === 2) {
                        setSessionPanelSize(sizes[1]);
                      }
                    }}
                  >
                    <Panel
                      id="canvas-panel"
                      order={1}
                      defaultSize={effectiveSelectedSessionId ? 100 - sessionPanelSize : 100}
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
                          cardById={cardById}
                          currentUserId={user?.user_id}
                          selectedSessionId={effectiveSelectedSessionId}
                          availableAgents={availableAgents}
                          mcpServerById={mcpServerById}
                          sessionMcpServerIds={sessionMcpServerIds}
                          onSessionClick={handleSessionClick}
                          onSessionUpdate={onUpdateSession}
                          onSessionDelete={onDeleteSession}
                          onForkSession={onForkSession}
                          onSpawnSession={onSpawnSession}
                          onUpdateSessionMcpServers={onUpdateSessionMcpServers}
                          onOpenSettings={setSessionSettingsId}
                          onCreateSessionForWorktree={setNewSessionWorktreeId}
                          onOpenWorktree={setWorktreeModalWorktreeId}
                          onArchiveOrDeleteWorktree={onArchiveOrDeleteWorktree}
                          onOpenTerminal={canOpenTerminal ? handleOpenTerminal : undefined}
                          onStartEnvironment={onStartEnvironment}
                          onStopEnvironment={onStopEnvironment}
                          onViewLogs={setLogsModalWorktreeId}
                          onNukeEnvironment={onNukeEnvironment}
                          onOpenCommentsPanel={handleOpenCommentsPanel}
                          onCommentHover={setHoveredCommentId}
                          onCommentSelect={handleCommentSelect}
                        />
                        <NewSessionButton
                          onClick={() => {
                            const center = sessionCanvasRef.current?.getViewportCenter();
                            setNewWorktreeDefaultPosition(center || null);
                            setCreateDialogOpen(true);
                          }}
                        />
                      </div>
                    </Panel>
                    {(effectiveSelectedSessionId || !eventStreamPanelCollapsed) && (
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
                        <Panel
                          id="session-panel"
                          order={2}
                          defaultSize={sessionPanelSize}
                          minSize={15}
                          maxSize={75}
                        >
                          {effectiveSelectedSessionId ? (
                            <SessionPanel
                              client={client}
                              session={selectedSession}
                              worktree={selectedSessionWorktree}
                              currentUserId={user?.user_id}
                              sessionMcpServerIds={
                                sessionMcpServerIds.get(effectiveSelectedSessionId) ??
                                EMPTY_STRING_ARRAY
                              }
                              open={!!effectiveSelectedSessionId}
                              onClose={handleCloseSessionPanel}
                            />
                          ) : (
                            <EventStreamPanel
                              collapsed={false}
                              onToggleCollapse={() => setEventStreamPanelCollapsed(true)}
                              events={events}
                              onClear={clearEvents}
                              currentUserId={user?.user_id}
                              selectedSessionId={effectiveSelectedSessionId}
                              currentBoard={currentBoard}
                              client={client}
                              worktreeActions={{
                                onSessionClick: handleSessionClick,
                                onCreateSession: (worktreeId) =>
                                  setNewSessionWorktreeId(worktreeId),
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
            {/* Invisible mount of antd Upload so its CSS-in-JS styles stay
              registered even after the SessionPanel (which contains FileUpload)
              unmounts. Without this, antd GC's the Upload CSS on panel close. */}
            <Upload
              style={{ display: 'none' }}
              openFileDialogOnClick={false}
              showUploadList={false}
            />
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
              cardById={cardById}
              cardTypeById={cardTypeById}
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
              onArchiveBoard={onArchiveBoard}
              onUnarchiveBoard={onUnarchiveBoard}
              onCreateRepo={onCreateRepo}
              onCreateLocalRepo={onCreateLocalRepo}
              onUpdateRepo={onUpdateRepo}
              onDeleteRepo={onDeleteRepo}
              onArchiveOrDeleteWorktree={onArchiveOrDeleteWorktree}
              onUnarchiveWorktree={onUnarchiveWorktree}
              onUpdateWorktree={onUpdateWorktree}
              onCreateWorktree={onCreateWorktree}
              onStartEnvironment={onStartEnvironment}
              onStopEnvironment={onStopEnvironment}
              onCreateUser={onCreateUser}
              onUpdateUser={onUpdateUser}
              onDeleteUser={onDeleteUser}
              onCreateMCPServer={onCreateMCPServer}
              onDeleteMCPServer={onDeleteMCPServer}
              gatewayChannelById={gatewayChannelById}
              onCreateGatewayChannel={onCreateGatewayChannel}
              onUpdateGatewayChannel={onUpdateGatewayChannel}
              onDeleteGatewayChannel={onDeleteGatewayChannel}
              artifactById={artifactById}
              onUpdateArtifact={onUpdateArtifact}
              onDeleteArtifact={onDeleteArtifact}
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
                onUpdateSessionEnvSelections={onUpdateSessionEnvSelections}
                client={client}
                currentUser={user}
              />
            )}
            <WorktreeModal
              open={!!worktreeModalWorktreeId}
              onClose={() => {
                setWorktreeModalWorktreeId(null);
                setWorktreeModalTab(undefined);
              }}
              defaultTab={worktreeModalTab}
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
              onSessionClick={handleSessionClick}
              onExecuteScheduleNow={onExecuteScheduleNow}
            />
            <WorktreeListDrawer
              open={listDrawerOpen}
              onClose={() => setListDrawerOpen(false)}
              boards={mapToArray(boardById)}
              currentBoardId={currentBoardId}
              onBoardChange={setCurrentBoardId}
              sessionsByWorktree={sessionsByWorktree}
              worktreeById={worktreeById}
              repoById={repoById}
              onSessionClick={handleSessionClick}
            />
            <TerminalModal
              open={terminalOpen}
              onClose={handleCloseTerminal}
              client={client}
              user={user}
              worktreeId={terminalWorktreeId}
              initialCommands={terminalCommands}
            />
            <CreateDialog
              open={createDialogOpen}
              onClose={() => {
                setCreateDialogOpen(false);
                setNewWorktreeDefaultPosition(null);
              }}
              repoById={repoById}
              boardById={boardById}
              currentBoardId={currentBoardId}
              defaultPosition={newWorktreeDefaultPosition || undefined}
              onCreateWorktree={handleCreateWorktree}
              onCreateBoard={(board) => onCreateBoard?.(board)}
              onCreateRepo={(data) => onCreateRepo?.(data)}
              onCreateLocalRepo={(data) => onCreateLocalRepo?.(data)}
              onCreateAssistant={handleCreateAssistant}
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
              client={client}
              onUpdate={onUpdateUser}
            />
          </Layout>
        </AppActionsProvider>
      </AppLiveDataProvider>
    </AppEntityDataProvider>
  );
};
