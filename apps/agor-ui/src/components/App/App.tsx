import type {
  AgorClient,
  Artifact,
  Board,
  BoardComment,
  BoardEntityObject,
  BoardID,
  Branch,
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
} from '@agor-live/client';
import { hasMinimumRole, PermissionScope } from '@agor-live/client';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { Layout, Tooltip, Upload } from 'antd';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type ImperativePanelHandle,
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from 'react-resizable-panels';
import { useLocation, useParams } from 'react-router-dom';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import { mapToArray } from '@/utils/mapHelpers';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { AppEntityDataProvider, AppLiveDataProvider } from '../../contexts/AppDataContext';
import { useRegisterBoardSwitcher } from '../../contexts/CanvasNavigationContext';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { useBoardTitle } from '../../hooks/useBoardTitle';
import { useEventStream } from '../../hooks/useEventStream';
import { useFaviconStatus } from '../../hooks/useFaviconStatus';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useRecentBoards } from '../../hooks/useRecentBoards';
import { useSettingsRoute } from '../../hooks/useSettingsRoute';
import { useTaskCompletionChime } from '../../hooks/useTaskCompletionChime';
import { type ActiveUrlTarget, useUrlState } from '../../hooks/useUrlState';
import { useUserLocalStorage } from '../../hooks/useUserLocalStorage';
import type { AgenticToolOption } from '../../types';
import { buildAssistantBootstrapPrompt } from '../../utils/assistantBootstrapPrompt';
import { createAssistantBranch } from '../../utils/assistantCreation';
import { initializeAudioOnInteraction } from '../../utils/audio';
import { useThemedMessage } from '../../utils/message';
import { hasExplicitEntityRouteTarget } from '../../utils/routeTargets';
import { startAssistantBootstrapSession } from '../../utils/startAssistantBootstrapSession';
import { AppHeader } from '../AppHeader';
import type { BoardAssistantPanelTab } from '../BoardAssistantPanel';
import { BoardAssistantPanel } from '../BoardAssistantPanel';
import { BranchModal, type BranchModalTab } from '../BranchModal';
import type { BranchUpdate } from '../BranchModal/tabs/GeneralTab';
import { CreateDialog, type CreateDialogProgress } from '../CreateDialog';
import type { AssistantTabResult } from '../CreateDialog/tabs/AssistantTab';
import type { BranchTabConfig } from '../CreateDialog/tabs/BranchTab';
import { EnvironmentLogsModal } from '../EnvironmentLogsModal';
import { EventStreamPanel } from '../EventStreamPanel';
import { HomePage } from '../HomePage';
import { NewSessionButton } from '../NewSessionButton';
import { type NewSessionConfig, NewSessionModal } from '../NewSessionModal';
import { SessionCanvas, type SessionCanvasRef } from '../SessionCanvas';
import { SessionPanel } from '../SessionPanel';
import { SessionSettingsModal } from '../SessionSettingsModal';
import { SettingsModal, UserSettingsModal } from '../SettingsModal';
import { TerminalModal, WEB_TERMINAL_MIN_ROLE } from '../TerminalModal';
import { ThemeEditorModal } from '../ThemeEditorModal';
import { getShowCommentsPanelState, getToggleBoardPanelState } from './boardPanelActions';

const { Content } = Layout;

/** Lives inside CanvasNavigationProvider so cross-board recenter calls can
 *  ask App to switch boards. Renders nothing. */
const BoardSwitcherBridge: React.FC<{ setCurrentBoardId: (id: string) => void }> = ({
  setCurrentBoardId,
}) => {
  useRegisterBoardSwitcher(setCurrentBoardId);
  return null;
};

export interface AppProps {
  client: AgorClient | null;
  user?: User | null;
  connected?: boolean;
  connecting?: boolean;
  sessionById: Map<string, Session>; // O(1) lookups by session_id - efficient, stable references
  sessionsByBranch: Map<string, Session[]>; // O(1) branch-scoped filtering
  availableAgents: AgenticToolOption[];
  boardById: Map<string, Board>; // Map-based board storage
  boardObjectById: Map<string, BoardEntityObject>; // Map-based board object storage
  boardObjectsByBoardId: Map<string, BoardEntityObject[]>;
  commentById: Map<string, BoardComment>; // Map-based comment storage
  cardById: Map<string, CardWithType>; // Map-based card storage
  cardTypeById: Map<string, CardType>; // Map-based card type storage
  repoById: Map<string, Repo>; // Map-based repo storage
  branchById: Map<string, Branch>; // Efficient branch lookups
  userById: Map<string, User>; // Map-based user storage
  mcpServerById: Map<string, MCPServer>; // Map-based MCP server storage
  sessionMcpServerIds: Map<string, string[]>; // Map-based session-MCP relationships
  userAuthenticatedMcpServerIds: Set<string>; // Per-user OAuth auth status
  initialBoardId?: string;
  openSettingsTab?: string | null; // Open settings modal to a specific tab
  onSettingsClose?: () => void; // Called when settings modal closes
  openUserSettings?: boolean; // Open user settings modal directly (e.g., from onboarding)
  onUserSettingsClose?: () => void; // Called when user settings modal closes
  onRestartOnboarding?: () => void | Promise<void>;
  openNewBranchModal?: boolean; // Open new branch modal
  onNewBranchModalClose?: () => void; // Called when new branch modal closes
  suppressLeftPanel?: boolean; // Temporarily hide the assistant/comments panel behind modal-first flows
  onCreateSession?: (config: NewSessionConfig, boardId: string) => Promise<string | null>;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onBtwForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onSendPrompt?: (sessionId: string, prompt: string, permissionMode?: PermissionMode) => void;
  onUpdateSession?: (sessionId: string, updates: Partial<Session>) => void;
  onDeleteSession?: (sessionId: string) => void;
  onCreateBoard?: (board: Partial<Board>) => Promise<Board | null>;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void;
  onDeleteBoard?: (boardId: string) => void;
  onArchiveBoard?: (boardId: string) => void;
  onUnarchiveBoard?: (boardId: string) => void;
  onCreateRepo?: (data: CreateRepoRequest) => void | Promise<void>;
  onCreateLocalRepo?: (data: CreateLocalRepoRequest) => void | Promise<void>;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onDeleteRepo?: (repoId: string, cleanup: boolean) => void;
  onArchiveOrDeleteBranch?: (
    branchId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onUnarchiveBranch?: (branchId: string, options?: { boardId?: string }) => void;
  onUpdateBranch?: (branchId: string, updates: BranchUpdate) => void | Promise<void>;
  onCreateBranch?: (
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
      boardId?: string;
      custom_context?: Record<string, unknown>;
      notes?: string | null;
      position?: { x: number; y: number };
      storage_mode?: 'worktree' | 'clone';
      clone_depth?: number;
    }
  ) => Promise<Branch | null>;
  onStartEnvironment?: (branchId: string) => void;
  onStopEnvironment?: (branchId: string) => void;
  onNukeEnvironment?: (branchId: string) => void;
  onExecuteScheduleNow?: (branchId: string) => Promise<void>;
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
  branchStorageConfig?: BranchStorageConfig;
}

// Stable empty-array sentinel: keeps prop refs equal across renders for the
// common no-MCP case so that downstream React.memo bailouts are not defeated.
// Frozen at runtime; the consuming components only read it.
const EMPTY_STRING_ARRAY: string[] = Object.freeze([] as string[]) as string[];
const EMPTY_BOARD_OBJECTS: BoardEntityObject[] = Object.freeze(
  [] as BoardEntityObject[]
) as BoardEntityObject[];

// 320px keeps the three left-panel tabs (Assistant / All sessions / Comments)
// on one readable line with Ant's tab padding at the 768px desktop breakpoint.
const LEFT_PANEL_MIN_WIDTH_PX = 320;
const LEFT_PANEL_MAX_SIZE_PERCENT = 45;
const LEFT_PANEL_TOGGLE_HIT_SIZE_PX = 44;
const LEFT_PANEL_TOGGLE_KNOB_SIZE_PX = 30;

const getLeftPanelMinSizePercent = (viewportWidth: number) =>
  Math.min(LEFT_PANEL_MAX_SIZE_PERCENT, (LEFT_PANEL_MIN_WIDTH_PX / viewportWidth) * 100);

const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// Freeze a callback's identity for the component's lifetime while always
// invoking the latest implementation. Several action props arrive from the
// parent (`AppContent`) as plain consts that get a fresh identity on every
// store-driven re-render. Passing them straight to the memoized SessionCanvas
// would defeat its `React.memo` (and the inner BranchNode / `initialNodes`
// memoization) on every live patch. The wrapper's identity is stable; a ref
// keeps it delegating to the current impl, so behavior is unchanged. Preserves
// `undefined` so optional handlers stay absent (no spurious enabled UI).
function useStableCallback<TFn extends (...args: never[]) => unknown>(
  callback: TFn | undefined
): TFn | undefined {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  const stable = useCallback(((...args: never[]) => callbackRef.current?.(...args)) as TFn, []);
  return callback ? stable : undefined;
}

export const App: React.FC<AppProps> = ({
  client,
  user,
  connected = false,
  connecting = false,
  sessionById,
  sessionsByBranch,
  availableAgents,
  boardById,
  boardObjectById,
  boardObjectsByBoardId,
  commentById,
  cardById,
  cardTypeById,
  repoById,
  branchById,
  userById,
  mcpServerById,
  sessionMcpServerIds,
  userAuthenticatedMcpServerIds,
  initialBoardId,
  openSettingsTab,
  onSettingsClose,
  openUserSettings,
  onUserSettingsClose,
  openNewBranchModal,
  onNewBranchModalClose,
  suppressLeftPanel = false,
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
  onArchiveOrDeleteBranch,
  onUnarchiveBranch,
  onUpdateBranch,
  onCreateBranch,
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
  onRestartOnboarding,
  instanceLabel,
  instanceDescription,
  webTerminalEnabled = false,
  branchStorageConfig,
}) => {
  const { showWarning } = useThemedMessage();
  const location = useLocation();
  const routeParams = useParams<{
    sessionShortId?: string;
    branchShortId?: string;
    artifactShortId?: string;
  }>();
  const isRootHomePath = location.pathname === '/';
  const hasExplicitEntityTarget = hasExplicitEntityRouteTarget(routeParams);
  const [pendingHomeNavigation, setPendingHomeNavigation] = useState(false);
  const sessionCanvasRef = useRef<SessionCanvasRef>(null);
  const [newSessionBranchId, setNewSessionBranchId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDialogDefaultTab, setCreateDialogDefaultTab] = useState<
    'branch' | 'assistant' | 'board' | 'repository'
  >('assistant');
  const [newBranchDefaultPosition, setNewBranchDefaultPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  // Active URL deep-link target (branch or artifact). Folds into the
  // unified dashed "selected" outline alongside `selectedSessionId` —
  // both answer "what am I looking at right now?" so they share one
  // visual.
  const [activeUrlTarget, setActiveUrlTarget] = useState<ActiveUrlTarget | null>(null);
  const activeUrlTargetBranchId = activeUrlTarget?.kind === 'branch' ? activeUrlTarget.id : null;
  const activeUrlTargetArtifactId =
    activeUrlTarget?.kind === 'artifact' ? activeUrlTarget.id : null;

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
    () =>
      !isRootHomePath &&
      !pendingHomeNavigation &&
      selectedSessionId &&
      sessionById.has(selectedSessionId)
        ? selectedSessionId
        : null,
    [isRootHomePath, pendingHomeNavigation, selectedSessionId, sessionById]
  );

  const [leftPanelTab, setLeftPanelTab] = useState<BoardAssistantPanelTab>('assistant');
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const leftPanelMinSize = useMemo(
    () => getLeftPanelMinSizePercent(viewportWidth),
    [viewportWidth]
  );

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

  // Initialize current board only from explicit route/bootstrap state. Home (`/`)
  // is a valid no-board route, so do not auto-select localStorage/first board.
  const [currentBoardId, setCurrentBoardIdInternal] = useState(() => initialBoardId || '');

  // Initialize comments panel state from localStorage (collapsed by default)
  const [commentsPanelCollapsed, setCommentsPanelCollapsed] = useLocalStorage<boolean>(
    'agor:commentsPanelCollapsed',
    false
  );

  // Left panel size persistence (percentage of available width), scoped per user.
  const [commentsPanelSize, setCommentsPanelSize] = useUserLocalStorage<number>(
    user?.user_id,
    'panel:left:size',
    24
  );

  const currentBoard = boardById.get(currentBoardId);
  const isHomeSurface = (isRootHomePath || pendingHomeNavigation) && !hasExplicitEntityTarget;
  const headerBoardId = isHomeSurface ? '' : currentBoardId;
  const headerBoard = isHomeSurface ? undefined : currentBoard;

  // Home is route-authoritative. Do not clear board/session state while the
  // old `/b/...` URL is still active — that creates a transient no-board
  // canvas render. Instead, render Home immediately via `pendingHomeNavigation`
  // during the route transition, then clean stale board/session state only once
  // the `/` route has committed. Layout timing keeps the header/board picker
  // from painting stale board identity on Home.
  useLayoutEffect(() => {
    if (!isRootHomePath || hasExplicitEntityTarget) return;
    if (currentBoardId) setCurrentBoardIdInternal('');
    if (selectedSessionId) setSelectedSessionId(null);
    if (activeUrlTarget) setActiveUrlTarget(null);
    if (pendingHomeNavigation) setPendingHomeNavigation(false);
  }, [
    activeUrlTarget,
    currentBoardId,
    hasExplicitEntityTarget,
    isRootHomePath,
    pendingHomeNavigation,
    selectedSessionId,
  ]);

  const leftPanelCollapsed = commentsPanelCollapsed || suppressLeftPanel || isHomeSurface;

  // Ref for programmatically controlling the comments panel
  const commentsPanelRef = useRef<ImperativePanelHandle>(null);
  const effectiveCommentsPanelSize = clampPercent(
    commentsPanelSize,
    leftPanelMinSize,
    LEFT_PANEL_MAX_SIZE_PERCENT
  );

  // Session panel size persistence (percentage of available width), scoped per user.
  const [sessionPanelSize, setSessionPanelSize] = useUserLocalStorage<number>(
    user?.user_id,
    'panel:right:size',
    50
  );

  const effectiveSessionPanelSize = clampPercent(sessionPanelSize, 15, 75);
  const sessionPanelRef = useRef<ImperativePanelHandle>(null);
  const leftPanelResizeDraggingRef = useRef(false);
  const rightPanelResizeDraggingRef = useRef(false);

  // Comment highlight state (hover and sticky selection)
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);

  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalCommands, setTerminalCommands] = useState<string[]>([]);
  const [terminalBranchId, setTerminalBranchId] = useState<string | undefined>(undefined);
  const [sessionSettingsId, setSessionSettingsId] = useState<string | null>(null);
  const [branchModalBranchId, setBranchModalBranchId] = useState<string | null>(null);
  const [branchModalTab, setBranchModalTab] = useState<BranchModalTab | undefined>(undefined);
  const [logsModalBranchId, setLogsModalBranchId] = useState<string | null>(null);
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);

  // Initialize event stream panel state from localStorage (collapsed by default)
  const [eventStreamPanelCollapsed, setEventStreamPanelCollapsed] = useLocalStorage<boolean>(
    'agor:eventStreamPanelCollapsed',
    true
  );

  // Recent-board visit tracking + the id list HomePage consumes. AppHeader owns
  // its own pill derivation from the store (so it isn't fed an unstable array),
  // and the localStorage-backed recents list keeps both in sync.
  const { recentBoardIds, trackBoardVisit } = useRecentBoards(
    mapToArray(boardById),
    currentBoardId
  );

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

  // Programmatically collapse/expand the left panel when toggle/suppression state changes
  useEffect(() => {
    if (commentsPanelRef.current) {
      if (leftPanelCollapsed) {
        commentsPanelRef.current.collapse();
      } else {
        commentsPanelRef.current.expand();
        commentsPanelRef.current.resize(effectiveCommentsPanelSize);
      }
    }
  }, [effectiveCommentsPanelSize, leftPanelCollapsed]);

  useEffect(() => {
    if (sessionPanelRef.current && (effectiveSelectedSessionId || !eventStreamPanelCollapsed)) {
      sessionPanelRef.current.resize(effectiveSessionPanelSize);
    }
  }, [effectiveSelectedSessionId, effectiveSessionPanelSize, eventStreamPanelCollapsed]);

  // URL state synchronization - bidirectional sync between URL and state
  useUrlState({
    currentBoardId,
    currentSessionId: effectiveSelectedSessionId,
    boardById,
    sessionById,
    branchById,
    artifactById,
    onBoardChange: (boardId) => {
      setCurrentBoardIdInternal(boardId);
    },
    onSessionChange: (sessionId) => {
      setSelectedSessionId(sessionId);
    },
    onActiveUrlTargetChange: setActiveUrlTarget,
  });

  // Central navigation API. Every deliberate "go to X" call site routes
  // through this so the URL stays the single source of truth and the back
  // button restores prior board+session+camera. The hook reads live data
  // via refs internally so its function identities stay stable across
  // socket churn — important because they flow into memoized children.
  const navigation = useAppNavigation({
    boardById,
    sessionById,
    branchById,
    artifactById,
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

  // If the stored board no longer exists (deleted/archived), fall back to the
  // first board. Distinguish the two reasons `boardById` can be empty:
  //   - Disconnected and data was never loaded, or was momentarily wiped by a
  //     stale upstream effect → treat as transient, keep the id sticky so the
  //     `/b/<id>` URL survives.
  //   - Connected with an authoritative empty set (user deleted last board) →
  //     clear the selection so we stop pointing at a tombstone.
  useEffect(() => {
    if (boardById.size === 0) {
      if (!connected) return;
      if (currentBoardId) setCurrentBoardId('');
      return;
    }
    if (currentBoardId && !boardById.has(currentBoardId)) {
      const fallback = mapToArray(boardById)[0]?.board_id || '';
      setCurrentBoardId(fallback);
    }
  }, [boardById, currentBoardId, setCurrentBoardId, connected]);

  // Recalculate default position when board changes while modal is open
  // This ensures branches spawn at the center of the new board's viewport
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentBoardId is intentionally included to trigger recalculation on board switch
  useEffect(() => {
    if (createDialogOpen) {
      const center = sessionCanvasRef.current?.getViewportCenter();
      setNewBranchDefaultPosition(center || null);
    }
  }, [currentBoardId, createDialogOpen]);

  const currentBoardObjects = useMemo(
    () =>
      currentBoardId
        ? boardObjectsByBoardId.get(currentBoardId) || EMPTY_BOARD_OBJECTS
        : EMPTY_BOARD_OBJECTS,
    [boardObjectsByBoardId, currentBoardId]
  );

  // Update favicon based on session activity on current board
  useFaviconStatus(currentBoardId, sessionsByBranch, currentBoardObjects);

  // Check if event stream is enabled in user preferences (default: true)
  const eventStreamEnabled = user?.preferences?.eventStream?.enabled ?? true;

  // Event stream hook - only captures events when panel is open
  const { events, clearEvents } = useEventStream({
    client,
    enabled: !eventStreamPanelCollapsed,
  });

  const handleOpenTerminal = useCallback((commands: string[] = [], branchId?: string) => {
    setTerminalCommands(commands);
    setTerminalBranchId(branchId);
    setTerminalOpen(true);
  }, []);

  const applyLeftPanelState = useCallback(
    (state: { collapsed: boolean; activeTab: BoardAssistantPanelTab }) => {
      setLeftPanelTab(state.activeTab);
      setCommentsPanelCollapsed(state.collapsed);
    },
    [setCommentsPanelCollapsed]
  );

  const handleToggleBoardPanel = useCallback(() => {
    applyLeftPanelState(
      getToggleBoardPanelState({
        collapsed: leftPanelCollapsed,
        activeTab: leftPanelTab,
      })
    );
  }, [applyLeftPanelState, leftPanelCollapsed, leftPanelTab]);

  // Stable callbacks passed into SessionCanvas. These previously lived as
  // inline arrows in JSX, which gave them a fresh identity on every App
  // render — that propagated into the canvas's `initialNodes` useMemo deps
  // and triggered a full node-list recompute on every socket event.
  const handleOpenCommentsPanel = useCallback(() => {
    applyLeftPanelState(getShowCommentsPanelState({ collapsed: true, activeTab: 'assistant' }));
  }, [applyLeftPanelState]);

  const handleCommentSelect = useCallback((commentId: string | null) => {
    // Toggle selection: if clicking same comment, deselect
    setSelectedCommentId((prev) => (prev === commentId ? null : commentId));
  }, []);

  // Stable handler so SessionPanel's React.memo bailout isn't defeated by a
  // fresh inline arrow on every App render (App re-renders on every live patch).
  // Routes through URL nav so the back button works (push, not replace).
  // With the flat entity-URL scheme there's no `closeSession` — closing
  // the panel is the same as navigating to the board we're already on.
  const handleCloseSessionPanel = useCallback(() => {
    if (currentBoardId) navigation.goToBoard(currentBoardId);
  }, [navigation, currentBoardId]);

  const handleCloseTerminal = () => {
    setTerminalOpen(false);
    setTerminalCommands([]);
    setTerminalBranchId(undefined);
  };

  const handleCreateSession = async (config: NewSessionConfig) => {
    const sessionId = await onCreateSession?.(config, currentBoardId);
    setNewSessionBranchId(null);

    // Route through the URL so useUrlState owns selection — setting
    // selectedSessionId directly raced with the cleanup effect (and the
    // state→URL self-heal) before the socket `created` event arrived.
    if (sessionId) {
      navigation.goToSession(sessionId);
    }
  };

  const handleCreateBranch = async (config: BranchTabConfig) => {
    // Thread board placement (boardId + position) through the create
    // call so it lands atomically. The previous shape did a follow-up
    // PATCH for board_id and dropped position entirely — the API already
    // accepts both at create time, so the patch is redundant and the
    // dropped position made the BranchTab `defaultPosition` plumbing a
    // no-op.
    const branch = await onCreateBranch?.(config.repoId, {
      name: config.name,
      ref: config.ref,
      refType: config.refType,
      createBranch: config.createBranch,
      sourceBranch: config.sourceBranch,
      pullLatest: config.pullLatest,
      issue_url: config.issue_url,
      pull_request_url: config.pull_request_url,
      ...(config.board_id ? { boardId: config.board_id } : {}),
      ...(config.position ? { position: config.position } : {}),
      ...(config.storage_mode ? { storage_mode: config.storage_mode } : {}),
      ...(config.clone_depth !== undefined ? { clone_depth: config.clone_depth } : {}),
    });

    setCreateDialogOpen(false);

    // Mirror handleCreateSession: route through the URL so useUrlState
    // owns selection. The just-created branch may not be in branchById
    // yet (socket `created` event still in flight) — goToBranch pushes
    // `/w/<short>/` unconditionally and useUrlState's URL→state effect
    // resolves the branch on a subsequent render to switch boards (if
    // needed) and recenter the canvas.
    if (branch) {
      navigation.goToBranch(branch.branch_id);
    }
  };

  const handleCreateBoardFromDialog = async (board: Partial<Board>) => {
    if (!onCreateBoard) return;
    const created = await onCreateBoard(board);
    // Boards have their own URL (/b/<slug-or-short>/) — switch to the
    // new board after creation so the user lands on the empty canvas
    // they're about to populate. Same intent as goToBranch/goToSession
    // after their respective creates.
    if (created?.board_id) {
      navigation.goToBoard(created.board_id);
    }
  };

  const handleCreateAssistant = async (
    result: AssistantTabResult,
    progress?: CreateDialogProgress
  ) => {
    const repoId = result.repoId;
    if (!repoId || !onCreateBranch || !onUpdateBranch) {
      throw new Error('Missing repository or branch creation handler for assistant creation.');
    }

    progress?.onStatusChange?.('Creating assistant branch…');

    const branch = await createAssistantBranch(
      {
        displayName: result.displayName,
        description: result.description,
        emoji: result.emoji,
        repoId,
        branchName: result.branchName,
        sourceBranch: result.sourceBranch,
      },
      { client, repoById, onCreateBranch, onUpdateBranch }
    );

    if (!branch) {
      throw new Error(
        'Assistant branch could not be created. Please check the branch details and try again.'
      );
    }

    const sessionConfig: NewSessionConfig = {
      branch_id: branch.branch_id,
      agent: result.agent,
      title: `${result.emoji ? `${result.emoji} ` : ''}${result.displayName} bootstrap`,
      initialPrompt: buildAssistantBootstrapPrompt({
        displayName: result.displayName,
        emoji: result.emoji,
        description: result.description,
        userName: user?.name,
        userEmail: user?.email,
      }),
      modelConfig: result.modelConfig,
      effort: result.effort,
      mcpServerIds: result.mcpServerIds,
      permissionMode: result.permissionMode,
      codexSandboxMode: result.codexSandboxMode,
      codexApprovalPolicy: result.codexApprovalPolicy,
      codexNetworkAccess: result.codexNetworkAccess,
    };

    try {
      if (!onCreateSession) {
        throw new Error('Missing session creation handler.');
      }
      const sessionId = await startAssistantBootstrapSession({
        client,
        branchId: branch.branch_id,
        boardId: branch.board_id || currentBoardId,
        sessionConfig,
        onCreateSession,
        onStatusChange: progress?.onStatusChange,
      });
      navigation.goToSession(sessionId);
      return;
    } catch (error) {
      console.error('Assistant session bootstrap failed:', error);
      showWarning(
        `Assistant branch was created, but the first session could not start: ${
          error instanceof Error ? error.message : String(error)
        }. Opening the branch instead.`,
        { key: 'assistant-bootstrap-session', duration: 8 }
      );
    }

    // If the branch was created but the session failed, still take the user
    // to the assistant branch so the created assistant is not lost. The
    // top-level create-session handler surfaces the failure toast.
    progress?.onStatusChange?.('Opening assistant branch…');
    navigation.goToBranch(branch.branch_id);
  };

  // Refs for the data `handleSessionClick` reads. Using refs (vs
  // useCallback deps) keeps the handler's identity stable across
  // socket-driven map churn — important because it flows through
  // SessionCanvas → initialNodes deps and a flipping identity would
  // cascade re-renders into every BranchCard. Inline `useRef(...)`
  // rather than going through a helper so biome's
  // `useExhaustiveDependencies` heuristic recognizes the refs as
  // stable and doesn't false-positive on `.current.get` reads.
  const sessionByIdRef = useRef(sessionById);
  sessionByIdRef.current = sessionById;
  const branchByIdRef = useRef(branchById);
  branchByIdRef.current = branchById;

  const handleSessionClick = useCallback(
    (sessionId: string) => {
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

      const branch = session?.branch_id ? branchByIdRef.current.get(session.branch_id) : undefined;
      if (client && branch?.needs_attention) {
        client
          .service('branches')
          .patch(branch.branch_id, { needs_attention: false })
          .catch(() => {});
      }

      // Route through URL nav so deep links / back-forward / cross-board
      // recenter all funnel through the same pipe. setSelectedSessionId
      // happens via useUrlState's onSessionChange callback.
      navigation.goToSession(sessionId);
    },
    [client, navigation]
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
  const selectedSessionBranch = selectedSession ? branchById.get(selectedSession.branch_id) : null;

  // Sync the actual state when a session disappears (for URL, localStorage, etc.).
  // The rendering already uses effectiveSelectedSessionId so this is mostly
  // cosmetic, but URL cleanup is load-bearing: if the address bar remains on
  // `/s/<id>/` after archiving the selected branch/session, the direct
  // archived-session fallback treats that stale URL like an explicit deep link
  // and can rehydrate the archived session into local state. Replace the route
  // with the current board before clearing selection so archive/delete closes
  // the drawer and does not resurrect the card.
  useEffect(() => {
    if (selectedSessionId && !sessionById.has(selectedSessionId)) {
      if (routeParams.sessionShortId && currentBoardId) {
        navigation.goToBoard(currentBoardId, { replace: true });
      }
      setSelectedSessionId(null);
    }
  }, [currentBoardId, navigation, routeParams.sessionShortId, selectedSessionId, sessionById]);

  const sessionSettingsSession = sessionSettingsId ? sessionById.get(sessionSettingsId) : null;
  const primaryAssistantId = currentBoard?.primary_assistant_id ?? null;
  const primaryAssistantBranch = primaryAssistantId
    ? branchById.get(primaryAssistantId)
    : undefined;
  const primaryAssistantRepo = primaryAssistantBranch
    ? repoById.get(primaryAssistantBranch.repo_id)
    : undefined;
  const primaryAssistantInaccessible = Boolean(primaryAssistantId && !primaryAssistantBranch);

  // Preserve the historical board-switch behavior now that the panel itself
  // no longer pushes a default tab into controlled parent state on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the tab when switching boards, even if the default tab string is unchanged.
  useEffect(() => {
    setLeftPanelTab(primaryAssistantInaccessible ? 'all-sessions' : 'assistant');
  }, [currentBoard?.board_id, primaryAssistantInaccessible]);

  // Update browser tab title based on current board
  useBoardTitle(currentBoard);

  // Find branch and repo for BranchModal
  const selectedBranch = branchModalBranchId ? branchById.get(branchModalBranchId) : null;
  const selectedBranchRepo = selectedBranch ? repoById.get(selectedBranch.repo_id) : null;
  const branchSessions = selectedBranch ? sessionsByBranch.get(selectedBranch.branch_id) || [] : [];

  // Find branch for NewSessionModal
  const newSessionBranch = newSessionBranchId ? branchById.get(newSessionBranchId) : null;

  // Filter branches by current board (via board_objects). Memoized so that
  // unrelated socket churn (e.g. another user's session patch) doesn't
  // produce a fresh array reference on every render — that array flows into
  // SessionCanvas's `initialNodes` deps and would otherwise cascade into
  // every BranchCard re-rendering.
  const boardBranches = useMemo(
    () =>
      currentBoardObjects
        .filter((bo: BoardEntityObject) => bo.branch_id)
        .map((bo: BoardEntityObject) => branchById.get(bo.branch_id!))
        .filter((wt): wt is Branch => wt !== undefined),
    [currentBoardObjects, branchById]
  );

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
  // updates (sessions / branches / boards / board-objects / comments)
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
      branchById,
      sessionsByBranch,
    }),
    [sessionById, branchById, sessionsByBranch]
  );

  // Web terminal is gated by both the instance-level feature flag and the
  // user's role (`WEB_TERMINAL_MIN_ROLE`, shared with TerminalModal so the
  // threshold lives in one place). When disabled, we pass `undefined` so
  // consumers (BranchCard, SessionPanel, EventStreamPanel) can hide their
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
      onViewLogs: (branchId: string) => setLogsModalBranchId(branchId),
      onOpenSettings: (sessionId: string) => setSessionSettingsId(sessionId),
      onSessionClick: handleSessionClick,
      onOpenBranch: (branchId: string, tab?: BranchModalTab) => {
        setBranchModalBranchId(branchId);
        setBranchModalTab(tab);
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
      handleSessionClick,
      handleOpenTerminal,
      canOpenTerminal,
    ]
  );

  // Stabilize the passthrough action props before they reach the memoized
  // SessionCanvas. These arrive from AppContent as plain consts (fresh identity
  // on every store-driven re-render); without freezing them, SessionCanvas's
  // React.memo would re-render on every live patch even when nothing it draws
  // changed. Every other SessionCanvas prop is already stable (memoized values,
  // useState setters, or useCallback handlers).
  const stableOnSessionUpdate = useStableCallback(onUpdateSession);
  const stableOnSessionDelete = useStableCallback(onDeleteSession);
  const stableOnForkSession = useStableCallback(onForkSession);
  const stableOnSpawnSession = useStableCallback(onSpawnSession);
  const stableOnUpdateSessionMcpServers = useStableCallback(onUpdateSessionMcpServers);
  const stableOnArchiveOrDeleteBranch = useStableCallback(onArchiveOrDeleteBranch);
  const stableOnStartEnvironment = useStableCallback(onStartEnvironment);
  const stableOnStopEnvironment = useStableCallback(onStopEnvironment);
  const stableOnNukeEnvironment = useStableCallback(onNukeEnvironment);

  // Header action handlers, frozen so the memoized AppHeader's React.memo bailout
  // isn't defeated by a fresh inline-arrow identity on every App re-render. Each
  // delegates to the latest impl via useStableCallback, so they read current
  // state (selection, panel, board) at call time without re-rendering the header.
  const handleHomeClick = useStableCallback(() => {
    setPendingHomeNavigation(true);
    navigation.goHome();
  });
  const handleEventStreamClick = useStableCallback(() => {
    // If a session is open, close it and reveal the event stream; otherwise
    // toggle the event stream panel.
    if (effectiveSelectedSessionId) {
      if (currentBoardId) navigation.goToBoard(currentBoardId);
      setEventStreamPanelCollapsed(false);
    } else {
      setEventStreamPanelCollapsed(!eventStreamPanelCollapsed);
    }
  });
  const handleOpenSettingsClick = useStableCallback(() => openSettings());
  const handleOpenUserSettings = useStableCallback(() => setUserSettingsOpen(true));
  const handleOpenThemeEditor = useStableCallback(() => setThemeEditorOpen(true));
  const handleHeaderUserClick = useStableCallback(
    (_userId: string, boardId?: BoardID, _cursor?: { x: number; y: number }) => {
      // Navigate to the user's board (pushes history, so the back button
      // returns to the previous board).
      if (boardId) {
        navigation.goToBoard(boardId);
      }
    }
  );
  const stableOnLogout = useStableCallback(onLogout);
  const stableOnRetryConnection = useStableCallback(onRetryConnection);

  return (
    <AppEntityDataProvider value={appEntityDataValue}>
      <AppLiveDataProvider value={appLiveDataValue}>
        <AppActionsProvider value={appActionsValue}>
          <BoardSwitcherBridge setCurrentBoardId={setCurrentBoardId} />
          <Layout style={{ height: '100vh' }}>
            <AppHeader
              user={user}
              presenceClient={client}
              currentUserId={user?.user_id}
              connected={connected}
              connecting={connecting}
              onMenuClick={handleToggleBoardPanel}
              onCommentsClick={handleOpenCommentsPanel}
              onEventStreamClick={handleEventStreamClick}
              onSettingsClick={handleOpenSettingsClick}
              onUserSettingsClick={handleOpenUserSettings}
              onThemeEditorClick={handleOpenThemeEditor}
              onLogout={stableOnLogout}
              onRetryConnection={stableOnRetryConnection}
              currentBoardName={headerBoard?.name}
              currentBoardIcon={headerBoard?.icon}
              unreadCommentsCount={
                activeComments.filter((c: BoardComment) => !c.parent_comment_id).length
              }
              eventStreamEnabled={eventStreamEnabled}
              hasUserMentions={hasUserMentions}
              currentBoardId={headerBoardId}
              onBoardChange={navigation.goToBoard}
              onHomeClick={handleHomeClick}
              onUserClick={handleHeaderUserClick}
              instanceLabel={instanceLabel}
              instanceDescription={instanceDescription}
            />
            <Content style={{ position: 'relative', overflow: 'hidden', display: 'flex' }}>
              <PanelGroup
                id="main-layout"
                direction="horizontal"
                style={{ flex: 1 }}
                onLayout={(sizes) => {
                  // Persist only user drag updates. Programmatic resizing enforces
                  // the responsive minimum without clobbering the user's desired size.
                  if (
                    !leftPanelCollapsed &&
                    leftPanelResizeDraggingRef.current &&
                    sizes.length >= 2
                  ) {
                    // Comments panel is the first panel (index 0)
                    setCommentsPanelSize(
                      clampPercent(sizes[0], leftPanelMinSize, LEFT_PANEL_MAX_SIZE_PERCENT)
                    );
                  }
                }}
              >
                <Panel
                  id="assistant-panel"
                  order={1}
                  ref={commentsPanelRef}
                  collapsible
                  defaultSize={leftPanelCollapsed ? 0 : effectiveCommentsPanelSize}
                  collapsedSize={0}
                  minSize={leftPanelCollapsed ? 0 : leftPanelMinSize}
                  maxSize={LEFT_PANEL_MAX_SIZE_PERCENT}
                  style={{ minWidth: leftPanelCollapsed ? 0 : LEFT_PANEL_MIN_WIDTH_PX }}
                >
                  {!leftPanelCollapsed && (
                    <BoardAssistantPanel
                      client={client}
                      board={currentBoard || null}
                      activeTab={leftPanelTab}
                      onTabChange={setLeftPanelTab}
                      primaryAssistantBranch={primaryAssistantBranch}
                      primaryAssistantRepo={primaryAssistantRepo}
                      primaryAssistantInaccessible={primaryAssistantInaccessible}
                      sessionsByBranch={sessionsByBranch}
                      branchById={branchById}
                      repoById={repoById}
                      userById={userById}
                      currentUserId={user?.user_id}
                      selectedSessionId={effectiveSelectedSessionId}
                      onSessionClick={handleSessionClick}
                      onCreateSession={setNewSessionBranchId}
                      onForkSession={onForkSession}
                      onSpawnSession={onSpawnSession}
                      onArchiveOrDelete={onArchiveOrDeleteBranch}
                      onOpenSettings={(branchId, tab) => {
                        setBranchModalBranchId(branchId);
                        setBranchModalTab(tab);
                      }}
                      onOpenSessionSettings={setSessionSettingsId}
                      onOpenTerminal={canOpenTerminal ? handleOpenTerminal : undefined}
                      onStartEnvironment={onStartEnvironment}
                      onStopEnvironment={onStopEnvironment}
                      onViewLogs={setLogsModalBranchId}
                      onNukeEnvironment={onNukeEnvironment}
                      onExecuteScheduleNow={onExecuteScheduleNow}
                      comments={mapToArray(commentById).filter(
                        (c: BoardComment) => c.board_id === currentBoardId
                      )}
                      boardObjects={currentBoard?.objects}
                      onSendComment={(content) => onSendComment?.(currentBoardId || '', content)}
                      onReplyComment={onReplyComment}
                      onResolveComment={onResolveComment}
                      onToggleReaction={onToggleReaction}
                      onDeleteComment={onDeleteComment}
                      hoveredCommentId={hoveredCommentId}
                      selectedCommentId={selectedCommentId}
                      onCollapse={() => setCommentsPanelCollapsed(true)}
                    />
                  )}
                </Panel>
                <PanelResizeHandle
                  style={{
                    position: 'relative',
                    width: leftPanelCollapsed ? '0px' : '4px',
                    background: 'var(--ant-color-border-secondary)',
                    cursor: leftPanelCollapsed ? 'default' : 'col-resize',
                    transition: 'background 0.2s',
                    pointerEvents: leftPanelCollapsed ? 'none' : 'auto',
                    overflow: 'visible',
                    zIndex: 10,
                  }}
                  onDragging={(isDragging) => {
                    leftPanelResizeDraggingRef.current = isDragging;
                  }}
                  onMouseEnter={(e) => {
                    if (!leftPanelCollapsed) {
                      (e.currentTarget as unknown as HTMLDivElement).style.background =
                        'var(--ant-color-primary)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!leftPanelCollapsed) {
                      (e.currentTarget as unknown as HTMLDivElement).style.background =
                        'var(--ant-color-border-secondary)';
                    }
                  }}
                />
                <Panel
                  id="content-panel"
                  order={2}
                  defaultSize={leftPanelCollapsed ? 100 : 100 - effectiveCommentsPanelSize}
                  minSize={40}
                >
                  <PanelGroup
                    id="canvas-session"
                    direction="horizontal"
                    style={{ flex: 1 }}
                    onLayout={(sizes) => {
                      // Persist only user drag updates so panel open/close and
                      // programmatic restores do not overwrite the user's preference.
                      if (
                        effectiveSelectedSessionId &&
                        rightPanelResizeDraggingRef.current &&
                        sizes.length === 2
                      ) {
                        setSessionPanelSize(clampPercent(sizes[1], 15, 75));
                      }
                    }}
                  >
                    <Panel
                      id="canvas-panel"
                      order={1}
                      defaultSize={
                        effectiveSelectedSessionId ? 100 - effectiveSessionPanelSize : 100
                      }
                      minSize={20}
                    >
                      <div style={{ position: 'relative', overflow: 'hidden', height: '100%' }}>
                        {isHomeSurface ? (
                          <HomePage
                            client={client}
                            connected={connected}
                            boardById={boardById}
                            recentBoardIds={recentBoardIds}
                            branchById={branchById}
                            repoById={repoById}
                            sessionById={sessionById}
                            sessionsByBranch={sessionsByBranch}
                            userById={userById}
                            currentUserId={user?.user_id}
                            onBoardClick={navigation.goToBoard}
                            onBranchClick={navigation.goToBranch}
                            onSessionClick={handleSessionClick}
                          />
                        ) : (
                          <SessionCanvas
                            ref={sessionCanvasRef}
                            board={currentBoard || null}
                            client={client}
                            branches={boardBranches}
                            primaryAssistantId={primaryAssistantId}
                            currentUserId={user?.user_id}
                            selectedSessionId={effectiveSelectedSessionId}
                            activeUrlTargetBranchId={activeUrlTargetBranchId}
                            activeUrlTargetArtifactId={activeUrlTargetArtifactId}
                            availableAgents={availableAgents}
                            onSessionClick={handleSessionClick}
                            onSessionUpdate={stableOnSessionUpdate}
                            onSessionDelete={stableOnSessionDelete}
                            onForkSession={stableOnForkSession}
                            onSpawnSession={stableOnSpawnSession}
                            onUpdateSessionMcpServers={stableOnUpdateSessionMcpServers}
                            onOpenSettings={setSessionSettingsId}
                            onCreateSessionForBranch={setNewSessionBranchId}
                            onOpenBranch={setBranchModalBranchId}
                            onArchiveOrDeleteBranch={stableOnArchiveOrDeleteBranch}
                            onOpenTerminal={canOpenTerminal ? handleOpenTerminal : undefined}
                            onStartEnvironment={stableOnStartEnvironment}
                            onStopEnvironment={stableOnStopEnvironment}
                            onViewLogs={setLogsModalBranchId}
                            onNukeEnvironment={stableOnNukeEnvironment}
                            onOpenCommentsPanel={handleOpenCommentsPanel}
                            onCommentHover={setHoveredCommentId}
                            onCommentSelect={handleCommentSelect}
                          />
                        )}
                        <NewSessionButton
                          onClick={() => {
                            const center = isHomeSurface
                              ? null
                              : sessionCanvasRef.current?.getViewportCenter();
                            setNewBranchDefaultPosition(center || null);
                            setCreateDialogDefaultTab('assistant');
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
                          onDragging={(isDragging) => {
                            rightPanelResizeDraggingRef.current = isDragging;
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
                          ref={sessionPanelRef}
                          defaultSize={effectiveSessionPanelSize}
                          minSize={15}
                          maxSize={75}
                        >
                          {effectiveSelectedSessionId ? (
                            <SessionPanel
                              client={client}
                              session={selectedSession}
                              branch={selectedSessionBranch}
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
                              branchActions={{
                                onSessionClick: handleSessionClick,
                                onCreateSession: (branchId) => setNewSessionBranchId(branchId),
                                onOpenSettings: (branchId) => setBranchModalBranchId(branchId),
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
              {currentBoard && (
                <Tooltip
                  title={leftPanelCollapsed ? 'Open side panel' : 'Close side panel'}
                  placement="right"
                  getPopupContainer={() => document.body}
                >
                  <button
                    type="button"
                    aria-label={leftPanelCollapsed ? 'Open side panel' : 'Close side panel'}
                    onClick={() => setCommentsPanelCollapsed(!commentsPanelCollapsed)}
                    style={{
                      position: 'absolute',
                      top: '50%',
                      left: leftPanelCollapsed ? 0 : `calc(${effectiveCommentsPanelSize}% + 2px)`,
                      transform: 'translate(-50%, -50%)',
                      width: LEFT_PANEL_TOGGLE_HIT_SIZE_PX,
                      height: LEFT_PANEL_TOGGLE_HIT_SIZE_PX,
                      padding: 0,
                      border: 0,
                      background: 'transparent',
                      cursor: 'pointer',
                      pointerEvents: 'auto',
                      zIndex: 20,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: LEFT_PANEL_TOGGLE_KNOB_SIZE_PX,
                        height: LEFT_PANEL_TOGGLE_KNOB_SIZE_PX,
                        borderRadius: '50%',
                        border: '1px solid var(--ant-color-border)',
                        background: 'var(--ant-color-bg-container)',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
                        color: 'var(--ant-color-text)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {leftPanelCollapsed ? (
                        <RightOutlined style={{ fontSize: 12 }} />
                      ) : (
                        <LeftOutlined style={{ fontSize: 12 }} />
                      )}
                    </span>
                  </button>
                </Tooltip>
              )}
            </Content>
            {/* Invisible mount of antd Upload so its CSS-in-JS styles stay
              registered even after the SessionPanel (which contains FileUpload)
              unmounts. Without this, antd GC's the Upload CSS on panel close. */}
            <Upload
              style={{ display: 'none' }}
              openFileDialogOnClick={false}
              showUploadList={false}
            />
            {newSessionBranchId && (
              <NewSessionModal
                open={true}
                onClose={() => setNewSessionBranchId(null)}
                onCreate={handleCreateSession}
                availableAgents={availableAgents}
                branchId={newSessionBranchId}
                branch={newSessionBranch || undefined}
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
              branchById={branchById}
              sessionById={sessionById}
              sessionsByBranch={sessionsByBranch}
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
              onArchiveOrDeleteBranch={onArchiveOrDeleteBranch}
              onUnarchiveBranch={onUnarchiveBranch}
              onUpdateBranch={onUpdateBranch}
              onCreateBranch={onCreateBranch}
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
              onCreateAssistant={() => {
                closeSettings();
                onSettingsClose?.();
                setNewBranchDefaultPosition(null);
                setCreateDialogDefaultTab('assistant');
                setCreateDialogOpen(true);
              }}
              branchStorageConfig={branchStorageConfig}
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
            <BranchModal
              open={!!branchModalBranchId}
              onClose={() => {
                setBranchModalBranchId(null);
                setBranchModalTab(undefined);
              }}
              defaultTab={branchModalTab}
              branch={selectedBranch || null}
              repo={selectedBranchRepo || null}
              sessions={branchSessions}
              boardById={boardById}
              mcpServerById={mcpServerById}
              client={client}
              currentUser={user}
              onUpdateBranch={onUpdateBranch}
              onUpdateRepo={onUpdateRepo}
              onArchiveOrDelete={onArchiveOrDeleteBranch}
              onOpenSettings={() => {
                setBranchModalBranchId(null);
                openSettings();
              }}
              onSessionClick={handleSessionClick}
              onExecuteScheduleNow={onExecuteScheduleNow}
            />
            <TerminalModal
              open={terminalOpen}
              onClose={handleCloseTerminal}
              client={client}
              user={user}
              branchId={terminalBranchId}
              initialCommands={terminalCommands}
            />
            <CreateDialog
              open={createDialogOpen}
              onClose={() => {
                setCreateDialogOpen(false);
                setCreateDialogDefaultTab('assistant');
                setNewBranchDefaultPosition(null);
              }}
              defaultTab={createDialogDefaultTab}
              repoById={repoById}
              boardById={boardById}
              currentBoardId={currentBoardId}
              defaultPosition={newBranchDefaultPosition || undefined}
              onCreateBranch={handleCreateBranch}
              onCreateBoard={handleCreateBoardFromDialog}
              onCreateRepo={(data) => onCreateRepo?.(data)}
              onCreateLocalRepo={(data) => onCreateLocalRepo?.(data)}
              onCreateAssistant={handleCreateAssistant}
              availableAgents={availableAgents}
              mcpServerById={mcpServerById}
              currentUser={user}
              client={client}
              branchStorageConfig={branchStorageConfig}
            />
            {logsModalBranchId && (
              <EnvironmentLogsModal
                open={!!logsModalBranchId}
                onClose={() => setLogsModalBranchId(null)}
                branch={branchById.get(logsModalBranchId)!}
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
              currentUser={user || null}
              mcpServerById={mcpServerById}
              client={client}
              onUpdate={onUpdateUser}
              onRestartOnboarding={async () => {
                setUserSettingsOpen(false);
                onUserSettingsClose?.();
                await onRestartOnboarding?.();
              }}
            />
          </Layout>
        </AppActionsProvider>
      </AppLiveDataProvider>
    </AppEntityDataProvider>
  );
};
