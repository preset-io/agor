import type {
  AgorClient,
  Artifact,
  Board,
  BoardID,
  Branch,
  CreateLocalRepoRequest,
  CreateMCPServerInput,
  CreateRepoRequest,
  CreateUserInput,
  GatewayChannel,
  PermissionMode,
  Repo,
  Session,
  SpawnConfig,
  UpdateUserInput,
  User,
} from '@agor-live/client';
import { hasMinimumRole, PermissionScope } from '@agor-live/client';
import { Layout, theme, Upload } from 'antd';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type ImperativePanelHandle,
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from 'react-resizable-panels';
import { useLocation, useParams } from 'react-router-dom';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { useRegisterBoardSwitcher } from '../../contexts/CanvasNavigationContext';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { useBoardTitle } from '../../hooks/useBoardTitle';
import { useEventStream } from '../../hooks/useEventStream';
import { useFaviconStatus } from '../../hooks/useFaviconStatus';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useRecentBoards } from '../../hooks/useRecentBoards';
import { useSettingsRoute } from '../../hooks/useSettingsRoute';
import { useStableCallback } from '../../hooks/useStableCallback';
import { useTaskCompletionChime } from '../../hooks/useTaskCompletionChime';
import { type ActiveUrlTarget, useUrlState } from '../../hooks/useUrlState';
import { useUserLocalStorage } from '../../hooks/useUserLocalStorage';
import { agorStore, shallow, useAgorStore, useStoreWithEqualityFn } from '../../store/agorStore';
import {
  makeBoardSelector,
  makeBranchesForBoardSelector,
  makeBranchSelector,
  makeCommentMentionSelector,
  makeRepoSelector,
  makeSessionExistsSelector,
  makeSessionMcpServerIdsSelector,
  makeSessionSelector,
  makeSessionsForBranchSelector,
  makeUnreadCommentCountSelector,
  selectArtifactById,
  selectBoardById,
  selectBoardCount,
  selectBranchById,
  selectFirstBoardId,
  selectSessionById,
} from '../../store/selectors';
import type { AgenticToolOption } from '../../types';
import { initializeAudioOnInteraction } from '../../utils/audio';
import { useThemedMessage } from '../../utils/message';
import { hasExplicitEntityRouteTarget } from '../../utils/routeTargets';
import { startTeammateBootstrapSession } from '../../utils/startTeammateBootstrapSession';
import { buildTeammateBootstrapPrompt } from '../../utils/teammateBootstrapPrompt';
import { createTeammateBranch } from '../../utils/teammateCreation';
import { AppHeader } from '../AppHeader';
import type { BoardTeammatePanelTab } from '../BoardTeammatePanel';
import { BoardTeammatePanel, TeammatePanelRail } from '../BoardTeammatePanel';
import { BranchModal, type BranchModalTab } from '../BranchModal';
import type { BranchUpdate } from '../BranchModal/tabs/GeneralTab';
import { CreateDialog, type CreateDialogProgress } from '../CreateDialog';
import type { BranchTabConfig } from '../CreateDialog/tabs/BranchTab';
import type { TeammateTabResult } from '../CreateDialog/tabs/TeammateTab';
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
import {
  getSelectTeammatePanelTabState,
  getShowCommentsPanelState,
  getToggleBoardPanelState,
} from './boardPanelActions';
import {
  capSessionSizeForCanvasMin,
  getContentPanelWidthPercent,
  toContentRelativePercent,
  toViewportRelativePercent,
} from './panelSizing';

const { Content } = Layout;

/** Lives inside CanvasNavigationProvider so cross-board recenter calls can
 *  ask App to switch boards. Renders nothing. */
const BoardSwitcherBridge: React.FC<{ setCurrentBoardId: (id: string) => void }> = ({
  setCurrentBoardId,
}) => {
  useRegisterBoardSwitcher(setCurrentBoardId);
  return null;
};

/** Hosts the URL⇄state sync in a null-rendering child. useUrlState must
 *  observe the whole entity maps (a deep-linked short ID resolves only once
 *  the entity streams in), so those subscriptions live here where a patch
 *  re-renders nothing instead of the whole shell. Effect-order note: as a
 *  child, these effects fire before App's own — the sync is guarded by
 *  refs/`syncingRef` and is order-insensitive within a commit. */
const UrlStateBridge: React.FC<{
  currentBoardId: string;
  currentSessionId: string | null;
  onBoardChange: (boardId: string) => void;
  onSessionChange: (sessionId: string | null) => void;
  onActiveUrlTargetChange: (target: ActiveUrlTarget | null) => void;
}> = ({
  currentBoardId,
  currentSessionId,
  onBoardChange,
  onSessionChange,
  onActiveUrlTargetChange,
}) => {
  useUrlState({
    currentBoardId,
    currentSessionId,
    boardById: useAgorStore(selectBoardById),
    sessionById: useAgorStore(selectSessionById),
    branchById: useAgorStore(selectBranchById),
    artifactById: useAgorStore(selectArtifactById),
    onBoardChange,
    onSessionChange,
    onActiveUrlTargetChange,
  });
  return null;
};

export interface AppProps {
  client: AgorClient | null;
  user?: User | null;
  connected?: boolean;
  connecting?: boolean;
  availableAgents: AgenticToolOption[];
  initialBoardId?: string;
  openSettingsTab?: string | null; // Open settings modal to a specific tab
  onSettingsClose?: () => void; // Called when settings modal closes
  openUserSettings?: boolean; // Open user settings modal directly (e.g., from onboarding)
  initialUserSettingsTab?: string; // Deep-link target tab when opening user settings
  onUserSettingsClose?: () => void; // Called when user settings modal closes
  onRestartOnboarding?: () => void | Promise<void>;
  openNewBranchModal?: boolean; // Open new branch modal
  onNewBranchModalClose?: () => void; // Called when new branch modal closes
  suppressLeftPanel?: boolean; // Temporarily hide the teammate/comments panel behind modal-first flows
  /** Rendered between AppHeader and main content (used for onboarding banners). */
  topBanner?: React.ReactNode;
  onCreateSession?: (config: NewSessionConfig, boardId: string) => Promise<string | null>;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onBtwForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onSendPrompt?: (
    sessionId: string,
    prompt: string,
    permissionMode?: PermissionMode
  ) => boolean | undefined | Promise<boolean | undefined>;
  onUpdateSession?: (sessionId: string, updates: Partial<Session>) => void;
  onDeleteSession?: (sessionId: string) => void;
  onCreateBoard?: (board: Partial<Board>) => Promise<Board | null>;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void;
  onDeleteBoard?: (boardId: string) => void;
  onArchiveBoard?: (boardId: string) => void;
  onUnarchiveBoard?: (boardId: string) => void;
  onCreateRepo?: (data: CreateRepoRequest) => unknown;
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
  onCreateGatewayChannel?: (data: Partial<GatewayChannel>) => void;
  onUpdateGatewayChannel?: (channelId: string, updates: Partial<GatewayChannel>) => void;
  onDeleteGatewayChannel?: (channelId: string) => void;
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
const EMPTY_BOARDS: Board[] = Object.freeze([] as Board[]) as Board[];
const EMPTY_SESSIONS: Session[] = Object.freeze([] as Session[]) as Session[];

// 320px keeps the three left-panel tabs (Teammate / All sessions / Comments)
// on one readable line with Ant's tab padding at the 768px desktop breakpoint.
const LEFT_PANEL_MIN_WIDTH_PX = 320;
const LEFT_PANEL_MAX_SIZE_PERCENT = 45;
const SESSION_PANEL_MIN_WIDTH_PX = 360;
const SESSION_PANEL_MAX_SIZE_PERCENT = 75;
const SESSION_PANEL_MIN_SIZE_FLOOR_PERCENT = 15;
// Matches the canvas panel's own `minSize` below — kept as one constant so
// the two cannot drift apart.
const CANVAS_MIN_SIZE_PERCENT = 20;
// Width of the persistent icon rail (TeammatePanelRail) shown in place of
// the panel when collapsed. Replaces the old 0px-collapse + floating
// reopen-knob pattern (see issue agor-cloud#123).
const LEFT_PANEL_RAIL_WIDTH_PX = 56;

const getLeftPanelMinSizePercent = (viewportWidth: number) =>
  Math.min(LEFT_PANEL_MAX_SIZE_PERCENT, (LEFT_PANEL_MIN_WIDTH_PX / viewportWidth) * 100);

const getLeftPanelRailSizePercent = (viewportWidth: number) =>
  (LEFT_PANEL_RAIL_WIDTH_PX / viewportWidth) * 100;

// Express the session panel's 360px minimum through the panel sizing system
// (a percentage of the current viewport) rather than a CSS px `minWidth`, which
// fights react-resizable-panels' percentage layout on narrow viewports.
const getSessionPanelMinSizePercent = (viewportWidth: number) =>
  Math.min(
    SESSION_PANEL_MAX_SIZE_PERCENT,
    Math.max(
      SESSION_PANEL_MIN_SIZE_FLOOR_PERCENT,
      (SESSION_PANEL_MIN_WIDTH_PX / viewportWidth) * 100
    )
  );

const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const App: React.FC<AppProps> = ({
  client,
  user,
  connected = false,
  connecting = false,
  availableAgents,
  initialBoardId,
  openSettingsTab,
  onSettingsClose,
  openUserSettings,
  initialUserSettingsTab,
  onUserSettingsClose,
  openNewBranchModal,
  onNewBranchModalClose,
  suppressLeftPanel = false,
  topBanner,
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
  onCreateGatewayChannel,
  onUpdateGatewayChannel,
  onDeleteGatewayChannel,
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
  // The always-mounted shell holds NO whole-map subscriptions. Everything it
  // needs is either a narrow per-id / derived-scalar selector below (which
  // stays quiet across unrelated entity patches), a call-time
  // `agorStore.getState()` read inside a handler, or pushed down into the
  // component that actually consumes the map (SettingsModal, UrlStateBridge).
  const { token } = theme.useToken();
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
    'branch' | 'teammate' | 'board' | 'repository'
  >('teammate');
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
  const selectedSessionExists = useAgorStore(
    useMemo(() => makeSessionExistsSelector(selectedSessionId), [selectedSessionId])
  );
  const effectiveSelectedSessionId =
    !isRootHomePath && !pendingHomeNavigation && selectedSessionId && selectedSessionExists
      ? selectedSessionId
      : null;

  const [leftPanelTab, setLeftPanelTab] = useState<BoardTeammatePanelTab>('teammate');
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Debounced: viewportWidth only feeds panel min-size percentages, so
    // re-rendering the shell on every resize tick is wasted work — the
    // trailing value is all that matters.
    let timer: number | null = null;
    const handleResize = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        setViewportWidth(window.innerWidth);
      }, 150);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const leftPanelMinSize = useMemo(
    () => getLeftPanelMinSizePercent(viewportWidth),
    [viewportWidth]
  );

  const leftPanelRailSize = useMemo(
    () => getLeftPanelRailSizePercent(viewportWidth),
    [viewportWidth]
  );

  const sessionPanelMinSize = useMemo(
    () => getSessionPanelMinSizePercent(viewportWidth),
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

  const currentBoard = useAgorStore(
    useMemo(() => makeBoardSelector(currentBoardId), [currentBoardId])
  );
  const isHomeSurface = (isRootHomePath || pendingHomeNavigation) && !hasExplicitEntityTarget;
  const headerBoardId = isHomeSurface ? '' : currentBoardId;
  const headerBoard = isHomeSurface ? undefined : currentBoard;
  const wasHomeSurfaceRef = useRef(isHomeSurface);
  const isLeavingHomeSurface = wasHomeSurfaceRef.current && !isHomeSurface;
  const [homeExitSidePanelDeferred, setHomeExitSidePanelDeferred] = useState(false);
  const [homeExitPanelDetailsDeferred, setHomeExitPanelDetailsDeferred] = useState(false);

  useLayoutEffect(() => {
    if (isLeavingHomeSurface) {
      setHomeExitSidePanelDeferred(true);
      setHomeExitPanelDetailsDeferred(true);
    }
    wasHomeSurfaceRef.current = isHomeSurface;
  }, [isLeavingHomeSurface, isHomeSurface]);

  useEffect(() => {
    if (!homeExitSidePanelDeferred) return;
    const timer = window.setTimeout(() => {
      setHomeExitSidePanelDeferred(false);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [homeExitSidePanelDeferred]);

  useEffect(() => {
    if (!homeExitPanelDetailsDeferred) return;
    const timer = window.setTimeout(() => {
      setHomeExitPanelDetailsDeferred(false);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [homeExitPanelDetailsDeferred]);

  const handleDeferredDetailsHydrated = useCallback(() => {
    setHomeExitPanelDetailsDeferred(false);
  }, []);

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

  const leftPanelCollapsed =
    commentsPanelCollapsed ||
    suppressLeftPanel ||
    isHomeSurface ||
    isLeavingHomeSurface ||
    homeExitSidePanelDeferred;
  // The rail only makes sense when there's a board to open the panel onto,
  // and stays hidden entirely while a modal-first flow suppresses the panel
  // (suppressLeftPanel) — same gating the old floating knob used.
  const leftPanelRailVisible = leftPanelCollapsed && !!currentBoard && !suppressLeftPanel;
  const leftPanelCollapsedSize = leftPanelRailVisible ? leftPanelRailSize : 0;

  // Ref for programmatically controlling the comments panel
  const commentsPanelRef = useRef<ImperativePanelHandle>(null);
  const effectiveCommentsPanelSize = clampPercent(
    commentsPanelSize,
    leftPanelMinSize,
    LEFT_PANEL_MAX_SIZE_PERCENT
  );

  // Width of the middle content panel (canvas + session panel), as a
  // percentage of the full viewport — whatever's left once the left
  // teammate/comments panel (rail or fully expanded) takes its share. The
  // session panel's own size is persisted relative to the viewport (below),
  // so this is the conversion factor used to translate that into the
  // content-relative percentage react-resizable-panels expects — keeping the
  // session panel's absolute pixel width stable whenever the left panel
  // toggles or resizes.
  const contentPanelWidthPercent = getContentPanelWidthPercent(
    leftPanelCollapsed,
    leftPanelCollapsedSize,
    effectiveCommentsPanelSize
  );

  // Session panel size persistence: percentage of the FULL VIEWPORT (not of
  // the content panel), scoped per user, so the chat panel's absolute pixel
  // width doesn't change when the left panel collapses to a rail or back.
  const [sessionPanelSize, setSessionPanelSize] = useUserLocalStorage<number>(
    user?.user_id,
    'panel:right:size',
    50
  );

  const effectiveSessionPanelSize = clampPercent(
    sessionPanelSize,
    sessionPanelMinSize,
    SESSION_PANEL_MAX_SIZE_PERCENT
  );
  // react-resizable-panels sizes the nested `canvas-session` PanelGroup's
  // panels relative to the content panel, not the viewport — convert. Both
  // the default and max are further capped so the canvas panel can always
  // keep its own `minSize` (CANVAS_MIN_SIZE_PERCENT).
  const sessionPanelSizeWithinContent = capSessionSizeForCanvasMin(
    toContentRelativePercent(effectiveSessionPanelSize, contentPanelWidthPercent),
    CANVAS_MIN_SIZE_PERCENT
  );
  const sessionPanelMaxSizeWithinContent = capSessionSizeForCanvasMin(
    toContentRelativePercent(SESSION_PANEL_MAX_SIZE_PERCENT, contentPanelWidthPercent),
    CANVAS_MIN_SIZE_PERCENT
  );
  const sessionPanelMinSizeWithinContent = Math.min(
    toContentRelativePercent(sessionPanelMinSize, contentPanelWidthPercent),
    sessionPanelMaxSizeWithinContent
  );
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
  // and the localStorage-backed recents list keeps both in sync. The boards arg
  // only shapes `recentBoards`, which the shell does not consume — passing the
  // stable empty list avoids a whole-map subscription here.
  const { recentBoardIds, trackBoardVisit } = useRecentBoards(EMPTY_BOARDS, currentBoardId);

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

  // Re-resize whenever the content-relative size changes — including when
  // the left panel toggles or resizes and shifts contentPanelWidthPercent,
  // which sessionPanelSizeWithinContent is derived from. Without this, the
  // session panel keeps the same content-relative percentage while its
  // parent's absolute width changes, so its own absolute pixel width would
  // drift along with the left panel.
  useEffect(() => {
    if (sessionPanelRef.current && (effectiveSelectedSessionId || !eventStreamPanelCollapsed)) {
      sessionPanelRef.current.resize(sessionPanelSizeWithinContent);
    }
  }, [effectiveSelectedSessionId, sessionPanelSizeWithinContent, eventStreamPanelCollapsed]);

  // URL⇄state sync renders via UrlStateBridge (in the JSX below) so its
  // whole-map subscriptions never wake the shell. Stable callbacks only.
  const handleUrlBoardChange = useCallback((boardId: string) => {
    setCurrentBoardIdInternal(boardId);
  }, []);

  // Central navigation API. Every deliberate "go to X" call site routes
  // through this so the URL stays the single source of truth and the back
  // button restores prior board+session+camera. The hook reads live data
  // from the store at call time so its function identities stay stable
  // across socket churn — important because they flow into memoized children.
  const navigation = useAppNavigation();

  const handleHomeBoardClick = useCallback(
    (boardId: string) => navigation.goToBoard(boardId),
    [navigation]
  );

  const handleHomeBranchClick = useCallback(
    (branchId: string) => navigation.goToBranch(branchId),
    [navigation]
  );

  const handleHomeOpenCreateDialog = useCallback(
    (tab?: 'branch' | 'teammate' | 'board' | 'repository', boardId?: string) => {
      if (boardId) navigation.goToBoard(boardId);
      setNewBranchDefaultPosition(null);
      setCreateDialogDefaultTab(tab || 'teammate');
      setCreateDialogOpen(true);
    },
    [navigation]
  );

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
  // first board. Distinguish the two reasons the board map can be empty:
  //   - Disconnected and data was never loaded, or was momentarily wiped by a
  //     stale upstream effect → treat as transient, keep the id sticky so the
  //     `/b/<id>` URL survives.
  //   - Connected with an authoritative empty set (user deleted last board) →
  //     clear the selection so we stop pointing at a tombstone.
  // Subscribes to board-list scalars (count / first id) plus the narrow
  // `currentBoard` read above, not the whole map.
  const boardCount = useAgorStore(selectBoardCount);
  const firstBoardId = useAgorStore(selectFirstBoardId);
  useEffect(() => {
    if (boardCount === 0) {
      if (!connected) return;
      if (currentBoardId) setCurrentBoardId('');
      return;
    }
    if (currentBoardId && !currentBoard) {
      setCurrentBoardId(firstBoardId || '');
    }
  }, [boardCount, firstBoardId, currentBoard, currentBoardId, setCurrentBoardId, connected]);

  // Recalculate default position when board changes while modal is open
  // This ensures branches spawn at the center of the new board's viewport
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentBoardId is intentionally included to trigger recalculation on board switch
  useEffect(() => {
    if (createDialogOpen) {
      const center = sessionCanvasRef.current?.getViewportCenter();
      setNewBranchDefaultPosition(center || null);
    }
  }, [currentBoardId, createDialogOpen]);

  // Update favicon based on session activity on current board
  useFaviconStatus(currentBoardId);

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
    (state: { collapsed: boolean; activeTab: BoardTeammatePanelTab }) => {
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
    applyLeftPanelState(getShowCommentsPanelState({ collapsed: true, activeTab: 'teammate' }));
  }, [applyLeftPanelState]);

  // Shared by every TeammatePanelRail button: expand the panel onto
  // whichever tab was clicked.
  const handleSelectTeammatePanelTab = useCallback(
    (tab: BoardTeammatePanelTab) => {
      applyLeftPanelState(getSelectTeammatePanelTabState(tab));
    },
    [applyLeftPanelState]
  );

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

  const handleCreateTeammate = async (
    result: TeammateTabResult,
    progress?: CreateDialogProgress
  ) => {
    const repoId = result.repoId;
    if (!repoId || !onCreateBranch || !onUpdateBranch) {
      throw new Error('Missing repository or branch creation handler for AI teammate creation.');
    }

    progress?.onStatusChange?.('Creating AI teammate branch…');

    const branch = await createTeammateBranch(
      {
        displayName: result.displayName,
        description: result.description,
        emoji: result.emoji,
        repoId,
        branchName: result.branchName,
        sourceBranch: result.sourceBranch,
      },
      { client, repoById: agorStore.getState().repoById, onCreateBranch, onUpdateBranch }
    );

    if (!branch) {
      throw new Error(
        'AI teammate branch could not be created. Please check the branch details and try again.'
      );
    }

    const sessionConfig: NewSessionConfig = {
      branch_id: branch.branch_id,
      agent: result.agent,
      title: `${result.emoji ? `${result.emoji} ` : ''}${result.displayName} bootstrap`,
      initialPrompt: buildTeammateBootstrapPrompt({
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
      const sessionId = await startTeammateBootstrapSession({
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
      console.error('AI teammate session bootstrap failed:', error);
      showWarning(
        `AI teammate branch was created, but the first session could not start: ${
          error instanceof Error ? error.message : String(error)
        }. Opening the branch instead.`,
        { key: 'teammate-bootstrap-session', duration: 8 }
      );
    }

    // If the branch was created but the session failed, still take the user
    // to the teammate branch so the created AI teammate is not lost. The
    // top-level create-session handler surfaces the failure toast.
    progress?.onStatusChange?.('Opening AI teammate branch…');
    navigation.goToBranch(branch.branch_id);
  };

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      // Call-time store read: the shell no longer subscribes to the session /
      // branch maps, so any render-time snapshot here would be stale. The
      // handler's identity stays stable across socket churn — important
      // because it flows through SessionCanvas → initialNodes deps and a
      // flipping identity would cascade re-renders into every BranchCard.
      const { sessionById, branchById } = agorStore.getState();
      const session = sessionById.get(sessionId);

      // Best-effort: clear highlight flags when opening the conversation.
      // These updates may fail silently if the user lacks write permission (e.g. read-only
      // access via RBAC). We suppress errors to avoid spurious toasts for read-only users.
      if (client && session?.ready_for_prompt) {
        client
          .service('sessions')
          .patch(sessionId, { ready_for_prompt: false })
          .catch(() => {});
      }

      const branch = session?.branch_id ? branchById.get(session.branch_id) : undefined;
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

  // Narrow per-id subscriptions: only patches to the SELECTED session (and
  // its branch) wake the shell — those renders are needed to feed
  // SessionPanel fresh props anyway.
  const selectedSession =
    useAgorStore(
      useMemo(() => makeSessionSelector(effectiveSelectedSessionId), [effectiveSelectedSessionId])
    ) ?? null;
  const selectedSessionBranchId = selectedSession?.branch_id;
  const selectedSessionBranch =
    useAgorStore(
      useMemo(() => makeBranchSelector(selectedSessionBranchId), [selectedSessionBranchId])
    ) ?? null;
  const selectedSessionMcpServerIds =
    useAgorStore(
      useMemo(
        () => makeSessionMcpServerIdsSelector(effectiveSelectedSessionId),
        [effectiveSelectedSessionId]
      )
    ) ?? EMPTY_STRING_ARRAY;

  // Sync the actual state when a session disappears (for URL, localStorage, etc.).
  // The rendering already uses effectiveSelectedSessionId so this is mostly
  // cosmetic, but URL cleanup is load-bearing: if the address bar remains on
  // `/s/<id>/` after archiving the selected branch/session, the direct
  // archived-session fallback treats that stale URL like an explicit deep link
  // and can rehydrate the archived session into local state. Replace the route
  // with the current board before clearing selection so archive/delete closes
  // the drawer and does not resurrect the card.
  useEffect(() => {
    if (selectedSessionId && !selectedSessionExists) {
      if (routeParams.sessionShortId && currentBoardId) {
        navigation.goToBoard(currentBoardId, { replace: true });
      }
      setSelectedSessionId(null);
    }
  }, [
    currentBoardId,
    navigation,
    routeParams.sessionShortId,
    selectedSessionId,
    selectedSessionExists,
  ]);

  const sessionSettingsSession =
    useAgorStore(useMemo(() => makeSessionSelector(sessionSettingsId), [sessionSettingsId])) ??
    null;
  const primaryTeammateId = currentBoard?.primary_teammate_id ?? null;
  const primaryTeammateBranch = useAgorStore(
    useMemo(() => makeBranchSelector(primaryTeammateId), [primaryTeammateId])
  );
  const primaryTeammateRepoId = primaryTeammateBranch?.repo_id;
  const primaryTeammateRepo = useAgorStore(
    useMemo(() => makeRepoSelector(primaryTeammateRepoId), [primaryTeammateRepoId])
  );
  const primaryTeammateInaccessible = Boolean(primaryTeammateId && !primaryTeammateBranch);

  // Preserve the historical board-switch behavior now that the panel itself
  // no longer pushes a default tab into controlled parent state on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the tab when switching boards, even if the default tab string is unchanged.
  useEffect(() => {
    setLeftPanelTab(primaryTeammateInaccessible ? 'all-sessions' : 'teammate');
  }, [currentBoard?.board_id, primaryTeammateInaccessible]);

  // Update browser tab title based on current board
  useBoardTitle(currentBoard);

  // Find branch and repo for BranchModal
  const selectedBranch =
    useAgorStore(useMemo(() => makeBranchSelector(branchModalBranchId), [branchModalBranchId])) ??
    null;
  const selectedBranchRepoId = selectedBranch?.repo_id;
  const selectedBranchRepo =
    useAgorStore(useMemo(() => makeRepoSelector(selectedBranchRepoId), [selectedBranchRepoId])) ??
    null;
  const selectedBranchId = selectedBranch?.branch_id;
  const branchSessions =
    useAgorStore(
      useMemo(() => makeSessionsForBranchSelector(selectedBranchId), [selectedBranchId])
    ) ?? EMPTY_SESSIONS;

  // Find branch for NewSessionModal
  const newSessionBranch =
    useAgorStore(useMemo(() => makeBranchSelector(newSessionBranchId), [newSessionBranchId])) ??
    null;

  // Branch for the environment-logs modal (open only while the id is set).
  const logsModalBranch = useAgorStore(
    useMemo(() => makeBranchSelector(logsModalBranchId), [logsModalBranchId])
  );

  // Branches on the current board (via board_objects), derived in the store
  // layer with shallow equality: only membership changes or a member branch's
  // patch produce a fresh array — unrelated socket churn keeps the reference,
  // which matters because this flows into SessionCanvas's `initialNodes` deps
  // and would otherwise cascade into every BranchCard re-rendering.
  const boardBranches = useStoreWithEqualityFn(
    agorStore,
    useMemo(() => makeBranchesForBoardSelector(currentBoardId), [currentBoardId]),
    shallow
  );
  // Comment-derived header scalars. Subscribing to the derived number/boolean
  // (instead of the comment map) keeps comment edits that don't change them —
  // and all comments on other boards — from waking the shell.
  const currentUserName = user?.name || user?.email?.split('@')[0] || '';
  const unreadCommentsCount = useAgorStore(
    useMemo(() => makeUnreadCommentCountSelector(currentBoardId), [currentBoardId])
  );
  const hasUserMentions = useAgorStore(
    useMemo(
      () => makeCommentMentionSelector(currentBoardId, currentUserName || undefined, user?.email),
      [currentBoardId, currentUserName, user?.email]
    )
  );

  // Web terminal is gated by both the instance-level feature flag and the
  // user's role (`WEB_TERMINAL_MIN_ROLE`, shared with TerminalModal so the
  // threshold lives in one place). When disabled, we pass `undefined` so
  // consumers (BranchCard, SessionPanel, EventStreamPanel) can hide their
  // terminal buttons via `{onOpenTerminal && ...}`.
  const canOpenTerminal = webTerminalEnabled && hasMinimumRole(user?.role, WEB_TERMINAL_MIN_ROLE);

  // Stabilize the passthrough action props before they reach the memoized
  // SessionCanvas and the AppActions context value. These arrive from
  // AppContent as plain consts (fresh identity on every store-driven
  // re-render); without freezing them, SessionCanvas's React.memo — and every
  // AppActions consumer — would re-render whenever the parent re-renders,
  // even when nothing they draw changed.
  const stableOnSendPrompt = useStableCallback(onSendPrompt);
  const stableOnBtwForkSession = useStableCallback(onBtwForkSession);
  const stableOnSessionUpdate = useStableCallback(onUpdateSession);
  const stableOnSessionDelete = useStableCallback(onDeleteSession);
  const stableOnForkSession = useStableCallback(onForkSession);
  const stableOnSpawnSession = useStableCallback(onSpawnSession);
  const stableOnUpdateSessionMcpServers = useStableCallback(onUpdateSessionMcpServers);
  const stableOnArchiveOrDeleteBranch = useStableCallback(onArchiveOrDeleteBranch);
  const stableOnStartEnvironment = useStableCallback(onStartEnvironment);
  const stableOnStopEnvironment = useStableCallback(onStopEnvironment);
  const stableOnNukeEnvironment = useStableCallback(onNukeEnvironment);

  // Modal-opener handlers shared by the context value and panel props.
  const handleViewLogs = useCallback((branchId: string) => setLogsModalBranchId(branchId), []);
  const handleOpenSessionSettings = useCallback(
    (sessionId: string) => setSessionSettingsId(sessionId),
    []
  );
  const handleOpenBranchModal = useCallback((branchId: string, tab?: BranchModalTab) => {
    setBranchModalBranchId(branchId);
    setBranchModalTab(tab);
  }, []);

  // Memoize AppActionsContext value from identity-stable handlers only, so
  // the provider value survives shell re-renders and context consumers stay
  // quiet unless terminal availability actually flips.
  const appActionsValue = useMemo(
    () => ({
      onSendPrompt: stableOnSendPrompt,
      onFork: stableOnForkSession,
      onBtwFork: stableOnBtwForkSession,
      onSubsession: stableOnSpawnSession,
      onUpdateSession: stableOnSessionUpdate,
      onDeleteSession: stableOnSessionDelete,
      onPermissionDecision: handlePermissionDecision,
      onStartEnvironment: stableOnStartEnvironment,
      onStopEnvironment: stableOnStopEnvironment,
      onNukeEnvironment: stableOnNukeEnvironment,
      onViewLogs: handleViewLogs,
      onOpenSettings: handleOpenSessionSettings,
      onSessionClick: handleSessionClick,
      onOpenBranch: handleOpenBranchModal,
      onOpenTerminal: canOpenTerminal ? handleOpenTerminal : undefined,
    }),
    [
      stableOnSendPrompt,
      stableOnForkSession,
      stableOnBtwForkSession,
      stableOnSpawnSession,
      stableOnSessionUpdate,
      stableOnSessionDelete,
      handlePermissionDecision,
      stableOnStartEnvironment,
      stableOnStopEnvironment,
      stableOnNukeEnvironment,
      handleViewLogs,
      handleOpenSessionSettings,
      handleSessionClick,
      handleOpenBranchModal,
      handleOpenTerminal,
      canOpenTerminal,
    ]
  );

  // Stabilize the remaining passthrough props (schedule + comment actions) and
  // the panel's inline-arrow handlers so the memoized BoardTeammatePanel's
  // React.memo bailout holds — every prop it receives stays referentially stable
  // across store-driven re-renders that don't change what it draws.
  const stableOnExecuteScheduleNow = useStableCallback(onExecuteScheduleNow);
  const stableOnReplyComment = useStableCallback(onReplyComment);
  const stableOnResolveComment = useStableCallback(onResolveComment);
  const stableOnToggleReaction = useStableCallback(onToggleReaction);
  const stableOnDeleteComment = useStableCallback(onDeleteComment);
  const handleTeammateSendComment = useStableCallback((content: string) =>
    onSendComment?.(currentBoardId || '', content)
  );
  const handleTeammateCollapse = useStableCallback(() => setCommentsPanelCollapsed(true));

  // Identity-stable branch actions for EventStreamPanel (previously an inline
  // object literal whose identity flipped on every shell render).
  const eventStreamBranchActions = useMemo(
    () => ({
      onSessionClick: handleSessionClick,
      onCreateSession: (branchId: string) => setNewSessionBranchId(branchId),
      onOpenSettings: (branchId: string) => setBranchModalBranchId(branchId),
      onNukeEnvironment: stableOnNukeEnvironment,
    }),
    [handleSessionClick, stableOnNukeEnvironment]
  );

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
    <AppActionsProvider value={appActionsValue}>
      <BoardSwitcherBridge setCurrentBoardId={setCurrentBoardId} />
      <UrlStateBridge
        currentBoardId={currentBoardId}
        currentSessionId={effectiveSelectedSessionId}
        onBoardChange={handleUrlBoardChange}
        onSessionChange={setSelectedSessionId}
        onActiveUrlTargetChange={setActiveUrlTarget}
      />
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
          unreadCommentsCount={unreadCommentsCount}
          eventStreamEnabled={eventStreamEnabled}
          hasUserMentions={hasUserMentions}
          currentBoardId={headerBoardId}
          onBoardChange={navigation.goToBoard}
          onHomeClick={handleHomeClick}
          onUserClick={handleHeaderUserClick}
          instanceLabel={instanceLabel}
          instanceDescription={instanceDescription}
        />
        {topBanner}
        <Content style={{ position: 'relative', overflow: 'hidden', display: 'flex' }}>
          <PanelGroup
            id="main-layout"
            direction="horizontal"
            style={{ flex: 1 }}
            onLayout={(sizes) => {
              // Persist only user drag updates. Programmatic resizing enforces
              // the responsive minimum without clobbering the user's desired size.
              if (!leftPanelCollapsed && leftPanelResizeDraggingRef.current && sizes.length >= 2) {
                // Comments panel is the first panel (index 0)
                setCommentsPanelSize(
                  clampPercent(sizes[0], leftPanelMinSize, LEFT_PANEL_MAX_SIZE_PERCENT)
                );
              }
            }}
          >
            <Panel
              id="teammate-panel"
              order={1}
              ref={commentsPanelRef}
              collapsible
              defaultSize={leftPanelCollapsed ? leftPanelCollapsedSize : effectiveCommentsPanelSize}
              collapsedSize={leftPanelCollapsedSize}
              minSize={leftPanelCollapsed ? leftPanelCollapsedSize : leftPanelMinSize}
              maxSize={LEFT_PANEL_MAX_SIZE_PERCENT}
              style={{
                minWidth: leftPanelCollapsed
                  ? leftPanelRailVisible
                    ? LEFT_PANEL_RAIL_WIDTH_PX
                    : 0
                  : LEFT_PANEL_MIN_WIDTH_PX,
              }}
            >
              {leftPanelCollapsed ? (
                leftPanelRailVisible && (
                  <TeammatePanelRail
                    onSelectTab={handleSelectTeammatePanelTab}
                    unreadCommentsCount={unreadCommentsCount}
                    hasUserMentions={hasUserMentions}
                  />
                )
              ) : (
                <BoardTeammatePanel
                  client={client}
                  board={currentBoard || null}
                  activeTab={leftPanelTab}
                  onTabChange={setLeftPanelTab}
                  primaryTeammateBranch={primaryTeammateBranch}
                  primaryTeammateRepo={primaryTeammateRepo}
                  primaryTeammateInaccessible={primaryTeammateInaccessible}
                  currentUserId={user?.user_id}
                  selectedSessionId={effectiveSelectedSessionId}
                  onSessionClick={handleSessionClick}
                  onCreateSession={setNewSessionBranchId}
                  onForkSession={stableOnForkSession}
                  onSpawnSession={stableOnSpawnSession}
                  onArchiveOrDelete={stableOnArchiveOrDeleteBranch}
                  onOpenSettings={handleOpenBranchModal}
                  onOpenSessionSettings={setSessionSettingsId}
                  onOpenTerminal={canOpenTerminal ? handleOpenTerminal : undefined}
                  onStartEnvironment={stableOnStartEnvironment}
                  onStopEnvironment={stableOnStopEnvironment}
                  onViewLogs={setLogsModalBranchId}
                  onNukeEnvironment={stableOnNukeEnvironment}
                  onExecuteScheduleNow={stableOnExecuteScheduleNow}
                  onSendComment={handleTeammateSendComment}
                  onReplyComment={stableOnReplyComment}
                  onResolveComment={stableOnResolveComment}
                  onToggleReaction={stableOnToggleReaction}
                  onDeleteComment={stableOnDeleteComment}
                  hoveredCommentId={hoveredCommentId}
                  selectedCommentId={selectedCommentId}
                  onCollapse={handleTeammateCollapse}
                  deferSessionDetails={homeExitPanelDetailsDeferred}
                  onDeferredDetailsHydrated={handleDeferredDetailsHydrated}
                />
              )}
            </Panel>
            <PanelResizeHandle
              style={{
                position: 'relative',
                width: leftPanelCollapsed ? '0px' : '4px',
                background: token.colorBorderSecondary,
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
                    token.colorPrimary;
                }
              }}
              onMouseLeave={(e) => {
                if (!leftPanelCollapsed) {
                  (e.currentTarget as unknown as HTMLDivElement).style.background =
                    token.colorBorderSecondary;
                }
              }}
            />
            <Panel id="content-panel" order={2} defaultSize={contentPanelWidthPercent} minSize={40}>
              <PanelGroup
                id="canvas-session"
                direction="horizontal"
                style={{ flex: 1 }}
                onLayout={(sizes) => {
                  // Persist only user drag updates so panel open/close and
                  // programmatic restores do not overwrite the user's preference.
                  // sizes[1] is content-relative (react-resizable-panels sizes
                  // panels relative to their own PanelGroup) — convert back to
                  // viewport-relative before persisting, matching the frame
                  // sessionPanelSize is stored in.
                  if (
                    effectiveSelectedSessionId &&
                    rightPanelResizeDraggingRef.current &&
                    sizes.length === 2
                  ) {
                    const viewportRelativeSize = toViewportRelativePercent(
                      sizes[1],
                      contentPanelWidthPercent
                    );
                    setSessionPanelSize(
                      clampPercent(
                        viewportRelativeSize,
                        sessionPanelMinSize,
                        SESSION_PANEL_MAX_SIZE_PERCENT
                      )
                    );
                  }
                }}
              >
                <Panel
                  id="canvas-panel"
                  order={1}
                  defaultSize={
                    effectiveSelectedSessionId ? 100 - sessionPanelSizeWithinContent : 100
                  }
                  minSize={CANVAS_MIN_SIZE_PERCENT}
                >
                  <div style={{ position: 'relative', overflow: 'hidden', height: '100%' }}>
                    {isHomeSurface ? (
                      <HomePage
                        client={client}
                        connected={connected}
                        recentBoardIds={recentBoardIds}
                        currentUserId={user?.user_id}
                        onBoardClick={handleHomeBoardClick}
                        onBranchClick={handleHomeBranchClick}
                        onSessionClick={handleSessionClick}
                        onOpenCreateDialog={handleHomeOpenCreateDialog}
                        onOpenSettings={openSettings}
                      />
                    ) : (
                      <SessionCanvas
                        ref={sessionCanvasRef}
                        board={currentBoard || null}
                        client={client}
                        branches={boardBranches}
                        primaryTeammateId={primaryTeammateId}
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
                    {!isHomeSurface && (
                      <NewSessionButton
                        onClick={() => {
                          const center = sessionCanvasRef.current?.getViewportCenter();
                          setNewBranchDefaultPosition(center || null);
                          setCreateDialogDefaultTab('teammate');
                          setCreateDialogOpen(true);
                        }}
                      />
                    )}
                  </div>
                </Panel>
                {(effectiveSelectedSessionId || !eventStreamPanelCollapsed) && (
                  <>
                    <PanelResizeHandle
                      style={{
                        width: '4px',
                        background: token.colorBorderSecondary,
                        cursor: 'col-resize',
                        transition: 'background 0.2s',
                      }}
                      onDragging={(isDragging) => {
                        rightPanelResizeDraggingRef.current = isDragging;
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as unknown as HTMLDivElement).style.background =
                          token.colorPrimary;
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as unknown as HTMLDivElement).style.background =
                          token.colorBorderSecondary;
                      }}
                    />
                    <Panel
                      id="session-panel"
                      order={2}
                      ref={sessionPanelRef}
                      defaultSize={sessionPanelSizeWithinContent}
                      minSize={sessionPanelMinSizeWithinContent}
                      maxSize={sessionPanelMaxSizeWithinContent}
                    >
                      {effectiveSelectedSessionId ? (
                        <SessionPanel
                          client={client}
                          session={selectedSession}
                          branch={selectedSessionBranch}
                          currentUserId={user?.user_id}
                          sessionMcpServerIds={selectedSessionMcpServerIds}
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
                          branchActions={eventStreamBranchActions}
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
        <Upload style={{ display: 'none' }} openFileDialogOnClick={false} showUploadList={false} />
        {newSessionBranchId && (
          <NewSessionModal
            open={true}
            onClose={() => setNewSessionBranchId(null)}
            onCreate={handleCreateSession}
            availableAgents={availableAgents}
            branchId={newSessionBranchId}
            branch={newSessionBranch || undefined}
            currentUser={user}
            client={client}
          />
        )}
        <SettingsModal
          open={settingsOpen}
          onClose={() => {
            if (settingsRouteOpen) closeSettings();
            onSettingsClose?.();
          }}
          client={client}
          currentUser={user}
          activeTab={effectiveSettingsTab}
          onTabChange={(newTab) => {
            if (!settingsRouteOpen && openSettingsTab) {
              openSettings(newTab as Parameters<typeof setSettingsSection>[0]);
              onSettingsClose?.();
            } else {
              setSettingsSection(newTab as Parameters<typeof setSettingsSection>[0]);
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
          onCreateGatewayChannel={onCreateGatewayChannel}
          onUpdateGatewayChannel={onUpdateGatewayChannel}
          onDeleteGatewayChannel={onDeleteGatewayChannel}
          onUpdateArtifact={onUpdateArtifact}
          onDeleteArtifact={onDeleteArtifact}
          onCreateTeammate={() => {
            closeSettings();
            onSettingsClose?.();
            setNewBranchDefaultPosition(null);
            setCreateDialogDefaultTab('teammate');
            setCreateDialogOpen(true);
          }}
          branchStorageConfig={branchStorageConfig}
        />
        {sessionSettingsSession && (
          <SessionSettingsModal
            open={!!sessionSettingsId}
            onClose={() => setSessionSettingsId(null)}
            session={sessionSettingsSession}
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
            setCreateDialogDefaultTab('teammate');
            setNewBranchDefaultPosition(null);
          }}
          defaultTab={createDialogDefaultTab}
          currentBoardId={currentBoardId}
          defaultPosition={newBranchDefaultPosition || undefined}
          onCreateBranch={handleCreateBranch}
          onCreateBoard={handleCreateBoardFromDialog}
          onCreateRepo={(data) => onCreateRepo?.(data)}
          onCreateLocalRepo={(data) => onCreateLocalRepo?.(data)}
          onCreateTeammate={handleCreateTeammate}
          availableAgents={availableAgents}
          currentUser={user}
          client={client}
          branchStorageConfig={branchStorageConfig}
        />
        {logsModalBranchId && (
          <EnvironmentLogsModal
            open={!!logsModalBranchId}
            onClose={() => setLogsModalBranchId(null)}
            branch={logsModalBranch!}
            client={client}
          />
        )}
        <ThemeEditorModal open={themeEditorOpen} onClose={() => setThemeEditorOpen(false)} />
        <UserSettingsModal
          open={effectiveUserSettingsOpen}
          initialTab={initialUserSettingsTab}
          onClose={() => {
            setUserSettingsOpen(false);
            onUserSettingsClose?.();
          }}
          user={user || null}
          currentUser={user || null}
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
  );
};
