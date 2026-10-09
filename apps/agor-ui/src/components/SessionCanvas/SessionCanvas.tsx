import type {
  AgorClient,
  Board,
  BoardComment,
  BoardCommentCreate,
  BoardEntityObject,
  BoardID,
  BoardObject,
  Branch,
  BranchArchiveOrDeleteOptions,
  BranchID,
  CardWithType,
  Repo,
  Session,
  SpawnConfig,
  User,
  ZoneTrigger,
} from '@agor-live/client';
import {
  BorderOutlined,
  CommentOutlined,
  DeleteOutlined,
  FileMarkdownOutlined,
  MinusOutlined,
  PlusOutlined,
  SelectOutlined,
  ZoomInOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Input,
  Modal,
  Popover,
  Slider,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Background,
  ControlButton,
  Controls,
  type Edge,
  getRectOfNodes,
  MiniMap,
  type Node,
  type NodeDragHandler,
  ReactFlow,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
  type Viewport,
} from 'reactflow';
import {
  type EntityPlacementIntent,
  EntityPlacementWrites,
} from './canvas/utils/entityPlacementWrites';
import 'reactflow/dist/style.css';
import './SessionCanvas.css';
import { boardCommentZoneParentObjectKey, hasMinimumRole, ROLES, shortId } from '@agor-live/client';
import { mapToArray } from '@/utils/mapHelpers';
import { DEFAULT_BACKGROUNDS } from '../../constants/ui';
import {
  useConsumePendingRecenter,
  useRegisterRecenter,
} from '../../contexts/CanvasNavigationContext';
import { useConnectionState, useMutationGate } from '../../contexts/ConnectionContext';
import { getSessionCreationWarning } from '../../domain/sessionCreation';
import { type BoardMutationGuard, useBoardMutationGuard } from '../../hooks/useBoardMutationGuard';
import { useCanManageBoard } from '../../hooks/useCanManageBoard';
import { useCursorTracking } from '../../hooks/useCursorTracking';
import { useStableCallback } from '../../hooks/useStableCallback';
import { agorStore, useAgorStore } from '../../store/agorStore';
import type { BoardWriteTicket } from '../../store/boardMutationGuard';
import { makeBoardReadySelector } from '../../store/boardPartitions';
import {
  makeBoardObjectsForBoardSelector,
  makeSessionsForBranchSelector,
  selectBranchById,
  selectCardById,
  selectCommentById,
  selectMcpServerById,
  selectRepoById,
  selectUserById,
} from '../../store/selectors';
import type { AgenticToolOption } from '../../types';
import { useThemedMessage } from '../../utils/message';
import { REACT_FLOW_DRAG_HANDLE_SELECTOR } from '../../utils/reactFlowDragClasses';
import { buildScopedBoardCss } from '../../utils/sanitizeCss';
import { isDarkTheme } from '../../utils/theme';
import { AutocompleteTextarea } from '../AutocompleteTextarea/AutocompleteTextarea';
import BranchCard from '../BranchCard';
import CardModal from '../CardModal';
import type { CardNodeData } from '../CardNode';
import CardNode from '../CardNode';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';
import SessionCard from '../SessionCard';
import { BoardPartitionStatus } from './BoardPartitionStatus';
import { AppNode } from './canvas/AppNodeLazy';
import { ArtifactNode } from './canvas/ArtifactNodeLazy';
import { CommentNode, ZoneNode } from './canvas/BoardObjectNodes';
import { MarkdownNode } from './canvas/MarkdownNode';
import { RemoteCursorLayer, type StaticRemoteCursor } from './canvas/RemoteCursorLayer';
import { STALE_DRAFT_TITLE, useCopyDraft } from './canvas/staleDraft';
import { useBoardObjects } from './canvas/useBoardObjects';
import { findIntersectingObjects, findZoneAtPosition } from './canvas/utils/collisionDetection';
import {
  canRepositionBoardComment,
  getBranchParentInfo,
  getZoneParentInfo,
  planBoardCommentReposition,
} from './canvas/utils/commentUtils';
import {
  absoluteToRelative,
  calculateStoragePosition,
  getNodeAbsolutePosition,
  type ParentInfo,
  relativeToAbsolute,
} from './canvas/utils/coordinateTransforms';
import {
  type BoardEntityPlacementSnapshot,
  sameBoardEntityPlacement,
  snapshotBoardEntityPlacement,
} from './canvas/utils/entityPlacementReconciliation';
import { getValidZoneParentId, sanitizeOrphanedNodeParents } from './canvas/utils/nodeParentUtils';
import { ZoneTriggerModal } from './canvas/ZoneTriggerModal';
import { DEFAULT_BOARD_OBJECT_Z_INDEX, selectedZIndex } from './canvas/zOrder';
import { createZoneTriggerSession } from './canvas/zoneTriggerSessionCreation';

interface SessionCanvasProps {
  board: Board | null;
  client: AgorClient | null;
  // Entity maps (sessions, branches, repos, users, board objects, comments,
  // cards, MCP servers) are read from the zustand store via narrow selector
  // subscriptions rather than props — the canvas re-renders only for the slices
  // it actually consumes.
  branches: Branch[];
  primaryTeammateId?: string | null;
  currentUserId?: string;
  selectedSessionId?: string | null;
  /** Branch currently targeted by a `/w/<…>/` deep link — folds into
   *  BranchCard's unified dashed "selected" outline. */
  activeUrlTargetBranchId?: string | null;
  /** Artifact currently targeted by an `/a/<…>/` deep link — drives
   *  ArtifactNode's dashed "selected" outline. */
  activeUrlTargetArtifactId?: string | null;
  availableAgents?: AgenticToolOption[];
  onSessionClick?: (sessionId: string) => void;
  onTaskClick?: (taskId: string) => void;
  onSessionUpdate?: (sessionId: string, updates: Partial<Session>) => void;
  onSessionDelete?: (sessionId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onUpdateSessionMcpServers?: (
    sessionId: string,
    mcpServerIds: string[],
    /** The links the user was shown; the change is diffed against them. */
    baselineIds?: string[]
  ) => void;
  onOpenSettings?: (sessionId: string) => void;
  onCreateSessionForBranch?: (branchId: string) => void;
  onOpenBranch?: (branchId: string) => void;
  onArchiveOrDeleteBranch?: (
    branchId: string,
    options: BranchArchiveOrDeleteOptions
  ) => void | Promise<void>;
  onOpenTerminal?: (commands: string[], branchId?: string) => void;
  onStartEnvironment?: (branchId: string) => void;
  onStopEnvironment?: (branchId: string) => void;
  onViewLogs?: (branchId: string) => void;
  onNukeEnvironment?: (branchId: string) => void;
  onExecuteScheduleNow?: (branchId: string) => Promise<void>;
  onOpenCommentsPanel?: () => void;
  onCommentHover?: (commentId: string | null) => void;
  onCommentSelect?: (commentId: string | null) => void;
  /** Demo/screenshot-only fixture: render static cursors while keeping the product canvas. */
  staticCursors?: StaticRemoteCursor[];
  /** Demo/screenshot-only scale boost for static cursors. */
  staticCursorScale?: number;
  /** Optional host-controlled height for embedded/demo canvases. Defaults to full viewport. */
  height?: React.CSSProperties['height'];
  /** View only (mobile): pan, zoom and open items; no tools, dragging, edits or cursor broadcast. */
  readOnly?: boolean;
}

export interface SessionCanvasRef {
  getViewportCenter: () => { x: number; y: number } | null;
}

interface SessionNodeData {
  session: Session;
  userById: Map<string, User>;
  currentUserId?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: () => void;
  onDelete?: (sessionId: string) => void;
  onOpenSettings?: (sessionId: string) => void;
  onUnpin?: (sessionId: string) => void;
  compact?: boolean;
  isPinned?: boolean;
  parentZoneId?: string;
  zoneName?: string;
  zoneColor?: string;
  isActiveUrlTarget?: boolean;
}

// Shared empty array for branches that have no sessions. Without this, a
// per-branch session selector returning `undefined` would fall back to a fresh
// `[]` on every render, breaking referential equality and forcing memoized
// children to re-render on every unrelated socket event.
const EMPTY_SESSIONS: Session[] = [];

// Custom node component that renders SessionCard (memoized to prevent re-renders on unrelated node changes)
const SessionNode = React.memo(({ data }: { data: SessionNodeData }) => {
  return (
    <div className="session-node">
      <SessionCard
        session={data.session}
        userById={data.userById}
        currentUserId={data.currentUserId}
        onTaskClick={data.onTaskClick}
        onSessionClick={data.onSessionClick}
        onDelete={data.onDelete}
        onOpenSettings={data.onOpenSettings}
        onUnpin={data.onUnpin}
        isPinned={data.isPinned}
        zoneName={data.zoneName}
        zoneColor={data.zoneColor}
        defaultExpanded={!data.compact}
      />
    </div>
  );
});

interface BranchNodeData {
  branch: Branch;
  repo: Repo;
  boardId?: string | null;
  currentUserId?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (branchId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onArchiveOrDelete?: (
    branchId: string,
    options: BranchArchiveOrDeleteOptions
  ) => void | Promise<void>;
  onOpenSettings?: (branchId: string) => void;
  onOpenSessionSettings?: (sessionId: string) => void;
  onOpenTerminal?: (commands: string[], branchId?: string) => void;
  onStartEnvironment?: (branchId: string) => void;
  onStopEnvironment?: (branchId: string) => void;
  onViewLogs?: (branchId: string) => void;
  onNukeEnvironment?: (branchId: string) => void;
  onExecuteScheduleNow?: (branchId: string) => Promise<void>;
  onUnpin?: (branchId: string) => void;
  isPinned?: boolean;
  parentZoneId?: string;
  zoneName?: string;
  zoneColor?: string;
  selectedSessionId?: string | null;
  isActiveUrlTarget?: boolean;
  showDragHandle: boolean;
  client: AgorClient | null;
}

// Custom node component that renders CardNode (memoized)
const CardNodeWrapper = React.memo(({ data }: { data: CardNodeData }) => {
  return (
    <div className="card-node">
      <CardNode data={data} />
    </div>
  );
});

// Custom node component that renders BranchCard.
//
// React.memo's default shallow compare runs against the wrapper `{ data }`
// prop. The `initialNodes` useMemo above rebuilds a fresh `data` object for
// every branch on every recomputation, so the default memo always fails
// and every BranchCard re-renders on any session / branch / board patch
// — even unrelated ones. We supply a custom areEqual that compares the
// individual fields of `data` shallowly so unrelated socket events don't
// invalidate this node. This is the primary fix for board jank during
// streaming socket traffic.
//
// This branch's session list — the highest-frequency entity read (a
// `session:patched` arrives on every streaming token batch) — is sourced
// directly from the store by branch id rather than carried in `data`. A patch
// to another branch's sessions leaves this branch's array reference untouched,
// so this card's subscription stays quiet; a patch to this branch re-renders
// only this card without rebuilding (and re-allocating) every branch's node
// `data` in the parent `initialNodes` memo. EMPTY_SESSIONS keeps the prop
// referentially stable for branches with no sessions.
const BranchNode = React.memo(
  ({ data }: { data: BranchNodeData }) => {
    const sessionsSelector = useMemo(
      () => makeSessionsForBranchSelector(data.branch.branch_id),
      [data.branch.branch_id]
    );
    const sessions = useAgorStore(sessionsSelector) ?? EMPTY_SESSIONS;
    // Sourced from the store rather than carried in `data`: BranchCard reads
    // arbitrary users (session/message authors), so the whole map is the
    // narrowest mechanical slice. Keeping it out of `data` keeps the map out
    // of the parent's node-building dependencies, so a user patch updates the
    // affected cards without rebuilding every node's `data` on the board.
    const userById = useAgorStore(selectUserById);
    return (
      <div className="branch-node">
        <BranchCard
          branch={data.branch}
          repo={data.repo}
          sessions={sessions}
          progressiveMountKey={data.boardId ?? 'no-board'}
          userById={userById}
          currentUserId={data.currentUserId}
          selectedSessionId={data.selectedSessionId}
          isActiveUrlTarget={data.isActiveUrlTarget}
          onTaskClick={data.onTaskClick}
          onSessionClick={data.onSessionClick}
          onCreateSession={data.onCreateSession}
          onForkSession={data.onForkSession}
          onSpawnSession={data.onSpawnSession}
          onArchiveOrDelete={data.onArchiveOrDelete}
          onOpenSettings={data.onOpenSettings}
          onOpenSessionSettings={data.onOpenSessionSettings}
          onOpenTerminal={data.onOpenTerminal}
          onStartEnvironment={data.onStartEnvironment}
          onStopEnvironment={data.onStopEnvironment}
          onViewLogs={data.onViewLogs}
          onNukeEnvironment={data.onNukeEnvironment}
          onExecuteScheduleNow={data.onExecuteScheduleNow}
          onUnpin={data.onUnpin}
          isPinned={data.isPinned}
          zoneName={data.zoneName}
          client={data.client}
          zoneColor={data.zoneColor}
          showDragHandle={data.showDragHandle}
        />
      </div>
    );
  },
  (prev, next) => {
    // Shallow-compare the fields of `data` we actually pass down to
    // BranchCard. If the parent rebuilt `data` but every relevant field
    // is referentially equal, skip re-rendering this card. The fields here
    // must match the props read from `data` above.
    const p = prev.data;
    const n = next.data;
    return (
      p.branch === n.branch &&
      p.repo === n.repo &&
      p.boardId === n.boardId &&
      p.currentUserId === n.currentUserId &&
      p.selectedSessionId === n.selectedSessionId &&
      p.isActiveUrlTarget === n.isActiveUrlTarget &&
      p.isPinned === n.isPinned &&
      p.zoneName === n.zoneName &&
      p.zoneColor === n.zoneColor &&
      p.showDragHandle === n.showDragHandle &&
      p.client === n.client &&
      p.onTaskClick === n.onTaskClick &&
      p.onSessionClick === n.onSessionClick &&
      p.onCreateSession === n.onCreateSession &&
      p.onForkSession === n.onForkSession &&
      p.onSpawnSession === n.onSpawnSession &&
      p.onArchiveOrDelete === n.onArchiveOrDelete &&
      p.onOpenSettings === n.onOpenSettings &&
      p.onOpenSessionSettings === n.onOpenSessionSettings &&
      p.onOpenTerminal === n.onOpenTerminal &&
      p.onStartEnvironment === n.onStartEnvironment &&
      p.onStopEnvironment === n.onStopEnvironment &&
      p.onViewLogs === n.onViewLogs &&
      p.onNukeEnvironment === n.onNukeEnvironment &&
      p.onExecuteScheduleNow === n.onExecuteScheduleNow &&
      p.onUnpin === n.onUnpin
    );
  }
);

/** View-only (phone) canvases open at a zoom where card titles stay readable. */
const READ_ONLY_MIN_ZOOM = 0.6;
const READ_ONLY_FIT_PADDING = 0.1;
/** View-only canvases remember their viewport per board for the browser session, so Back returns to it. */
const viewportKey = (boardId: string) => `agor:canvas-viewport:${boardId}`;
const readSavedViewport = (boardId: string): Viewport | null => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(viewportKey(boardId)) ?? 'null');
    return typeof saved?.zoom === 'number' ? saved : null;
  } catch {
    return null;
  }
};
const saveViewport = (boardId: string, viewport: Viewport) => {
  try {
    sessionStorage.setItem(viewportKey(boardId), JSON.stringify(viewport));
  } catch {
    // Storage full or blocked: the next visit fits the first zone again.
  }
};
/** The first zone, or the first card when there are none: top first, then left. */
const firstNodeToRead = (nodes: Node[]): Node | undefined => {
  const zones = nodes.filter((n) => n.type === 'zone');
  return (zones.length ? zones : nodes.filter((n) => n.type === 'branchNode' && !n.parentNode))
    .slice()
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)[0];
};

// Define nodeTypes outside component to avoid recreation on every render
const nodeTypes = {
  sessionNode: SessionNode,
  branchNode: BranchNode,
  cardNode: CardNodeWrapper,
  zone: ZoneNode,
  comment: CommentNode,
  markdown: MarkdownNode,
  appNode: AppNode,
  artifactNode: ArtifactNode,
};

const EMPTY_BOARD_ENTITY_OBJECTS: BoardEntityObject[] = Object.freeze(
  [] as BoardEntityObject[]
) as BoardEntityObject[];

interface BranchZoneTriggerModalProps {
  modal: {
    actionId: number;
    branchId: BranchID;
    zoneName: string;
    zoneId: string;
    trigger: ZoneTrigger;
    sessions: readonly Session[];
  };
  client: AgorClient | null;
  branch: Branch | undefined;
  board: Board | null;
  availableAgents: AgenticToolOption[];
  currentUser: User | null;
  onCancel: () => void;
  onExecute: React.ComponentProps<typeof ZoneTriggerModal>['onExecute'];
}

// Keep modal-only subscriptions behind this conditional boundary. The session
// choices are already snapshotted into the action at drop time, so this child
// deliberately does not subscribe to streaming session state at all. MCP data
// remains live because it supplies picker options rather than action defaults.
const BranchZoneTriggerModal = React.memo(
  ({
    modal,
    client,
    branch,
    board,
    availableAgents,
    currentUser,
    onCancel,
    onExecute,
  }: BranchZoneTriggerModalProps) => {
    const mcpServerById = useAgorStore(selectMcpServerById);

    return (
      <ZoneTriggerModal
        actionId={modal.actionId}
        open={true}
        onCancel={onCancel}
        client={client}
        branch={branch}
        sessions={modal.sessions}
        zoneName={modal.zoneName}
        trigger={modal.trigger}
        boardName={board?.name}
        boardDescription={board?.description}
        boardCustomContext={board?.custom_context}
        availableAgents={availableAgents}
        mcpServerById={mcpServerById}
        currentUser={currentUser}
        onExecute={onExecute}
      />
    );
  }
);

const SessionCanvasInner = forwardRef<SessionCanvasRef, SessionCanvasProps>(
  (
    {
      board,
      client,
      branches,
      primaryTeammateId,
      currentUserId,
      selectedSessionId,
      activeUrlTargetBranchId,
      activeUrlTargetArtifactId,
      availableAgents = [],
      onSessionClick,
      onTaskClick,
      onSessionUpdate,
      onSessionDelete,
      onForkSession,
      onSpawnSession,
      onUpdateSessionMcpServers,
      onOpenSettings,
      onCreateSessionForBranch,
      onOpenBranch,
      onArchiveOrDeleteBranch,
      onOpenTerminal,
      onStartEnvironment,
      onStopEnvironment,
      onViewLogs,
      onNukeEnvironment,
      onExecuteScheduleNow,
      onOpenCommentsPanel,
      onCommentHover,
      onCommentSelect,
      staticCursors,
      staticCursorScale,
      height = '100vh',
      readOnly = false,
    }: SessionCanvasProps,
    ref
  ) => {
    const { token } = theme.useToken();
    const mutationGate = useMutationGate();
    const connection = useConnectionState();
    const { showError, showWarning } = useThemedMessage();

    // Entity state via narrow store subscriptions. Each whole-map selector is a
    // stable module-level reference, so a slice only re-renders the canvas when
    // its own reference changes (idempotent writes are short-circuited upstream).
    const repoById = useAgorStore(selectRepoById);
    const branchById = useAgorStore(selectBranchById);
    const commentById = useAgorStore(selectCommentById);
    const cardById = useAgorStore(selectCardById);
    const userById = useAgorStore(selectUserById);
    const currentUser = currentUserId ? userById.get(currentUserId) : undefined;
    const canEditBoard = useCanManageBoard(client, board ?? undefined, currentUser) && !readOnly;
    // Until this board's partition is loaded (e.g. right after a reconnect
    // unloaded it), its cached placements may be stale and its record may be
    // the lean one without zone geometry: a drag would then persist
    // `zone_id: null` for a pinned branch. Structural edits wait (invariant I1).
    const boardReady = useAgorStore(
      useMemo(() => makeBoardReadySelector(board?.board_id), [board?.board_id])
    );
    // Board Viewers may collaborate through comments even though structural
    // canvas mutations require board.edit. The daemon applies the same global
    // member floor plus board-view authorization on comment creation.
    const canComment =
      !readOnly && Boolean(currentUser && hasMinimumRole(currentUser.role, ROLES.MEMBER));
    // The single fence for every board-scoped write (`useBoardMutationGuard`).
    // A write captures a ticket when it is queued or its dialog opens, and the
    // ticket is rechecked immediately before every dispatch: a write decided
    // before an unload never dispatches, even after the board reloads.
    const boardGuard = useBoardMutationGuard(board?.board_id, canEditBoard);
    const commentGuard = useBoardMutationGuard(board?.board_id, canComment);
    const canMutateBoard = boardGuard.canMutate;
    const canMutateComments = commentGuard.canMutate;
    const boardMutationMessage = !canEditBoard
      ? 'You do not have permission to edit this board'
      : !boardReady
        ? 'This board is still loading'
        : mutationGate.message;
    const commentMutationMessage = canComment
      ? mutationGate.message
      : 'You do not have permission to comment on this board';

    const isDarkMode = isDarkTheme(token);
    const defaultBackground = DEFAULT_BACKGROUNDS[isDarkMode ? 'dark' : 'light'];

    // Sanitize + scope any user styling through the shared pipeline so the
    // canvas and the editor preview can never diverge. Returns '' when the
    // board is on the default, in which case we apply the trusted inline
    // themed default instead (user styling never touches an inline style).
    const boardCssClass = board?.board_id ? `board-css-${shortId(board.board_id)}` : '';
    const scopedCustomCss = useMemo(
      () =>
        buildScopedBoardCss({
          backgroundColor: board?.background_color,
          customCss: board?.custom_css,
          scopeClass: boardCssClass,
        }),
      [board?.custom_css, board?.background_color, boardCssClass]
    );
    const canvasBackground = scopedCustomCss ? undefined : defaultBackground;

    // Board-scoped board objects: subscribe to only THIS board's bucket so
    // other boards' object churn never re-renders the canvas. The factory is
    // memoized per boardId so the selector reference is stable across renders.
    const boardId = board?.board_id;
    const boardObjectsSelector = useMemo(
      () => makeBoardObjectsForBoardSelector(boardId),
      [boardId]
    );
    const boardObjectsForBoard = useAgorStore(boardObjectsSelector) || EMPTY_BOARD_ENTITY_OBJECTS;

    // Board-scoped placement maps: rebuild only when this board's object array
    // changes. This replaces the old global scan + JSON.stringify stabilizer.
    const boardObjectByBranch = useMemo(() => {
      const map = new Map<string, BoardEntityObject>();
      for (const boardObject of boardObjectsForBoard) {
        if (boardObject.branch_id) map.set(boardObject.branch_id, boardObject);
      }
      return map;
    }, [boardObjectsForBoard]);

    const boardObjectByCard = useMemo(() => {
      const map = new Map<string, BoardEntityObject>();
      for (const boardObject of boardObjectsForBoard) {
        if (boardObject.card_id) map.set(boardObject.card_id, boardObject);
      }
      return map;
    }, [boardObjectsForBoard]);

    // Card modal state
    const [selectedCard, setSelectedCard] = useState<CardWithType | null>(null);
    const [cardModalOpen, setCardModalOpen] = useState(false);

    // Tool state for canvas annotations
    const [activeTool, setActiveTool] = useState<
      'select' | 'zone' | 'comment' | 'eraser' | 'markdown'
    >('select');

    // Zone drawing state (drag-to-draw)
    const [drawingZone, setDrawingZone] = useState<{
      start: { x: number; y: number };
      end: { x: number; y: number };
      /** Captured when the gesture began. */
      ticket: BoardWriteTicket | null;
    } | null>(null);

    // Comment placement state (click-to-place)
    const [commentPlacement, setCommentPlacement] = useState<{
      position: { x: number; y: number }; // React Flow coordinates
      screenPosition: { x: number; y: number }; // Screen coordinates for popover
      /** Captured at placement: the anchor geometry belongs to that board lifetime. */
      ticket: BoardWriteTicket | null;
    } | null>(null);
    const [commentInput, setCommentInput] = useState('');

    // Markdown note placement state (click-to-place)
    const [markdownModal, setMarkdownModal] = useState<{
      position: { x: number; y: number }; // React Flow coordinates
      objectId?: string; // For editing existing note
      /** Captured when the editor opened; a board reload drops its save. */
      ticket: BoardWriteTicket | null;
      /**
       * A save was refused because the board reloaded: the draft stays to
       * copy or discard, and Save stays refused. Nothing in this editor
       * captures a new ticket; reopening the note (after closing) does.
       */
      stale?: boolean;
      /** The last save was rejected (e.g. permission): the draft stays open. */
      saveError?: string;
    } | null>(null);
    const [markdownContent, setMarkdownContent] = useState('');
    const [markdownWidth, setMarkdownWidth] = useState(500); // Default width
    // Set synchronously on open: an open editor keeps its ticket and draft,
    // so another open (edit or placement click) is ignored until it closes.
    const markdownModalOpenRef = useRef(false);
    // Unsaved zone drafts whose node unmounted (the zone was deleted, e.g. by
    // a reload): shown to copy or discard, never saved.
    const [lostZoneDrafts, setLostZoneDrafts] = useState<
      Array<{ key: number; objectId: string; zoneName: string; text: string }>
    >([]);
    const nextLostZoneDraftKeyRef = useRef(0);
    const handleZoneDraftLost = useCallback(
      (draft: { objectId: string; zoneName: string; text: string }) => {
        const key = nextLostZoneDraftKeyRef.current++;
        setLostZoneDrafts((current) => [...current, { key, ...draft }]);
      },
      []
    );
    const copyDraft = useCopyDraft();

    // Branch zone trigger modal state
    const nextBranchTriggerActionIdRef = useRef(0);
    const [branchTriggerModal, setBranchTriggerModal] = useState<{
      actionId: number;
      branchId: BranchID;
      zoneName: string;
      zoneId: string;
      trigger: ZoneTrigger;
      sessions: readonly Session[];
      /** The drop's write ticket: a board reload while the picker is open drops it. */
      ticket: BoardWriteTicket;
    } | null>(null);
    const handleCancelBranchTrigger = useCallback(() => setBranchTriggerModal(null), []);
    // The picker action being run: a second Execute (a double click) before
    // the first finishes runs nothing. Set synchronously, before any await.
    const runningBranchTriggerRef = useRef<typeof branchTriggerModal>(null);
    const handleExecuteBranchTrigger = useStableCallback(
      async ({
        sessionId,
        action,
        renderedTemplate,
        agent,
        agenticToolPresetId,
        modelConfig,
        permissionMode,
        mcpServerIds,
      }: Parameters<React.ComponentProps<typeof ZoneTriggerModal>['onExecute']>[0]) => {
        const triggerModal = branchTriggerModal;
        if (!client || !triggerModal) {
          console.error('❌ Cannot execute trigger: client or trigger action not available');
          setBranchTriggerModal(null);
          return;
        }
        if (runningBranchTriggerRef.current === triggerModal) return;
        runningBranchTriggerRef.current = triggerModal;

        // Rechecked before every dispatch, including after each await.
        const stale = () => {
          if (boardGuard.isCurrent(triggerModal.ticket)) return false;
          boardGuard.warnDropped('This board reloaded; the zone trigger was not run.');
          return true;
        };

        try {
          let targetSessionId = sessionId;

          // Attach MCP in the create call so failures reject here, not silently dropped (#2629).
          if (sessionId === 'new') {
            if (stale()) return;
            const newSession = await createZoneTriggerSession(client, {
              branchId: triggerModal.branchId,
              zoneName: triggerModal.zoneName,
              agent,
              agenticToolPresetId,
              modelConfig,
              permissionMode,
              mcpServerIds,
            });
            targetSessionId = newSession.session_id;
            const warning = getSessionCreationWarning(newSession);
            if (warning) showWarning(warning, { duration: 10 });
          }

          // Execute action and capture the session the user should land on so
          // we can route through the normal session-click pipe afterward.
          let resultSessionId: string | undefined;
          switch (action) {
            case 'prompt': {
              if (stale()) return;
              await client.sessions.prompt(targetSessionId, renderedTemplate, {
                permissionMode,
              });
              resultSessionId = targetSessionId;
              break;
            }
            case 'fork': {
              if (stale()) return;
              const forkedSession = (await client
                .service(`sessions/${targetSessionId}/fork`)
                .create({ prompt: renderedTemplate })) as Session;
              if (stale()) return;
              await client.sessions.prompt(forkedSession.session_id, renderedTemplate, {
                permissionMode,
              });
              resultSessionId = forkedSession.session_id;
              break;
            }
            case 'spawn': {
              if (stale()) return;
              const spawnedSession = (await client
                .service(`sessions/${targetSessionId}/spawn`)
                .create({ prompt: renderedTemplate })) as Session;
              if (stale()) return;
              await client.sessions.prompt(spawnedSession.session_id, renderedTemplate, {
                permissionMode,
              });
              resultSessionId = spawnedSession.session_id;
              break;
            }
          }

          // Use the same URL/recenter/flag-cleanup path as a session-card click.
          if (resultSessionId) onSessionClick?.(resultSessionId);
        } catch (error) {
          console.error('❌ Failed to execute zone trigger:', error);
          showError(
            `Failed to ${action} session: ${error instanceof Error ? error.message : String(error)}`
          );
        } finally {
          if (runningBranchTriggerRef.current === triggerModal) {
            runningBranchTriggerRef.current = null;
          }
          setBranchTriggerModal(null);
        }
      }
    );

    // Debounce timer ref for position updates
    const layoutUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);
    const placementBoardRef = useRef(board);
    placementBoardRef.current = board;

    const pendingLayoutUpdatesRef = useRef<
      Record<
        string,
        {
          x: number;
          y: number;
          intent?: EntityPlacementIntent;
          /** Captured when the move was queued; checked before its dispatch. */
          ticket: BoardWriteTicket;
          guard: BoardMutationGuard;
        }
      >
    >({});
    const isDraggingRef = useRef(false);

    // Helper: Check if a node intersects with a zone
    const _findIntersectingZone = useCallback(
      (nodePosition: { x: number; y: number }, nodeWidth = 400, nodeHeight = 200) => {
        if (!board?.objects) return null;

        for (const [zoneId, zoneData] of Object.entries(board.objects)) {
          if (zoneData.type !== 'zone') continue;

          // Check if node center is within zone bounds
          const nodeCenterX = nodePosition.x + nodeWidth / 2;
          const nodeCenterY = nodePosition.y + nodeHeight / 2;

          const isInZone =
            nodeCenterX >= zoneData.x &&
            nodeCenterX <= zoneData.x + zoneData.width &&
            nodeCenterY >= zoneData.y &&
            nodeCenterY <= zoneData.y + zoneData.height;

          if (isInZone) {
            return { zoneId, zoneData };
          }
        }

        return null;
      },
      [board?.objects]
    );
    // Track positions we've explicitly set (to avoid being overwritten by other clients)
    const localPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
    // Remember the last persisted placement observed for each branch/card.
    // This lets reconciliation distinguish an unrelated branch/session repaint
    // (placement unchanged: keep the optimistic local position) from a newer
    // board-object event such as set_zone/auto-arrange (placement changed: the
    // persisted zone-relative geometry is authoritative).
    const authoritativeEntityPlacementsRef = useRef<
      Map<string, BoardEntityPlacementSnapshot | null>
    >(new Map());
    // biome-ignore lint/correctness/useExhaustiveDependencies: ownership must reset on board/client/auth identity changes
    const placementWrites = useMemo(
      () =>
        new EntityPlacementWrites((nodeId) => {
          delete localPositionsRef.current[nodeId];
          delete pendingLayoutUpdatesRef.current[nodeId];
        }),
      [board?.board_id, client, connection.authGeneration, currentUserId]
    );
    const placementWritesRef = useRef(placementWrites);
    placementWritesRef.current = placementWrites;
    useEffect(() => {
      placementWrites.activate();
      const unsubscribe = agorStore.subscribe((state, previous) => {
        if (state.boardObjectsByBoardId === previous.boardObjectsByBoardId) return;
        placementWrites.observeAll(
          state.boardObjectsByBoardId.get(board?.board_id ?? '') ?? [],
          placementBoardRef.current
        );
      });
      return () => {
        unsubscribe();
        placementWrites.dispose();
      };
    }, [placementWrites, board?.board_id]);
    // Track objects we've deleted locally (to prevent them from reappearing during WebSocket updates)
    const deletedObjectsRef = useRef<Set<string>>(new Set());

    // Initialize nodes and edges state BEFORE using them
    const [nodes, setNodesUnsafe, onNodesChangeInternal] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);

    // React Flow throws if any child node has a parentId that is absent from
    // the same node array. Route all local setNodes calls through this guard so
    // stale zone references (or optimistic zone deletes) render unparented
    // instead of crashing the board.
    const warnedMissingParentsRef = useRef<Set<string>>(new Set());
    const onOrphanedParent = useCallback((node: Node, missingParentId: string) => {
      const warningKey = `${node.id}:${missingParentId}`;
      if (warnedMissingParentsRef.current.has(warningKey)) return;
      warnedMissingParentsRef.current.add(warningKey);
      console.warn('Ignoring stale React Flow parentId on board node', {
        nodeId: node.id,
        nodeType: node.type,
        missingParentId,
      });
    }, []);

    const setNodes = useCallback<React.Dispatch<React.SetStateAction<Node[]>>>(
      (value) => {
        setNodesUnsafe((previousNodes) => {
          const nextNodes = typeof value === 'function' ? value(previousNodes) : value;
          return sanitizeOrphanedNodeParents(nextNodes, { onOrphan: onOrphanedParent });
        });
      },
      [setNodesUnsafe, onOrphanedParent]
    );

    // Track resize state
    const resizeTimerRef = useRef<NodeJS.Timeout | null>(null);
    const pendingResizeUpdatesRef = useRef<
      Record<string, { width: number; height: number; ticket: BoardWriteTicket }>
    >({});

    // Handler to open edit modal for existing markdown note
    const handleEditMarkdownNote = useCallback(
      (objectId: string, content: string, width: number) => {
        if (!canMutateBoard || markdownModalOpenRef.current) return;
        const node = reactFlowInstanceRef.current?.getNode(objectId);
        if (!node) return;

        markdownModalOpenRef.current = true;
        setMarkdownContent(content);
        setMarkdownWidth(width);
        setMarkdownModal({
          position: node.position,
          objectId,
          ticket: boardGuard.capture(),
        });
        setActiveTool('markdown');
      },
      [canMutateBoard, boardGuard]
    );

    // Board objects hook
    const { getBoardObjectNodes, buildObjectNode, batchUpdateObjectPositions, deleteObject } =
      useBoardObjects({
        board,
        client,
        boardObjectsForBoard,
        setNodes,
        deletedObjectsRef,
        eraserMode: activeTool === 'eraser',
        activeUrlTargetArtifactId,
        onEditMarkdown: handleEditMarkdownNote,
        onZoneDraftLost: handleZoneDraftLost,
        // Every board-object/zone/text/markdown write goes through this guard.
        guard: boardGuard,
      });

    // Extract zone labels - memoized to only change when labels actually change
    const zoneLabels = useMemo(() => {
      if (!board?.objects) return {};
      const labels: Record<string, string> = {};
      Object.entries(board.objects).forEach(([id, obj]) => {
        if (obj.type === 'zone') {
          labels[id] = obj.label;
        }
      });
      return labels;
    }, [board?.objects]);

    const warnedInvalidZoneRefsRef = useRef<Set<string>>(new Set());
    const warnInvalidZoneRef = useCallback(
      (
        entityKind: 'branch' | 'card',
        entityId: string | undefined,
        zoneId: string,
        reason: string
      ) => {
        const warningKey = `${entityKind}:${entityId ?? 'unknown'}:${zoneId}`;
        if (warnedInvalidZoneRefsRef.current.has(warningKey)) return;
        warnedInvalidZoneRefsRef.current.add(warningKey);
        console.warn(`Ignoring stale board zone reference for ${entityKind} node`, {
          entityId,
          zoneId,
          reason,
        });
      },
      []
    );

    // Handler to unpin a branch from its zone. Identity-stabilized because it
    // feeds every branch node's `data.onUnpin`: a fresh identity (its closure
    // reads `board` and the placement map, which change on every board patch)
    // would defeat BranchNode's areEqual for all branches at once.
    const handleUnpinBranch = useStableCallback(async (branchId: string) => {
      const ticket = boardGuard.capture();
      if (!board || !client || !ticket) return;

      // Find the board_object for this branch
      const boardObject = boardObjectByBranch.get(branchId);

      if (!boardObject?.zone_id) {
        return;
      }

      // Get zone position from board.objects
      const zone = board.objects?.[boardObject.zone_id];

      if (!zone) {
        console.error('Cannot unpin: zone not found', {
          zoneId: boardObject.zone_id,
        });
        return;
      }

      // Calculate absolute position from relative position
      // Branch's position is relative to zone when pinned, so add zone's position
      const absoluteX = boardObject.position.x + zone.x;
      const absoluteY = boardObject.position.y + zone.y;

      // Optimistically store absolute position in localPositionsRef
      // This will be used by the node sync effect until WebSocket confirms
      localPositionsRef.current[branchId] = {
        x: absoluteX,
        y: absoluteY,
      };

      // Trigger immediate React Flow update
      setNodes((currentNodes) =>
        currentNodes.map((node) => {
          if (node.id === branchId) {
            return {
              ...node,
              position: { x: absoluteX, y: absoluteY },
              parentId: undefined, // Remove parent relationship
            };
          }
          return node;
        })
      );

      // Update with absolute position and clear zone_id
      await boardGuard.write(ticket, () =>
        client.service('board-objects').patch(boardObject.object_id, {
          position: { x: absoluteX, y: absoluteY },
          zone_id: null, // null serializes correctly, undefined gets stripped
        })
      );
    });

    // Convert branches to React Flow nodes (branch-centric approach)
    const initialNodes: Node[] = useMemo(() => {
      // Auto-layout for branches without explicit positioning
      const VERTICAL_SPACING = 500;
      const _HORIZONTAL_SPACING = 600;

      // Create nodes for branches on this board
      const nodes: Node[] = [];

      branches.forEach((branch, index) => {
        if (primaryTeammateId && branch.branch_id === primaryTeammateId) {
          return;
        }

        // Find board object for this branch (if positioned on this board)
        const boardObject = boardObjectByBranch.get(branch.branch_id);

        // Use stored position from boardObject if available, otherwise auto-layout
        const position = boardObject
          ? { x: boardObject.position.x, y: boardObject.position.y }
          : { x: 100, y: 100 + index * VERTICAL_SPACING };

        // Check if branch is pinned to a zone (via board_object.zone_id)
        // Note: zone_id in database already has 'zone-' prefix (e.g., 'zone-1234')
        const zoneId = boardObject?.zone_id; // Zone ID with 'zone-' prefix (for React Flow parentId)

        // Look up zone name using full zone ID (zoneLabels uses full IDs as keys)
        const zoneName = zoneId ? zoneLabels[zoneId] || 'Unknown Zone' : undefined;
        const validZoneParentId = getValidZoneParentId(zoneId, board?.objects, {
          entityId: branch.branch_id,
          onInvalid: (entityId, invalidZoneId, reason) =>
            warnInvalidZoneRef('branch', entityId, invalidZoneId, reason),
        });
        const zoneObj = validZoneParentId ? board?.objects?.[validZoneParentId] : undefined;
        const zoneColor =
          zoneObj && zoneObj.type === 'zone'
            ? zoneObj.borderColor || zoneObj.color // Backwards compat: borderColor first, then fall back to deprecated color
            : undefined;

        // Get repo for this branch
        const repo = repoById.get(branch.repo_id);
        if (!repo) {
          console.error(`Repo not found for branch ${branch.branch_id}`);
          return;
        }

        nodes.push({
          id: branch.branch_id,
          type: 'branchNode',
          dragHandle: REACT_FLOW_DRAG_HANDLE_SELECTOR,
          position, // When pinned (parentId set), this is relative to zone; otherwise absolute
          draggable: canMutateBoard,
          zIndex: 500, // Above zones, below comments
          // Set dimensions for collision detection (matches BranchCard size)
          width: 500,
          height: 200, // Approximate height, will be measured by React Flow
          // Set parentId for visual nesting but allow dragging outside zone
          // Only set if zone actually exists — stale zone_id references cause React Flow errors
          parentId: validZoneParentId,
          extent: undefined, // No movement restriction - can drag anywhere
          data: {
            branch,
            repo,
            boardId: board?.board_id ?? null,
            currentUserId,
            selectedSessionId,
            isActiveUrlTarget: branch.branch_id === activeUrlTargetBranchId,
            onTaskClick,
            onSessionClick,
            onCreateSession: onCreateSessionForBranch,
            onForkSession,
            onSpawnSession,
            onArchiveOrDelete: onArchiveOrDeleteBranch,
            onOpenSettings: onOpenBranch,
            onOpenSessionSettings: onOpenSettings,
            onOpenTerminal,
            onStartEnvironment,
            onStopEnvironment,
            onViewLogs,
            onNukeEnvironment,
            onExecuteScheduleNow,
            onUnpin: handleUnpinBranch,
            isPinned: !!validZoneParentId,
            zoneName,
            zoneColor,
            showDragHandle: !readOnly,
            client,
          },
        });
      });

      return nodes;
    }, [
      board?.objects,
      board?.board_id,
      branches,
      primaryTeammateId,
      boardObjectByBranch,
      repoById,
      currentUserId,
      selectedSessionId,
      activeUrlTargetBranchId,
      onSessionClick,
      onTaskClick,
      onCreateSessionForBranch,
      onForkSession,
      onSpawnSession,
      onArchiveOrDeleteBranch,
      onOpenBranch,
      onOpenSettings,
      onOpenTerminal,
      onStartEnvironment,
      onStopEnvironment,
      onViewLogs,
      onNukeEnvironment,
      onExecuteScheduleNow,
      handleUnpinBranch,
      zoneLabels,
      warnInvalidZoneRef,
      client,
      canMutateBoard,
      readOnly,
    ]);

    // Handler to open card modal. Identity-stabilized so card-map churn does
    // not hand every card node a fresh `data.onClick`.
    const handleCardClick = useStableCallback((cardId: string) => {
      const card = cardById.get(cardId);
      if (card) {
        setSelectedCard(card);
        setCardModalOpen(true);
      }
    });

    // Handler to unpin a card from its zone. Identity-stabilized for the same
    // reason as handleUnpinBranch.
    const handleUnpinCard = useStableCallback(async (cardId: string) => {
      const ticket = boardGuard.capture();
      if (!board || !client || !ticket) return;
      const boardObject = boardObjectByCard.get(cardId);
      if (!boardObject?.zone_id) return;

      const zone = board.objects?.[boardObject.zone_id];
      if (!zone) return;

      const absoluteX = boardObject.position.x + zone.x;
      const absoluteY = boardObject.position.y + zone.y;

      localPositionsRef.current[`card-${cardId}`] = { x: absoluteX, y: absoluteY };

      setNodes((currentNodes) =>
        currentNodes.map((node) => {
          if (node.id === `card-${cardId}`) {
            return { ...node, position: { x: absoluteX, y: absoluteY }, parentId: undefined };
          }
          return node;
        })
      );

      await boardGuard.write(ticket, () =>
        client.service('board-objects').patch(boardObject.object_id, {
          position: { x: absoluteX, y: absoluteY },
          zone_id: null,
        })
      );
    });

    // Build card nodes from board_objects that have card_id set
    const cardNodes: Node[] = useMemo(() => {
      const nodes: Node[] = [];

      for (const [cardId, boardObject] of boardObjectByCard.entries()) {
        const card = cardById.get(cardId);
        if (!card || card.archived) continue;

        const position = { x: boardObject.position.x, y: boardObject.position.y };
        const zoneId = boardObject.zone_id;
        const zoneName = zoneId ? zoneLabels[zoneId] || 'Unknown Zone' : undefined;
        const validZoneParentId = getValidZoneParentId(zoneId, board?.objects, {
          entityId: cardId,
          onInvalid: (entityId, invalidZoneId, reason) =>
            warnInvalidZoneRef('card', entityId, invalidZoneId, reason),
        });
        const zoneObj = validZoneParentId ? board?.objects?.[validZoneParentId] : undefined;
        const zoneColor =
          zoneObj && zoneObj.type === 'zone' ? zoneObj.borderColor || zoneObj.color : undefined;

        nodes.push({
          id: `card-${cardId}`,
          type: 'cardNode',
          dragHandle: REACT_FLOW_DRAG_HANDLE_SELECTOR,
          position,
          draggable: canMutateBoard,
          zIndex: 500, // Same level as branches
          width: 380,
          height: 120,
          parentId: validZoneParentId,
          extent: undefined,
          data: {
            card,
            isPinned: !!validZoneParentId,
            zoneName,
            zoneColor,
            onClick: handleCardClick,
            onUnpin: handleUnpinCard,
          } satisfies CardNodeData,
        });
      }

      return nodes;
    }, [
      board?.objects,
      boardObjectByCard,
      cardById,
      zoneLabels,
      handleCardClick,
      handleUnpinCard,
      warnInvalidZoneRef,
      canMutateBoard,
    ]);

    // No edges needed for branch-centric boards
    // (Session genealogy is visualized within BranchCard, not as canvas edges)
    const initialEdges: Edge[] = useMemo(() => [], []);

    // Store ReactFlow instance ref
    const reactFlowInstanceRef = useRef<ReactFlowInstance | null>(null);
    const reactFlowWrapperRef = useRef<HTMLDivElement | null>(null);
    // Track when ReactFlow instance is ready (state to trigger re-renders)
    const [isReactFlowReady, setIsReactFlowReady] = useState(false);

    // Track which board we last fit the view for (prevents repeated fitView on node changes)
    const lastFitBoardIdRef = useRef<string | null>(null);

    // Expose methods to parent via ref
    useImperativeHandle(
      ref,
      () => ({
        getViewportCenter: () => {
          if (!reactFlowInstanceRef.current || !reactFlowWrapperRef.current) return null;

          // Get the actual canvas dimensions (excluding app header, panels, etc.)
          const rect = reactFlowWrapperRef.current.getBoundingClientRect();

          // Calculate center in screen coordinates
          const centerScreenX = rect.left + rect.width / 2;
          const centerScreenY = rect.top + rect.height / 2;

          // Convert screen coordinates to flow coordinates using screenToFlowPosition
          // This automatically accounts for viewport pan, zoom, and all UI chrome
          const center = reactFlowInstanceRef.current.screenToFlowPosition({
            x: centerScreenX,
            y: centerScreenY,
          });

          return center;
        },
      }),
      []
    );

    // Pan/zoom the canvas onto any React Flow node by id (branch card,
    // artifact, comment, etc.). Returns true if the node was found on the
    // current board; callers (conversation header, settings tables) can
    // surface a fallback when the node lives elsewhere. Uses the node's
    // absolute position so zone-pinned children (with `parentId` set)
    // recenter correctly.
    //
    // ID-shape note: branch nodes use `branch_id` as their React Flow
    // `id`, but artifact nodes use `board_object.object_id` (with the
    // logical `artifact_id` on `data.artifactId`). Rather than thread a
    // boardObjectById lookup through every caller, we accept the logical
    // id and fall back to a `data.artifactId` scan when `getNode` misses.
    const recenterOnNode = useCallback(
      (nodeId: string, subTarget?: { sessionId?: string; ensureVisible?: boolean }): boolean => {
        const instance = reactFlowInstanceRef.current;
        if (!instance) return false;
        const allNodes = instance.getNodes();
        let node = instance.getNode(nodeId);
        if (!node) {
          // Logical-id fallback: artifact callers pass artifact_id; find
          // the node whose data references it. Extendable to other
          // logical-id mismatches in the future.
          node = allNodes.find((n) => n.data?.artifactId === nodeId);
        }
        if (!node) return false;
        const absPos = getNodeAbsolutePosition(node, allNodes);
        const width = node.width ?? 500;
        const height = node.height ?? 200;
        const zoom = instance.getZoom() || 1;
        const centerX = absPos.x + width / 2;
        let centerY = absPos.y + height / 2;
        // Session sub-target: aim at the session row inside the card
        // instead of the card center, so selecting a session lands the
        // camera on that item rather than the card head. Measured from
        // the DOM (row offset within the node wrapper, screen px → flow
        // units via zoom); falls back to card center when the row isn't
        // rendered (collapsed tree, session not on this card).
        if (subTarget?.sessionId) {
          const nodeEl = document.querySelector(
            `.react-flow__node[data-id="${CSS.escape(node.id)}"]`
          );
          const rowEl = nodeEl?.querySelector(
            `[data-session-id="${CSS.escape(subTarget.sessionId)}"]`
          );
          if (nodeEl && rowEl) {
            const nodeRect = nodeEl.getBoundingClientRect();
            const rowRect = rowEl.getBoundingClientRect();
            centerY = absPos.y + (rowRect.top - nodeRect.top + rowRect.height / 2) / zoom;

            // Ensure-visible mode (session selection): don't move the
            // camera when the row is already fully on screen — a pan on
            // every click is disorienting and costs the user their
            // context. When the row is off screen or cut off, pan just
            // enough to bring it into view (with a small margin) rather
            // than re-centering. See CanvasNavigationContext for why
            // deliberate gestures skip this.
            if (subTarget.ensureVisible) {
              const paneEl = nodeEl.closest('.react-flow');
              if (paneEl) {
                // The canvas root defaults to `height: 100vh` (see the
                // `height` prop) but sits below the app header inside an
                // overflow-clipped panel, so the pane element extends past
                // the bottom of the window by the header's height. Clamp
                // the pane rect to the window so "visible" means what the
                // user can actually see — unclamped, rows panned to the
                // pane's bottom edge land hidden below the fold, and rows
                // already in that phantom strip are wrongly treated as
                // on-screen.
                const paneRect = paneEl.getBoundingClientRect();
                const viewLeft = Math.max(paneRect.left, 0);
                const viewTop = Math.max(paneRect.top, 0);
                const viewRight = Math.min(paneRect.right, document.documentElement.clientWidth);
                const viewBottom = Math.min(paneRect.bottom, document.documentElement.clientHeight);
                const margin = 32;
                let shiftX = 0;
                let shiftY = 0;
                if (rowRect.left < viewLeft + margin) {
                  shiftX = viewLeft + margin - rowRect.left;
                } else if (rowRect.right > viewRight - margin) {
                  shiftX = viewRight - margin - rowRect.right;
                }
                if (rowRect.top < viewTop + margin) {
                  shiftY = viewTop + margin - rowRect.top;
                } else if (rowRect.bottom > viewBottom - margin) {
                  shiftY = viewBottom - margin - rowRect.bottom;
                }
                // Already fully visible — leave the camera where it is.
                if (shiftX === 0 && shiftY === 0) return true;
                // Pan by the screen-space delta (viewport transform is in
                // screen px), keeping zoom unchanged.
                const vp = instance.getViewport();
                instance.setViewport(
                  { x: vp.x + shiftX, y: vp.y + shiftY, zoom: vp.zoom },
                  { duration: 400 }
                );
                return true;
              }
            }
          }
        }
        instance.setCenter(centerX, centerY, {
          zoom: instance.getZoom(),
          duration: 400,
        });
        return true;
      },
      []
    );

    // Click-to-pan on the minimap: a plain click re-centers the main
    // viewport on the clicked point. React Flow hands us `position` already
    // in flow (board) coordinates — the same viewBox transform that drives
    // the draggable mask — so there's no coordinate math to reinvent here.
    //
    // Drag-vs-click is handled for us: with `pannable`, React Flow drives the
    // mask via d3-zoom, which calls d3's `dragEnable(view, moved)` on mouseup.
    // A real drag (pointer moved) installs a capture-phase click suppressor,
    // so this `onClick` fires only for a genuine click and never as the tail
    // of a drag. Zoom is preserved and we reuse the same animated recenter as
    // `recenterOnNode`.
    const handleMiniMapClick = useCallback(
      (_event: React.MouseEvent, position: { x: number; y: number }) => {
        const instance = reactFlowInstanceRef.current;
        if (!instance) return;
        instance.setCenter(position.x, position.y, {
          zoom: instance.getZoom(),
          duration: 400,
        });
      },
      []
    );

    useRegisterRecenter(recenterOnNode);

    const consumePendingRecenter = useConsumePendingRecenter();

    // Cursor tracking hook
    useCursorTracking({
      client,
      boardId: board?.board_id as BoardID | null,
      reactFlowInstance: reactFlowInstanceRef.current,
      enabled: !!board && !!client && !staticCursors && !readOnly,
    });

    // Create comment nodes from spatial comments
    const commentNodes: Node[] = useMemo(() => {
      const nodes: Node[] = [];
      const commentsArray = mapToArray(commentById);

      // Filter to only spatial comments on this board (absolute OR relative positioned) and not resolved
      const spatialComments = commentsArray.filter(
        (c: BoardComment) =>
          (c.position?.absolute || c.position?.relative) &&
          c.board_id === board?.board_id &&
          !c.resolved
      );

      // Count replies for each thread root
      const replyCount = new Map<string, number>();
      for (const comment of commentsArray) {
        if (comment.parent_comment_id) {
          replyCount.set(
            comment.parent_comment_id,
            (replyCount.get(comment.parent_comment_id) || 0) + 1
          );
        }
      }

      for (const comment of spatialComments) {
        // Find user who created the comment
        const user = comment.created_by ? userById.get(comment.created_by) : undefined;

        // Determine position, parentId, parentLabel, and parentColor based on comment attachment
        let position: { x: number; y: number };
        let parentId: string | undefined;
        let parentLabel: string | undefined;
        let parentColor: string | undefined;

        if (comment.position?.relative) {
          // Comment pinned to zone or branch - use relative position
          const rel = comment.position.relative;
          position = { x: rel.offset_x, y: rel.offset_y };

          if (rel.parent_type === 'zone') {
            // Parent is a zone - validate zone exists
            // Note: rel.parent_id is stored without 'zone-' prefix, but board.objects keys have it
            const zoneKey = boardCommentZoneParentObjectKey(rel.parent_id);
            const zone = board?.objects?.[zoneKey];
            if (zone?.type === 'zone') {
              const info = getZoneParentInfo(rel.parent_id, board ?? undefined);
              parentId = info.parentId;
              parentLabel = info.parentLabel;
              parentColor = info.parentColor;
            } else {
              // Zone was deleted - skip rendering this comment
              continue;
            }
          } else if (rel.parent_type === 'branch') {
            // Parent is a branch - validate branch exists
            const branch = branchById.get(rel.parent_id);
            if (branch) {
              const info = getBranchParentInfo(rel.parent_id, branches);
              parentId = info.parentId;
              parentLabel = info.parentLabel;
              parentColor = info.parentColor;
            } else {
              // Branch was deleted - skip rendering this comment
              continue;
            }
          }
        } else if (comment.position?.absolute) {
          // Free-floating comment - use absolute position
          position = comment.position.absolute;
          parentId = undefined;
          parentLabel = undefined;
          parentColor = undefined;
        } else {
          // Skip comments without valid position
          continue;
        }

        nodes.push({
          id: `comment-${comment.comment_id}`,
          type: 'comment',
          position,
          parentId, // Set parent for relative positioning (moves with parent)
          // No extent constraint - comments can be dragged anywhere and re-pinned
          draggable:
            mutationGate.canMutate && boardReady && canRepositionBoardComment(comment, currentUser),
          selectable: true,
          zIndex: 1000, // Always on top (elevateNodesOnSelect is disabled)
          data: {
            comment,
            replyCount: replyCount.get(comment.comment_id) || 0,
            user,
            parentLabel, // Show parent object name in hover tooltip
            parentColor, // Show zone color indicator on pin
            onClick: (commentId: string) => {
              // Notify parent of selection (toggle)
              onCommentSelect?.(commentId);
              // Open comments panel if closed
              onOpenCommentsPanel?.();
            },
            onHover: (commentId: string) => {
              onCommentHover?.(commentId);
            },
            onLeave: () => {
              onCommentHover?.(null);
            },
          },
        });
      }

      return nodes;
    }, [
      commentById,
      board,
      branches,
      userById,
      branchById,
      onOpenCommentsPanel,
      onCommentHover,
      onCommentSelect,
      currentUser,
      mutationGate.canMutate,
      boardReady,
    ]);

    // Helper: Apply local position overrides to a set of incoming nodes (branches or cards).
    // Lookups go through Maps so a full board sync stays O(n) instead of
    // O(n²) per-node array scans.
    const applyLocalPositions = useCallback(
      (incomingNodes: Node[], currentNodesById: Map<string, Node>, zoneNodes: Node[]) => {
        // Incoming nodes take precedence over zones on id collision (insertion
        // order below makes them overwrite), matching parent resolution that
        // consults incoming nodes first.
        const parentById = new Map<string, Node>();
        for (const node of zoneNodes) parentById.set(node.id, node);
        for (const node of incomingNodes) parentById.set(node.id, node);

        return incomingNodes.map((newNode) => {
          const existingNode = currentNodesById.get(newNode.id);
          const localPosition = localPositionsRef.current[newNode.id];
          const placement =
            newNode.type === 'branchNode'
              ? boardObjectByBranch.get(newNode.id)
              : newNode.type === 'cardNode'
                ? boardObjectByCard.get(newNode.id.replace('card-', ''))
                : undefined;
          const currentAuthoritativePlacement = snapshotBoardEntityPlacement(placement, board);
          const observedAuthoritativePlacement = authoritativeEntityPlacementsRef.current;
          const hadPreviousAuthoritativePlacement = observedAuthoritativePlacement.has(newNode.id);
          const previousAuthoritativePlacement =
            observedAuthoritativePlacement.get(newNode.id) ?? null;
          observedAuthoritativePlacement.set(newNode.id, currentAuthoritativePlacement);

          const authoritativePlacementChanged =
            hadPreviousAuthoritativePlacement &&
            !sameBoardEntityPlacement(
              previousAuthoritativePlacement,
              currentAuthoritativePlacement
            );

          placementWrites.observe(newNode.id, placement, board);
          if (
            localPosition &&
            authoritativePlacementChanged &&
            !placementWrites.preserves(newNode.id)
          ) {
            // A board-object placement event advanced independently of the
            // local absolute override. set_zone and auto-arrange own both the
            // React Flow parent and the relative position, so never translate
            // the stale absolute point into the new parent coordinate space
            // or let its delayed persistence overwrite that authority. Keep
            // other nodes' independently queued updates intact.
            delete localPositionsRef.current[newNode.id];
            delete pendingLayoutUpdatesRef.current[newNode.id];
            return {
              ...newNode,
              selected: existingNode?.selected,
              zIndex: existingNode?.zIndex ?? newNode.zIndex,
            };
          }

          if (localPosition) {
            let incomingAbsolutePosition = newNode.position;
            if (newNode.parentId) {
              const parentNode = parentById.get(newNode.parentId);
              if (parentNode) {
                incomingAbsolutePosition = relativeToAbsolute(
                  newNode.position,
                  parentNode.position
                );
              }
            }

            const positionConfirmed =
              Math.abs(localPosition.x - incomingAbsolutePosition.x) <= 1 &&
              Math.abs(localPosition.y - incomingAbsolutePosition.y) <= 1;

            if (positionConfirmed) {
              delete localPositionsRef.current[newNode.id];
              return {
                ...newNode,
                selected: existingNode?.selected,
                zIndex: existingNode?.zIndex ?? newNode.zIndex,
              };
            }

            let positionToUse = localPosition;
            if (newNode.parentId) {
              const parentNode = parentById.get(newNode.parentId);
              if (parentNode) {
                positionToUse = absoluteToRelative(localPosition, parentNode.position);
              }
            }

            return {
              ...newNode,
              position: positionToUse,
              selected: existingNode?.selected,
              zIndex: existingNode?.zIndex ?? newNode.zIndex,
            };
          }

          return {
            ...newNode,
            selected: existingNode?.selected,
            zIndex: existingNode?.zIndex ?? newNode.zIndex,
          };
        });
      },
      [boardObjectByBranch, boardObjectByCard, board, placementWrites]
    );

    // Memoized MiniMap nodeColor callback to prevent MiniMap canvas repaints on every render
    const miniMapNodeColor = useCallback(
      (node: Node) => {
        if (node.type === 'comment') return token.colorText;
        if (node.type === 'markdown') return `${token.colorText}B3`;
        if (node.type === 'zone') return `${token.colorText}66`;
        if (node.type === 'cardNode') {
          const cardData = node.data as CardNodeData;
          return cardData.card?.effective_color || token.colorPrimaryBorder;
        }
        const session = node.data.session as Session;
        if (!session) return token.colorPrimaryBorder;
        switch (session.status) {
          case 'running':
            return token.colorPrimary;
          case 'completed':
            return token.colorSuccess;
          case 'failed':
            return token.colorError;
          default:
            return token.colorPrimaryBorder;
        }
      },
      [
        token.colorText,
        token.colorPrimaryBorder,
        token.colorPrimary,
        token.colorSuccess,
        token.colorError,
      ]
    );

    // Helper: Partition nodes by type in a single pass (this runs inside every
    // node-sync setNodes updater, so per-type .filter sweeps add up on large boards)
    const partitionNodesByType = useCallback((nodes: Node[]) => {
      const zones: Node[] = [];
      const markdown: Node[] = [];
      const branches: Node[] = [];
      const cards: Node[] = [];
      const apps: Node[] = [];
      const comments: Node[] = [];
      for (const node of nodes) {
        switch (node.type) {
          case 'zone':
            zones.push(node);
            break;
          case 'markdown':
            markdown.push(node);
            break;
          case 'branchNode':
            branches.push(node);
            break;
          case 'cardNode':
            cards.push(node);
            break;
          case 'appNode':
          case 'artifactNode':
            apps.push(node);
            break;
          case 'comment':
            comments.push(node);
            break;
        }
      }
      return { zones, markdown, branches, cards, apps, comments };
    }, []);

    // Helper: Apply consistent z-ordering to nodes
    // Z-order: zones < branches/cards < apps/artifacts < markdown < comments
    const applyZOrder = useCallback(
      (
        zones: Node[],
        markdown: Node[],
        branches: Node[],
        cards: Node[],
        comments: Node[],
        apps: Node[] = []
      ) => {
        return sanitizeOrphanedNodeParents(
          [...zones, ...branches, ...cards, ...apps, ...markdown, ...comments],
          { onOrphan: onOrphanedParent }
        );
      },
      [onOrphanedParent]
    );

    // Sync board-derived nodes in a single state update. Zones, markdown,
    // apps, and artifacts come from `boardObjectNodes`; pinned branches and
    // cards reference those zones via `parentId`. Merging them in one
    // setNodes ensures `sanitizeOrphanedParents` (inside `applyZOrder`) sees
    // the full parent set on the first paint — splitting the merge let
    // pinned branches lose their parentId and render relative-to-zone
    // positions as absolute (the "pile near origin" on board load).
    useEffect(() => {
      if (isDraggingRef.current) return;

      const boardObjectNodes = getBoardObjectNodes();

      setNodes((currentNodes) => {
        const { comments } = partitionNodesByType(currentNodes);
        const currentNodesById = new Map(currentNodes.map((n) => [n.id, n]));

        const zones = boardObjectNodes
          .filter((n) => n.type === 'zone' && !deletedObjectsRef.current.has(n.id))
          .map((newZone) => {
            const existingZone = currentNodesById.get(newZone.id);
            // Honor the persisted/default base order from board data (`newZone`),
            // and re-apply the +1 selection bump if the zone is currently
            // selected. Reading the base from `newZone` (not the stale runtime
            // value) means layer-control changes that arrive over WebSocket take
            // effect immediately instead of being clobbered.
            const base = (newZone.zIndex as number) ?? DEFAULT_BOARD_OBJECT_Z_INDEX.zone;
            return {
              ...newZone,
              selected: existingZone?.selected,
              zIndex: selectedZIndex(base, !!existingZone?.selected),
            };
          });

        const markdown = boardObjectNodes
          .filter((n) => n.type === 'markdown' && !deletedObjectsRef.current.has(n.id))
          .map((newMarkdown) => {
            const existingMarkdown = currentNodesById.get(newMarkdown.id);
            return { ...newMarkdown, selected: existingMarkdown?.selected };
          });

        const apps = boardObjectNodes
          .filter(
            (n) =>
              (n.type === 'appNode' || n.type === 'artifactNode') &&
              !deletedObjectsRef.current.has(n.id)
          )
          .map((newApp) => {
            const existingApp = currentNodesById.get(newApp.id);
            return { ...newApp, selected: existingApp?.selected };
          });

        const updatedBranches = applyLocalPositions(initialNodes, currentNodesById, zones);
        const updatedCards = applyLocalPositions(cardNodes, currentNodesById, zones);

        return applyZOrder(zones, markdown, updatedBranches, updatedCards, comments, apps);
      });
    }, [
      initialNodes,
      cardNodes,
      getBoardObjectNodes,
      setNodes,
      applyZOrder,
      applyLocalPositions,
      partitionNodesByType,
    ]);

    // Sync COMMENT nodes separately
    useEffect(() => {
      if (isDraggingRef.current) return;

      setNodes((currentNodes) => {
        const { zones, markdown, branches, cards, apps } = partitionNodesByType(currentNodes);

        // Comment parents are branches or zones; branches take precedence on id
        // collision (insertion order below makes them overwrite).
        const parentById = new Map<string, Node>();
        for (const node of zones) parentById.set(node.id, node);
        for (const node of branches) parentById.set(node.id, node);

        // Apply local position overrides to comment nodes (to prevent flicker during drag)
        const commentsWithLocalPositions = commentNodes.map((newNode) => {
          const localPosition = localPositionsRef.current[newNode.id];

          if (localPosition) {
            // Get the incoming position in ABSOLUTE coordinates for comparison
            // If node has parentId, position is relative to parent - must convert to absolute
            let incomingAbsolutePosition = newNode.position;
            if (newNode.parentId) {
              const parentNode = parentById.get(newNode.parentId);
              if (parentNode) {
                incomingAbsolutePosition = relativeToAbsolute(
                  newNode.position,
                  parentNode.position
                );
              }
            }

            // Check if WebSocket confirmed our drag (absolute positions are now close)
            const positionConfirmed =
              Math.abs(localPosition.x - incomingAbsolutePosition.x) <= 1 &&
              Math.abs(localPosition.y - incomingAbsolutePosition.y) <= 1;

            if (positionConfirmed) {
              // WebSocket confirmed our position, clear the local override
              delete localPositionsRef.current[newNode.id];
              return newNode;
            }

            // Still waiting for confirmation
            // If node now has parentId, convert local absolute position to relative
            let positionToUse = localPosition;
            if (newNode.parentId) {
              const parentNode = parentById.get(newNode.parentId);
              if (parentNode) {
                positionToUse = absoluteToRelative(localPosition, parentNode.position);
              }
            }

            return { ...newNode, position: positionToUse };
          }

          return newNode;
        });

        return applyZOrder(zones, markdown, branches, cards, commentsWithLocalPositions, apps);
      });
    }, [commentNodes, setNodes, applyZOrder, partitionNodesByType]);

    // Sync edges
    useEffect(() => {
      setEdges(initialEdges);
    }, [initialEdges, setEdges]); // REMOVED setEdges from dependencies

    // Fit view ONCE when entering a board (not on every node change)
    // This ensures nodes are visible when navigating between boards or on initial load,
    // but doesn't disrupt the user's zoom level when comments/zones change
    useEffect(() => {
      // Wait for ReactFlow to be ready and nodes to be loaded
      if (!isReactFlowReady || !reactFlowInstanceRef.current || nodes.length === 0) return;

      // Only fit view once per board - skip if we already fit for this board
      if (board?.board_id === lastFitBoardIdRef.current) return;

      // Use a small delay to ensure DOM has updated
      const timer = setTimeout(() => {
        // Cross-board recenter: if someone asked to recenter on a node that
        // lives on this (newly-loaded) board, honor it instead of fitView.
        // Falls back to fitView when the pending target isn't on this board
        // either (stale/unknown id).
        const pending = consumePendingRecenter();
        if (
          pending &&
          recenterOnNode(pending.nodeId, {
            sessionId: pending.sessionId,
            ensureVisible: pending.ensureVisible,
          })
        ) {
          lastFitBoardIdRef.current = board?.board_id ?? null;
          return;
        }
        const instance = reactFlowInstanceRef.current;
        const wrapper = reactFlowWrapperRef.current;
        const boardId = board?.board_id;
        if (readOnly && boardId && instance && wrapper) {
          // Phones: return to the remembered view, else fit the first zone's width from its top.
          const saved = readSavedViewport(boardId);
          const first = firstNodeToRead(instance.getNodes());
          const { clientWidth: w, clientHeight: h } = wrapper;
          if (saved) {
            instance.setViewport(saved);
          } else if (first?.width && w && h) {
            const rect = getRectOfNodes([first]);
            const width = Math.min(
              rect.width,
              w / (READ_ONLY_MIN_ZOOM * (1 + READ_ONLY_FIT_PADDING))
            );
            instance.fitBounds(
              { x: rect.x, y: rect.y, width, height: (width * h) / w },
              { padding: READ_ONLY_FIT_PADDING }
            );
          }
          if (saved || first?.width) {
            lastFitBoardIdRef.current = boardId;
            return;
          }
        }
        reactFlowInstanceRef.current?.fitView({
          padding: 0.2, // 20% padding around nodes
          minZoom: 0.1, // Allow zooming out far enough to see widely-spaced nodes
          maxZoom: 1.0, // Don't zoom in beyond 100% to keep nodes readable
          duration: 200, // Smooth animation
        });
        // Mark this board as fitted
        lastFitBoardIdRef.current = board?.board_id ?? null;
      }, 100);

      return () => clearTimeout(timer);
    }, [
      isReactFlowReady,
      nodes.length,
      board?.board_id,
      readOnly,
      consumePendingRecenter,
      recenterOnNode,
    ]);

    // Intercept onNodesChange to detect resize events
    const onNodesChange = useCallback(
      // biome-ignore lint/suspicious/noExplicitAny: React Flow change event types are not exported
      (changes: any) => {
        // biome-ignore lint/suspicious/noExplicitAny: React Flow change event types are not exported
        const selectChanges = changes.filter((c: any) => c.type === 'select');
        if (selectChanges.length > 0) {
          setNodes((currentNodes) => {
            // biome-ignore lint/suspicious/noExplicitAny: React Flow change event types are not exported
            const zoneSelectById = new Map(selectChanges.map((c: any) => [c.id, c]));
            let changed = false;
            const nextNodes = currentNodes.map((n) => {
              if (n.type !== 'zone') return n;
              // biome-ignore lint/suspicious/noExplicitAny: React Flow change event types are not exported
              const change = zoneSelectById.get(n.id) as any;
              if (!change) return n;

              // Bump above the zone's own base order while selected; restore the
              // persisted/default base on deselect so custom layering survives.
              const base = (n.data?.zIndex as number) ?? DEFAULT_BOARD_OBJECT_Z_INDEX.zone;
              const nextZIndex = selectedZIndex(base, !!change.selected);
              if (n.zIndex === nextZIndex) return n;

              changed = true;
              return { ...n, zIndex: nextZIndex };
            });

            // React Flow can emit select changes while reconciling the controlled
            // nodes prop. Returning the same array for no-op zIndex transitions
            // avoids a controlled-update feedback loop (React #185).
            return changed ? nextNodes : currentNodes;
          });
        }

        // Detect resize by checking for dimensions changes
        // biome-ignore lint/suspicious/noExplicitAny: React Flow change event types are not exported
        changes.forEach((change: any) => {
          if (change.type === 'dimensions' && change.dimensions) {
            // O(1) lookup against React Flow's internal node map. Avoids both the
            // old per-event `nodes.find()` scan AND a per-nodes-change Map rebuild:
            // `getNode` is a stable reference and only runs inside this dimensions
            // branch, so the hot drag/position path does zero O(n) work.
            const node = reactFlowInstanceRef.current?.getNode(change.id);
            if (node?.type === 'zone') {
              // Check if dimensions actually changed (to avoid infinite loop from React Flow emitting unchanged dimensions)
              const currentWidth = node.style?.width;
              const currentHeight = node.style?.height;
              const newWidth = change.dimensions.width;
              const newHeight = change.dimensions.height;

              // Skip if dimensions haven't changed (tolerance of 1px for floating point)
              if (
                currentWidth &&
                currentHeight &&
                Math.abs(Number(currentWidth) - newWidth) < 1 &&
                Math.abs(Number(currentHeight) - newHeight) < 1
              ) {
                return;
              }

              // An unloaded board's zone geometry may be stale: no write.
              const ticket = boardGuard.capture();
              if (!ticket) return;
              // Accumulate resize updates
              pendingResizeUpdatesRef.current[change.id] = {
                width: newWidth,
                height: newHeight,
                ticket,
              };

              // Clear existing timer
              if (resizeTimerRef.current) {
                clearTimeout(resizeTimerRef.current);
              }

              // Debounce: wait 500ms after last resize before persisting
              resizeTimerRef.current = setTimeout(async () => {
                const updates = pendingResizeUpdatesRef.current;
                pendingResizeUpdatesRef.current = {};

                if (!client) return;
                let dropped = false;

                // Persist all resize changes
                for (const [nodeId, { width, height, ticket }] of Object.entries(updates)) {
                  // Checked before every PATCH, including after awaiting the
                  // previous one. A board that unloaded (a reconnect) since the
                  // resize was queued drops it, even once it has reloaded: its
                  // full-object upsert could restore a zone deleted meanwhile.
                  if (!boardGuard.isCurrent(ticket)) {
                    dropped = true;
                    continue;
                  }
                  // The latest record, never this closure's.
                  const latestBoard = placementBoardRef.current;
                  const objectData =
                    latestBoard?.board_id === ticket.boardId
                      ? latestBoard.objects?.[nodeId]
                      : undefined;
                  if (objectData && objectData.type === 'zone') {
                    const updatedObject = { ...objectData, width, height };

                    try {
                      await client.service('boards').patch(ticket.boardId, {
                        _action: 'upsertObject',
                        objectId: nodeId,
                        objectData: updatedObject,
                      } as unknown as Partial<Board>);
                    } catch (error) {
                      console.error('Failed to persist zone resize:', error);
                    }
                  }
                }
                if (dropped) {
                  boardGuard.warnDropped('This board reloaded; your last resize was not saved.');
                }
              }, 500);
            }
          }
        });

        // Call the original handler
        onNodesChangeInternal(changes);
      },
      [client, onNodesChangeInternal, setNodes, boardGuard]
    );

    // Handle node drag start
    const handleNodeDragStart: NodeDragHandler = useCallback(() => {
      isDraggingRef.current = true;
    }, []);

    // Handle node drag - track local position changes
    const handleNodeDrag: NodeDragHandler = useCallback((_event, node) => {
      // Track this position locally so we don't get overwritten by WebSocket updates
      // IMPORTANT: Store ABSOLUTE position, not relative!
      const absolutePos = node.positionAbsolute || node.position;
      localPositionsRef.current[node.id] = {
        x: absolutePos.x,
        y: absolutePos.y,
      };
    }, []);

    // Handle node drag end - persist layout to board (debounced)
    const handleNodeDragStop: NodeDragHandler = useCallback(
      (_event, node) => {
        if (!board || !client || !reactFlowInstanceRef.current) return;

        // Render closures can lag a realtime event. Capture intent against the
        // live row, and re-read it after awaits (including before create/trigger).
        const getLivePlacement = (nodeId: string) =>
          agorStore
            .getState()
            .boardObjectsByBoardId.get(board.board_id)
            ?.find(
              (row) => row.branch_id === nodeId || (row.card_id && `card-${row.card_id}` === nodeId)
            );

        // Reset dragging flag immediately to allow node sync effects to run
        isDraggingRef.current = false;
        // Never derive a zone from a board that isn't loaded: the move's
        // ticket is captured now and checked before each of its dispatches.
        const guard = node.type === 'comment' ? commentGuard : boardGuard;
        const ticket = guard.capture();
        if (!ticket) return;

        // Track final position locally
        // IMPORTANT: Store ABSOLUTE position, not relative!
        const absolutePos = node.positionAbsolute || node.position;
        localPositionsRef.current[node.id] = {
          x: absolutePos.x,
          y: absolutePos.y,
        };

        // Accumulate position updates
        // IMPORTANT: Store ABSOLUTE position for consistency!
        pendingLayoutUpdatesRef.current[node.id] = {
          x: absolutePos.x,
          y: absolutePos.y,
          ticket,
          guard,
          ...(node.type === 'branchNode' || node.type === 'cardNode'
            ? {
                intent: placementWrites.queue(node.id, getLivePlacement(node.id), board),
              }
            : {}),
        };

        // Clear existing timer
        if (layoutUpdateTimerRef.current) {
          clearTimeout(layoutUpdateTimerRef.current);
        }

        // Debounce: wait 500ms after last drag before persisting
        layoutUpdateTimerRef.current = setTimeout(async () => {
          const updates = pendingLayoutUpdatesRef.current;
          pendingLayoutUpdatesRef.current = {};
          // Checked immediately before each dispatch below, including every
          // dispatch after an await: a move queued before the board unloaded
          // (a reconnect) is dropped, even once the board has reloaded.
          let dropped = false;
          const mayDispatch = (nodeId: string) => {
            const update = updates[nodeId];
            if (update?.guard.isCurrent(update.ticket)) return true;
            dropped = true;
            return false;
          };

          try {
            // Separate updates for branches vs zones vs markdown vs comments
            const branchUpdates: Array<{
              branch_id: string;
              position: { x: number; y: number };
              zone_id?: string | null;
            }> = [];
            const zoneUpdates: Record<string, { x: number; y: number }> = {};
            const markdownUpdates: Record<string, { x: number; y: number }> = {};
            const artifactUpdates: Record<string, { x: number; y: number }> = {};
            const commentUpdates: Array<{
              nodeId: string;
              comment: BoardComment;
              position: { x: number; y: number };
              parentId?: string;
              parentType?: 'zone' | 'branch';
            }> = [];

            // A batch may suspend on another entity's PATCH after draining the
            // pending ref. Recheck the store immediately before each dispatch;
            // clearing that ref during reconciliation cannot cancel this batch.
            const placementIsCurrent = (
              placement: BoardEntityObject | undefined,
              branchId?: string
            ) => {
              // Cached rows on the previous board can still compare equal,
              // especially when unpinned (there is no parent zone frame).
              if (placementBoardRef.current?.board_id !== board.board_id) return false;
              const current = agorStore
                .getState()
                .boardObjectsByBoardId.get(board.board_id)
                ?.find((candidate) =>
                  placement
                    ? candidate.object_id === placement.object_id
                    : candidate.branch_id === branchId
                );
              if (placementWritesRef.current !== placementWrites) return false;
              const nodeId =
                branchId ??
                (placement?.card_id ? `card-${placement.card_id}` : placement?.branch_id);
              const intent = nodeId ? updates[nodeId]?.intent : undefined;
              if (intent) {
                placementWrites.observe(intent.nodeId, current, placementBoardRef.current);
                return placementWrites.current(intent);
              }
              return sameBoardEntityPlacement(
                snapshotBoardEntityPlacement(placement, board),
                snapshotBoardEntityPlacement(current, placementBoardRef.current)
              );
            };

            const patchPlacement = async (
              nodeId: string,
              placement: BoardEntityObject,
              position: BoardEntityObject['position'],
              zoneId: string | null | undefined
            ) => {
              const intent = updates[nodeId]?.intent;
              if (!intent) return;
              const data = { position, zone_id: zoneId ?? null };
              await placementWrites.dispatch(
                intent,
                { ...placement, ...data } as BoardEntityObject,
                board,
                (placement_write_id) =>
                  client
                    .service('board-objects')
                    .patch(placement.object_id, { ...data, placement_write_id })
              );
            };

            // Find all current nodes to check types
            const currentNodes = nodes;

            for (const [nodeId, update] of Object.entries(updates)) {
              const position = { x: update.x, y: update.y };
              const draggedNode = currentNodes.find((n) => n.id === nodeId);
              if (update.intent) {
                await placementWrites.wait(nodeId)?.catch(() => {});
                if (
                  placementWritesRef.current !== placementWrites ||
                  !placementWrites.current(update.intent)
                )
                  continue;
              }

              if (draggedNode?.type === 'zone') {
                // Zone moved - update position via batchUpdateObjectPositions
                zoneUpdates[nodeId] = position;
              } else if (draggedNode?.type === 'markdown') {
                // Markdown note moved - update position via batchUpdateObjectPositions
                markdownUpdates[nodeId] = position;
              } else if (draggedNode?.type === 'artifactNode') {
                // Artifact moved - update position via batchUpdateObjectPositions
                // Board objects key is the nodeId itself (e.g. "artifact-{uuid}")
                artifactUpdates[nodeId] = position;
              } else if (draggedNode?.type === 'comment') {
                // Comment pin moved - extract comment_id from node id
                const commentId = nodeId.replace('comment-', '');
                const comment = commentById.get(commentId);
                if (!comment) continue;

                // Use the absolute position we stored at drag time
                // Don't recalculate from draggedNode because WebSocket might have already
                // updated it with a parentId, making draggedNode.position relative
                const absolutePosition = position;

                // Find zones/branches that the comment intersects with at this absolute position
                const { branchNode, zoneNode } = findIntersectingObjects(
                  absolutePosition,
                  currentNodes
                );

                let parentId: string | undefined;
                let parentType: 'zone' | 'branch' | undefined;

                if (branchNode) {
                  parentId = branchNode.id; // Branch ID has no prefix
                  parentType = 'branch';
                } else if (zoneNode) {
                  parentId = zoneNode.id.replace('zone-', ''); // Database uses ID without prefix
                  parentType = 'zone';
                }

                commentUpdates.push({
                  nodeId,
                  comment,
                  position: absolutePosition, // Always use absolute position for DB storage calculation
                  parentId,
                  parentType,
                });
              } else if (draggedNode?.type === 'cardNode') {
                // Card node moved.
                const absolutePosition = position;

                // Check zone collision (same logic as branches)
                const nodeWidth = draggedNode.width || 380;
                const nodeHeight = draggedNode.height || 120;
                const center = {
                  x: absolutePosition.x + nodeWidth / 2,
                  y: absolutePosition.y + nodeHeight / 2,
                };

                const zoneCollision = findZoneAtPosition(center, board.objects);
                const droppedZoneId = zoneCollision?.zoneId;

                let zonePosition = zoneCollision
                  ? { x: zoneCollision.zoneData.x, y: zoneCollision.zoneData.y }
                  : null;

                if (droppedZoneId) {
                  const zoneNode = currentNodes.find((n) => n.id === droppedZoneId);
                  if (zoneNode) {
                    zonePosition = { x: zoneNode.position.x, y: zoneNode.position.y };
                  }
                }

                const newParent: ParentInfo | null =
                  droppedZoneId && zonePosition
                    ? { id: droppedZoneId, position: zonePosition }
                    : null;

                const positionToStore = calculateStoragePosition(absolutePosition, newParent);

                // Find existing board_object for this card
                const existingBoardObject = getLivePlacement(nodeId);
                if (existingBoardObject) {
                  if (!placementIsCurrent(existingBoardObject)) continue;
                  if (!mayDispatch(nodeId)) continue;
                  await patchPlacement(nodeId, existingBoardObject, positionToStore, droppedZoneId);
                }
                // Cards don't fire zone triggers (V1: cards are inert in zones)
              } else if (draggedNode?.type === 'branchNode') {
                // Use the absolute position we stored at drag time
                // Don't recalculate from draggedNode because WebSocket might have already
                // updated it with a parentId, making draggedNode.position relative
                const absolutePosition = position;

                // Check if branch was dropped on a zone
                // Calculate center point for collision (use actual node dimensions if available)
                const nodeWidth = draggedNode.width || 500;
                const nodeHeight = draggedNode.height || 200;
                const center = {
                  x: absolutePosition.x + nodeWidth / 2,
                  y: absolutePosition.y + nodeHeight / 2,
                };

                // Find zone at center point
                const zoneCollision = findZoneAtPosition(center, board.objects);
                const droppedZoneId = zoneCollision?.zoneId;

                // Get the zone's ACTUAL position from React Flow nodes, not board.objects
                // board.objects might be stale if the zone was recently moved
                let zonePosition = zoneCollision
                  ? { x: zoneCollision.zoneData.x, y: zoneCollision.zoneData.y }
                  : null;

                if (droppedZoneId) {
                  const zoneNode = currentNodes.find((n) => n.id === droppedZoneId);
                  if (zoneNode) {
                    // Use the zone's current React Flow position (always absolute for zones)
                    zonePosition = { x: zoneNode.position.x, y: zoneNode.position.y };
                  }
                }

                // Check if branch was already pinned to a zone before this drag
                const existingBoardObject = getLivePlacement(nodeId);
                // A stale drop must not fire a prompt/open the picker even if
                // the later placement PATCH would be suppressed. Absence is
                // also an authority snapshot: another caller may have placed
                // this previously unplaced branch while the batch awaited.
                if (!placementIsCurrent(existingBoardObject, nodeId)) continue;
                const oldZoneId = existingBoardObject?.zone_id;

                // Calculate position to store based on new parent
                const newParent: ParentInfo | null =
                  droppedZoneId && zonePosition
                    ? {
                        id: droppedZoneId,
                        position: zonePosition,
                      }
                    : null;

                const positionToStore = calculateStoragePosition(absolutePosition, newParent);

                // Branch moved - update board_object position (null clears zone, string sets it)
                branchUpdates.push({
                  branch_id: nodeId,
                  position: positionToStore,
                  zone_id: droppedZoneId ?? null,
                });

                if (zoneCollision) {
                  const { zoneId, zoneData } = zoneCollision;

                  // Only trigger if zone assignment changed (moved to different zone or first-time pinning)
                  const zoneChanged = oldZoneId !== zoneId;

                  // Handle trigger if zone has one AND zone assignment changed
                  const trigger = zoneData.trigger;
                  if (trigger && zoneChanged && mayDispatch(nodeId)) {
                    if (trigger.behavior === 'always_new') {
                      // always_new: daemon resolves the zone, renders, creates
                      // a session, attaches inherited MCP servers, and sends
                      // the prompt — all in one round-trip. UI just identifies
                      // the zone; server is the source of truth for template,
                      // agent, and label.
                      (async () => {
                        try {
                          const { session } = (await client
                            .service(`branches/${nodeId}/fire-zone-trigger`)
                            .create({ zoneId })) as { session: Session };
                          const warning = getSessionCreationWarning(session);
                          if (warning) showWarning(warning, { duration: 10 });
                        } catch (error) {
                          console.error('❌ Failed to execute always_new trigger:', error);
                        }
                      })();
                    } else {
                      // Default: show_picker - open modal for session selection
                      setBranchTriggerModal({
                        actionId: ++nextBranchTriggerActionIdRef.current,
                        branchId: nodeId as BranchID,
                        zoneName: zoneData.label,
                        zoneId,
                        trigger,
                        sessions:
                          agorStore.getState().sessionsByBranch.get(nodeId) ?? EMPTY_SESSIONS,
                        ticket: updates[nodeId].ticket,
                      });
                    }
                  }
                }
              }
            }

            // Update branch positions in board_objects
            if (branchUpdates.length > 0) {
              for (const { branch_id, position, zone_id } of branchUpdates) {
                // Find existing board_object or create new one
                const existingBoardObject = getLivePlacement(branch_id);
                if (!placementIsCurrent(existingBoardObject, branch_id)) continue;
                if (!mayDispatch(branch_id)) continue;

                if (existingBoardObject) {
                  await patchPlacement(branch_id, existingBoardObject, position, zone_id);
                } else {
                  // Create new board_object (with zone_id if dropped on zone)
                  await client.service('board-objects').create({
                    board_id: board.board_id,
                    branch_id,
                    position,
                    // zone_id will be included if branch was dropped on zone
                    ...(zone_id ? { zone_id } : {}),
                  });
                }
              }
            }

            // Update zone, markdown and artifact positions: one request per
            // kind, each made only of moves whose ticket is still current.
            for (const group of [zoneUpdates, markdownUpdates, artifactUpdates]) {
              const current = Object.entries(group).filter(([nodeId]) => mayDispatch(nodeId));
              if (current.length === 0) continue;
              const sent = await batchUpdateObjectPositions(
                Object.fromEntries(current),
                updates[current[0][0]].ticket
              );
              if (!sent) dropped = true;
            }

            // Update comment positions
            for (const { nodeId, comment, position, parentId, parentType } of commentUpdates) {
              const reactFlowParentId =
                parentId && parentType === 'zone'
                  ? boardCommentZoneParentObjectKey(parentId)
                  : parentId && parentType === 'branch'
                    ? parentId
                    : undefined;
              const parentNode = reactFlowParentId
                ? currentNodes.find((candidate) => candidate.id === reactFlowParentId)
                : undefined;
              const plan = planBoardCommentReposition(
                comment,
                position,
                parentId && parentType && parentNode && reactFlowParentId
                  ? {
                      id: parentId,
                      type: parentType,
                      absolutePosition: getNodeAbsolutePosition(parentNode, currentNodes),
                      reactFlowParentId,
                    }
                  : undefined
              );

              if (!mayDispatch(nodeId)) continue;
              await client
                .service(`board-comments/${comment.comment_id}/reposition`)
                .create(plan.data);

              // Clear localPositionsRef immediately after patching
              // We've saved the correct position to DB, no need to keep overriding
              delete localPositionsRef.current[`comment-${comment.comment_id}`];

              // Immediately update React Flow node to reflect new parentId
              // This prevents visual glitches while waiting for WebSocket sync
              setNodes((prevNodes) =>
                prevNodes.map((n) => {
                  if (n.id === `comment-${comment.comment_id}`) {
                    // Update parentId to match new parent (or undefined if free-floating)
                    const relative = plan.data.position.relative;
                    const updates: Partial<Node> = {
                      parentId: plan.reactFlowParentId,
                      position: relative
                        ? { x: relative.offset_x, y: relative.offset_y }
                        : position,
                    };

                    return { ...n, ...updates };
                  }
                  return n;
                })
              );
            }
          } catch (error) {
            console.error('Failed to persist layout:', error);
          }
          if (dropped) {
            boardGuard.warnDropped('This board reloaded; your last move was not saved.');
          }
        }, 500);
      },
      [
        board,
        client,
        batchUpdateObjectPositions,
        nodes,
        placementWrites,
        commentById,
        setNodes,
        showWarning,
        boardGuard,
        commentGuard,
      ]
    );

    // Cleanup debounce timers on unmount
    useEffect(() => {
      return () => {
        if (layoutUpdateTimerRef.current) {
          clearTimeout(layoutUpdateTimerRef.current);
        }
        if (resizeTimerRef.current) {
          clearTimeout(resizeTimerRef.current);
        }
      };
    }, []);

    // Canvas pointer handlers for drag-to-draw zones
    const handlePointerDown = useCallback(
      (event: React.PointerEvent) => {
        if (!reactFlowInstanceRef.current) return;

        // Zone tool: start drag-to-draw
        if (activeTool === 'zone') {
          // Use clientX/Y for coordinates relative to viewport
          setDrawingZone({
            start: { x: event.clientX, y: event.clientY },
            end: { x: event.clientX, y: event.clientY },
            ticket: boardGuard.capture(),
          });
        }
      },
      [activeTool, boardGuard]
    );

    const handlePointerMove = useCallback(
      (event: React.PointerEvent) => {
        if (activeTool === 'zone' && drawingZone && event.buttons === 1) {
          setDrawingZone({
            ...drawingZone,
            end: { x: event.clientX, y: event.clientY },
          });
        }
      },
      [activeTool, drawingZone]
    );

    const handlePointerUp = useCallback(() => {
      if (activeTool === 'zone' && drawingZone && reactFlowInstanceRef.current) {
        // Bail out if the daemon isn't usable or the board reloaded since the
        // gesture began — it is discarded rather than persisted.
        const { start, end, ticket } = drawingZone;
        if (!boardGuard.isCurrent(ticket)) {
          setDrawingZone(null);
          setActiveTool('select');
          return;
        }

        // Calculate position and dimensions in screen space
        const minX = Math.min(start.x, end.x);
        const minY = Math.min(start.y, end.y);
        const screenWidth = Math.abs(end.x - start.x);
        const screenHeight = Math.abs(end.y - start.y);

        // Only create zone if dragged (not just clicked)
        if (screenWidth > 50 && screenHeight > 50) {
          const position = reactFlowInstanceRef.current.screenToFlowPosition({
            x: minX,
            y: minY,
          });

          // Convert dimensions to flow space (account for zoom)
          const viewport = reactFlowInstanceRef.current.getViewport();
          const width = screenWidth / viewport.zoom;
          const height = screenHeight / viewport.zoom;

          // Create zone with drawn dimensions
          const objectId = `zone-${Date.now()}`;

          // Default colors for new zones
          const objectData: BoardObject = {
            type: 'zone',
            x: position.x,
            y: position.y,
            width,
            height,
            label: 'New Zone',
            // biome-ignore lint/plugin/noHardcodedColorLiteral: persisted neutral default for user-editable zone palettes
            borderColor: '#d9d9d9',
            // biome-ignore lint/plugin/noHardcodedColorLiteral: persisted translucent default for user-editable zone palettes
            backgroundColor: '#d9d9d91a', // 10% opacity
          };

          // Optimistic update: built like a hydrated node, so an editor
          // opened before the first ack captures its ticket when it opens.
          setNodes((nodes) => [...nodes, buildObjectNode(objectId, objectData)]);

          // Persist to backend (no await since the ticket check above)
          if (client) {
            client
              .service('boards')
              .patch(ticket.boardId, {
                _action: 'upsertObject',
                objectId,
                objectData,
              } as unknown as Partial<Board>)
              .catch((error: unknown) => {
                console.error('Failed to add zone:', error);
                setNodes((nodes) => nodes.filter((n) => n.id !== objectId));
              });
          }
        }

        setDrawingZone(null);
        setActiveTool('select');
      }
    }, [activeTool, drawingZone, client, setNodes, boardGuard, buildObjectNode]);

    const openMarkdownPlacementModal = useCallback(
      (event: Pick<React.MouseEvent, 'clientX' | 'clientY'>): boolean => {
        if (!canMutateBoard || !reactFlowInstanceRef.current || markdownModalOpenRef.current) {
          return false;
        }

        const position = reactFlowInstanceRef.current.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });

        markdownModalOpenRef.current = true;
        setMarkdownModal({ position, ticket: boardGuard.capture() });
        return true;
      },
      [canMutateBoard, boardGuard]
    );

    // Pane click handler for comment placement
    const handlePaneClick = useCallback(
      (event: React.MouseEvent) => {
        if (activeTool === 'comment' && canMutateComments && reactFlowInstanceRef.current) {
          // Use screenToFlowPosition which automatically handles all offsets (including CommentsPanel)
          const position = reactFlowInstanceRef.current.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          });

          setCommentPlacement({
            position, // React Flow coordinates for storing in DB
            screenPosition: { x: event.clientX, y: event.clientY }, // Screen coords for popover
            ticket: commentGuard.capture(),
          });
        }

        // Markdown tool: click-to-place
        if (activeTool === 'markdown') {
          openMarkdownPlacementModal(event);
        }
      },
      [activeTool, canMutateComments, openMarkdownPlacementModal, commentGuard]
    );

    // Handler to create spatial comment
    const handleCreateSpatialComment = useCallback(async () => {
      if (!commentPlacement || !board || !client || !currentUserId || !commentInput.trim()) {
        return;
      }
      // Unavailable for now (disconnected, still loading): keep the draft.
      if (!canMutateComments) {
        return;
      }
      // Placed before a board reload: its anchor geometry may be gone.
      if (!commentGuard.isCurrent(commentPlacement.ticket)) {
        commentGuard.warnDropped('This board reloaded; place your comment again.');
        setCommentPlacement(null);
        return;
      }

      try {
        const position = commentPlacement.position;

        // Check what object the comment was placed on (zone or branch)
        // Get all current nodes with their measured dimensions
        const currentNodes = reactFlowInstanceRef.current?.getNodes() || [];

        // Find zones/branches that the comment intersects with
        const { branchNode, zoneNode } = findIntersectingObjects(position, currentNodes);

        // Prepare comment data based on placement target
        const commentData: BoardCommentCreate = {
          board_id: board.board_id,
          content: commentInput.trim(),
        };

        if (branchNode) {
          // Comment pinned to branch - use FK + relative positioning
          const branchId = branchNode.id; // Branch ID has no prefix
          commentData.branch_id = branchId as BranchID;
          commentData.position = {
            relative: {
              parent_id: branchId,
              parent_type: 'branch',
              offset_x: position.x - branchNode.position.x,
              offset_y: position.y - branchNode.position.y,
            },
          };
        } else if (zoneNode) {
          // Comment pinned to zone - use relative positioning
          const zoneId = zoneNode.id.replace('zone-', ''); // Extract zone object ID
          commentData.position = {
            relative: {
              parent_id: zoneId,
              parent_type: 'zone',
              offset_x: position.x - zoneNode.position.x,
              offset_y: position.y - zoneNode.position.y,
            },
          };
        } else {
          // Free-floating comment - use absolute positioning
          commentData.position = {
            absolute: position,
          };
        }

        await client.service('board-comments').create(commentData);

        // Reset state
        setCommentPlacement(null);
        setCommentInput('');
        setActiveTool('select');
      } catch (error) {
        console.error('Failed to create spatial comment:', error);
      }
    }, [
      commentPlacement,
      board,
      client,
      currentUserId,
      commentInput,
      canMutateComments,
      commentGuard,
    ]);

    const closeMarkdownModal = useCallback(() => {
      markdownModalOpenRef.current = false;
      setMarkdownModal(null);
      setMarkdownContent('');
      setMarkdownWidth(500);
      setActiveTool('select');
    }, []);

    // Create/update a markdown note under the ticket captured when the editor
    // opened. A refused save keeps the editor open with its draft (see
    // `markdownModal.stale`).
    const handleCreateMarkdownNote = useCallback(async () => {
      if (!markdownModal || markdownModal.stale || !board || !client || !markdownContent.trim()) {
        return;
      }
      const { ticket } = markdownModal;
      // Unavailable for now (disconnected, still loading): keep the draft.
      if (!canMutateBoard) {
        return;
      }
      // Opened before a board reload: saving could restore a note deleted
      // meanwhile, or overwrite edits made since. Nothing is sent, and the
      // draft stays to copy or discard (no await between this check and the
      // write).
      if (!boardGuard.isCurrent(ticket)) {
        setMarkdownModal((current) => (current ? { ...current, stale: true } : current));
        return;
      }

      const objectId = markdownModal.objectId || `markdown-${Date.now()}`;
      const saved = markdownModal.objectId ? board.objects?.[objectId] : undefined;
      const position = markdownModal.position;
      const objectData: BoardObject = {
        type: 'markdown',
        x: position.x,
        y: position.y,
        width: markdownWidth,
        content: markdownContent,
      };

      // Optimistic update
      setNodes((nodes) => {
        // If editing, update existing node
        if (markdownModal.objectId && nodes.some((n) => n.id === objectId)) {
          return nodes.map((n) =>
            n.id === objectId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    content: markdownContent,
                    width: markdownWidth,
                  },
                }
              : n
          );
        }

        // If creating new, add a node built like a hydrated one (its
        // confirmations capture their ticket when they open).
        return [...nodes, buildObjectNode(objectId, objectData)];
      });

      // Persist to backend
      setMarkdownModal((current) => (current ? { ...current, saveError: undefined } : current));
      try {
        await client.service('boards').patch(ticket.boardId, {
          _action: 'upsertObject',
          objectId,
          objectData,
        } as unknown as Partial<Board>);
      } catch (error) {
        console.error('Failed to save markdown note:', error);
        // Rollback optimistic update: the note shows what is saved.
        if (!markdownModal.objectId) {
          setNodes((nodes) => nodes.filter((n) => n.id !== objectId));
        } else if (saved?.type === 'markdown') {
          setNodes((nodes) =>
            nodes.map((n) =>
              n.id === objectId
                ? { ...n, data: { ...n.data, content: saved.content, width: saved.width } }
                : n
            )
          );
        }
        // Keep the editor open with the draft; only a successful save closes it.
        const reason = error instanceof Error && error.message ? error.message : String(error);
        setMarkdownModal((current) => (current ? { ...current, saveError: reason } : current));
        return;
      }

      closeMarkdownModal();
    }, [
      markdownModal,
      board,
      client,
      markdownContent,
      markdownWidth,
      setNodes,
      buildObjectNode,
      canMutateBoard,
      boardGuard,
      closeMarkdownModal,
    ]);

    // Node click handler for eraser mode and comment placement
    const handleNodeClick = useCallback(
      (event: React.MouseEvent, node: Node) => {
        if (activeTool === 'eraser') {
          if (!canMutateBoard) {
            return;
          }
          // Only delete board objects (zones, markdown), not branches
          if (node.type === 'zone' || node.type === 'markdown') {
            deleteObject(node.id, boardGuard.capture());
          }
          return;
        }

        if (activeTool === 'comment' && canMutateComments && reactFlowInstanceRef.current) {
          // Allow comment placement on sessions and zones
          if (node.type === 'branchNode' || node.type === 'zone') {
            // Use screenToFlowPosition which automatically handles all offsets (including CommentsPanel)
            const position = reactFlowInstanceRef.current.screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            });

            setCommentPlacement({
              position, // React Flow coordinates for storing in DB
              screenPosition: { x: event.clientX, y: event.clientY }, // Screen coords for popover
              ticket: commentGuard.capture(),
            });
          }
          return;
        }

        if (activeTool === 'markdown') {
          // `onPaneClick` only fires when the pointer lands on the bare canvas.
          // Boards often contain large zones/cards that cover the viewport; in
          // those cases React Flow routes the click through `onNodeClick`
          // instead. Treat node clicks as valid markdown placement clicks so
          // the Add Markdown Note tool works regardless of what is under the
          // cursor.
          openMarkdownPlacementModal(event);
          return;
        }

        // Bring clicked card to front (zones and comments are excluded from this)
        if (node.type !== 'zone' && node.type !== 'comment') {
          setNodes((nds) => {
            const raisable = nds.filter((n) => n.type !== 'zone' && n.type !== 'comment');
            const currentZ = nds.find((n) => n.id === node.id)?.zIndex ?? 0;
            const isAlreadyOnTop = raisable.every(
              (n) => n.id === node.id || (n.zIndex ?? 0) < currentZ
            );
            if (isAlreadyOnTop) return nds;
            const maxZ = Math.max(0, ...raisable.map((n) => n.zIndex ?? 0));
            return nds.map((n) => (n.id === node.id ? { ...n, zIndex: maxZ + 1 } : n));
          });
        }
      },
      [
        activeTool,
        deleteObject,
        canMutateBoard,
        canMutateComments,
        openMarkdownPlacementModal,
        setNodes,
        commentGuard,
        boardGuard,
      ]
    );

    // Clear comment placement state when switching away from comment tool
    useEffect(() => {
      if (activeTool !== 'comment' && commentPlacement) {
        setCommentPlacement(null);
        setCommentInput('');
      }
    }, [activeTool, commentPlacement]);

    // Snap back to the select tool when the mutation gate closes so that a
    // half-engaged mode (e.g. mid-drag zone) doesn't sit armed during the
    // disconnect/grace/out-of-sync window.
    useEffect(() => {
      const toolIsUnavailable =
        (activeTool === 'comment' && !canMutateComments) ||
        (activeTool !== 'select' && activeTool !== 'comment' && !canMutateBoard);
      if (toolIsUnavailable) {
        setActiveTool('select');
        setDrawingZone(null);
        setCommentPlacement(null);
        setCommentInput('');
        // Preserve an already-open Markdown editor and its draft. Its Save
        // action is permission-gated below until editing becomes available.
      }
    }, [canMutateBoard, canMutateComments, activeTool]);

    return (
      <div
        style={{
          width: '100%',
          height,
          position: 'relative',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Drawing preview for zone */}
        {drawingZone && (
          <div
            style={{
              position: 'fixed',
              left: Math.min(drawingZone.start.x, drawingZone.end.x),
              top: Math.min(drawingZone.start.y, drawingZone.end.y),
              width: Math.abs(drawingZone.end.x - drawingZone.start.x),
              height: Math.abs(drawingZone.end.y - drawingZone.start.y),
              border: `2px dashed ${token.colorPrimary}`,
              background: token.colorPrimaryBg,
              pointerEvents: 'none',
              zIndex: 1000,
            }}
          />
        )}

        {scopedCustomCss && <style>{scopedCustomCss}</style>}
        <BoardPartitionStatus boardId={board?.board_id} />
        <div
          ref={reactFlowWrapperRef}
          className={boardCssClass || undefined}
          style={{
            width: '100%',
            height: '100%',
            background: canvasBackground,
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={handleNodeDragStart}
            onNodeDrag={handleNodeDrag}
            onNodeDragStop={handleNodeDragStop}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            onInit={(instance) => {
              reactFlowInstanceRef.current = instance;
              setIsReactFlowReady(true);
            }}
            onMoveEnd={
              readOnly && board
                ? (_event, viewport) => saveViewport(board.board_id, viewport)
                : undefined
            }
            nodeTypes={nodeTypes}
            snapToGrid={true}
            snapGrid={[20, 20]}
            minZoom={0.1}
            maxZoom={1.5}
            // The connection gate is global; each node carries its narrower
            // authorization (board.edit for structure, author/admin for
            // comments). Selection/focus remain available in read-only mode.
            nodesDraggable={mutationGate.canMutate && !readOnly}
            nodesConnectable={false}
            elementsSelectable={true}
            elevateNodesOnSelect={false}
            // Two-finger scrolling to pan when in select mode (Figma-style)
            // Also allow click-drag to pan since selection box isn't useful here
            // Disable all panning when actively drawing a zone to prevent interference
            panOnScroll={activeTool === 'select' && !drawingZone}
            panOnDrag={!drawingZone} // Always allow drag to pan (left mouse in select, any in other modes)
            selectionOnDrag={false} // Disable selection box - not useful for branch cards
            className={`tool-mode-${activeTool}`}
            // Disable React Flow's keyboard shortcuts that conflict with typing/spatial messages.
            // Keep modifier-scroll zoom enabled so Command/Control + scroll behaves like Figma.
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            panActivationKeyCode={null}
            zoomActivationKeyCode={['Meta', 'Control']}
            disableKeyboardA11y={true}
            style={{ background: 'transparent' }}
          >
            {!canvasBackground && <Background />}
            {/* View-only canvas: no edit controls or minimap, not even hidden (the minimap redraws on every pan). */}
            {!readOnly && (
              <Controls
                position="top-left"
                showZoom={false}
                showFitView={false}
                showInteractive={false}
              >
                {/* Zoom controls */}
                <Tooltip title="Zoom In" placement="right" mouseEnterDelay={0.3}>
                  <span>
                    <ControlButton
                      onClick={(e) => {
                        e.stopPropagation();
                        reactFlowInstanceRef.current?.zoomIn();
                      }}
                    >
                      <PlusOutlined style={{ fontSize: '16px' }} />
                    </ControlButton>
                  </span>
                </Tooltip>
                <Tooltip title="Zoom Out" placement="right" mouseEnterDelay={0.3}>
                  <span>
                    <ControlButton
                      onClick={(e) => {
                        e.stopPropagation();
                        reactFlowInstanceRef.current?.zoomOut();
                      }}
                    >
                      <MinusOutlined style={{ fontSize: '16px' }} />
                    </ControlButton>
                  </span>
                </Tooltip>
                <Tooltip title="Fit View" placement="right" mouseEnterDelay={0.3}>
                  <span>
                    <ControlButton
                      onClick={(e) => {
                        e.stopPropagation();
                        reactFlowInstanceRef.current?.fitView();
                      }}
                    >
                      <ZoomInOutlined style={{ fontSize: '16px' }} />
                    </ControlButton>
                  </span>
                </Tooltip>
                {/* Custom toolbox buttons */}
                <Tooltip title="Select" placement="right" mouseEnterDelay={0.3}>
                  <span>
                    <ControlButton
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveTool('select');
                      }}
                      style={{
                        borderLeft:
                          activeTool === 'select'
                            ? `${token.lineWidth * 3}px ${token.lineType} ${token.colorPrimary}`
                            : 'none',
                      }}
                    >
                      <SelectOutlined style={{ fontSize: '16px' }} />
                    </ControlButton>
                  </span>
                </Tooltip>
                <Tooltip
                  title={canMutateBoard ? 'Add Zone' : (boardMutationMessage ?? 'Add Zone')}
                  placement="right"
                  mouseEnterDelay={0.3}
                >
                  <span>
                    <ControlButton
                      aria-label="Add Zone"
                      disabled={!canMutateBoard}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveTool('zone');
                      }}
                      style={{
                        borderLeft:
                          activeTool === 'zone'
                            ? `${token.lineWidth * 3}px ${token.lineType} ${token.colorPrimary}`
                            : 'none',
                        opacity: canMutateBoard ? 1 : 0.4,
                        cursor: canMutateBoard ? 'pointer' : 'not-allowed',
                      }}
                    >
                      <BorderOutlined style={{ fontSize: '16px' }} />
                    </ControlButton>
                  </span>
                </Tooltip>
                <Tooltip
                  title={
                    canMutateComments ? 'Add Comment' : (commentMutationMessage ?? 'Add Comment')
                  }
                  placement="right"
                  mouseEnterDelay={0.3}
                >
                  <span>
                    <ControlButton
                      aria-label="Add Comment"
                      disabled={!canMutateComments}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveTool('comment');
                      }}
                      style={{
                        borderLeft:
                          activeTool === 'comment'
                            ? `${token.lineWidth * 3}px ${token.lineType} ${token.colorPrimary}`
                            : 'none',
                        opacity: canMutateComments ? 1 : 0.4,
                        cursor: canMutateComments ? 'pointer' : 'not-allowed',
                      }}
                    >
                      <CommentOutlined style={{ fontSize: '16px' }} />
                    </ControlButton>
                  </span>
                </Tooltip>
                <Tooltip
                  title={
                    canMutateBoard
                      ? 'Add Markdown Note — click canvas to place'
                      : (boardMutationMessage ?? 'Add Markdown Note — click canvas to place')
                  }
                  placement="right"
                  mouseEnterDelay={0.3}
                >
                  <span>
                    <ControlButton
                      aria-label="Add Markdown Note"
                      disabled={!canMutateBoard}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveTool('markdown');
                      }}
                      style={{
                        borderLeft:
                          activeTool === 'markdown'
                            ? `${token.lineWidth * 3}px ${token.lineType} ${token.colorPrimary}`
                            : 'none',
                        opacity: canMutateBoard ? 1 : 0.4,
                        cursor: canMutateBoard ? 'pointer' : 'not-allowed',
                      }}
                    >
                      <FileMarkdownOutlined style={{ fontSize: '16px' }} />
                    </ControlButton>
                  </span>
                </Tooltip>
                <Tooltip
                  title={
                    canMutateBoard ? 'Eraser - Click to toggle' : (boardMutationMessage ?? 'Eraser')
                  }
                  placement="right"
                  mouseEnterDelay={0.3}
                >
                  <span>
                    <ControlButton
                      aria-label="Eraser"
                      disabled={!canMutateBoard}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveTool(activeTool === 'eraser' ? 'select' : 'eraser');
                      }}
                      style={{
                        borderLeft:
                          activeTool === 'eraser' ? `3px solid ${token.colorError}` : 'none',
                        color: activeTool === 'eraser' ? token.colorError : 'inherit',
                        backgroundColor:
                          activeTool === 'eraser' ? `${token.colorError}15` : 'transparent',
                        opacity: canMutateBoard ? 1 : 0.4,
                        cursor: canMutateBoard ? 'pointer' : 'not-allowed',
                      }}
                    >
                      <DeleteOutlined style={{ fontSize: '16px' }} />
                    </ControlButton>
                  </span>
                </Tooltip>
              </Controls>
            )}
            {!readOnly && (
              <MiniMap
                nodeColor={miniMapNodeColor}
                onClick={handleMiniMapClick}
                pannable
                zoomable
                style={{
                  backgroundColor: token.colorBgElevated,
                  border: `1px solid ${token.colorBorder}`,
                }}
                maskColor="rgba(0, 0, 0, 0.5)"
                maskStrokeColor={token.colorPrimary}
                maskStrokeWidth={2}
              />
            )}
            <RemoteCursorLayer
              client={client}
              boardId={(board?.board_id as BoardID | null) ?? null}
              users={mapToArray(userById)}
              enabled={!!board && !!client}
              staticCursors={staticCursors}
              staticCursorScale={staticCursorScale}
            />
          </ReactFlow>
        </div>

        {/* Spatial comment placement popover */}
        {commentPlacement && (
          <Popover
            open={true}
            content={
              <div style={{ width: 300 }}>
                <div style={{ marginBottom: 8 }}>
                  <AutocompleteTextarea
                    placeholder="Add a comment... (type @ for users, : for emojis)"
                    value={commentInput}
                    onChange={setCommentInput}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (commentInput.trim()) {
                          handleCreateSpatialComment();
                        }
                      }
                    }}
                    autoSize={{ minRows: 3, maxRows: 6 }}
                    client={client}
                    sessionId={null}
                    userById={userById}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <Button
                    onClick={() => {
                      setCommentPlacement(null);
                      setCommentInput('');
                      setActiveTool('select');
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="primary"
                    onClick={handleCreateSpatialComment}
                    disabled={!commentInput.trim()}
                  >
                    Comment
                  </Button>
                </div>
              </div>
            }
            // Position the popover at the click location
            getPopupContainer={() => document.body}
          >
            <div
              style={{
                position: 'fixed',
                left: commentPlacement.screenPosition.x,
                top: commentPlacement.screenPosition.y,
                width: 1,
                height: 1,
                pointerEvents: 'none',
              }}
            />
          </Popover>
        )}

        {/* Markdown note creation/edit modal */}
        {markdownModal && (
          <Modal
            open={true}
            title={markdownModal.objectId ? 'Edit Markdown Note' : 'Add Markdown Note'}
            onCancel={closeMarkdownModal}
            onOk={handleCreateMarkdownNote}
            okText={markdownModal.objectId ? 'Save' : 'Create'}
            okButtonProps={{
              disabled: markdownModal.stale || !markdownContent.trim() || !canMutateBoard,
            }}
            width={1000}
          >
            {markdownModal.saveError && !markdownModal.stale && (
              <Alert
                type="error"
                showIcon
                title="Note not saved."
                description={markdownModal.saveError}
                style={{ marginBottom: 16 }}
              />
            )}
            {markdownModal.stale && (
              <Alert
                type="warning"
                showIcon
                title={STALE_DRAFT_TITLE}
                description={
                  markdownModal.objectId && !board?.objects?.[markdownModal.objectId]
                    ? 'This note no longer exists on the reloaded board, so your draft was not saved. Copy your draft to keep it.'
                    : markdownModal.objectId
                      ? 'This board reloaded while the note was open, so your draft was not saved over it. Copy your draft to keep it, then reopen the note to edit the reloaded one.'
                      : 'This board reloaded while the note was open, so it was not created. Copy your draft to keep it, then add the note again.'
                }
                action={
                  <Space orientation="vertical" size="small">
                    <Button size="small" onClick={() => void copyDraft(markdownContent)}>
                      Copy draft
                    </Button>
                    <Button size="small" type="text" onClick={closeMarkdownModal}>
                      Discard
                    </Button>
                  </Space>
                }
                style={{ marginBottom: 16 }}
              />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 16 }}>
              {/* Width selector */}
              <div>
                <Typography.Text strong>Width:</Typography.Text>
                <Slider
                  min={200}
                  max={2000}
                  step={100}
                  value={markdownWidth}
                  onChange={setMarkdownWidth}
                  marks={{
                    200: '200px',
                    500: '500px',
                    1000: '1000px',
                    1500: '1500px',
                    2000: '2000px',
                  }}
                  style={{ marginTop: 8 }}
                />
              </div>
            </div>

            {/* Side-by-side layout for editor and preview */}
            <div style={{ display: 'flex', gap: 16 }}>
              {/* Left: Markdown textarea */}
              <div style={{ flex: 1 }}>
                <Typography.Text strong>Content (Markdown supported):</Typography.Text>
                <Input.TextArea
                  value={markdownContent}
                  onChange={(e) => setMarkdownContent(e.target.value)}
                  placeholder={`# Title\n\n- Bullet point\n- Another point\n\n**Bold** and *italic*\n\n\`\`\`javascript\nconst code = "example";\n\`\`\``}
                  autoFocus
                  rows={20}
                  style={{ fontFamily: 'monospace', marginTop: 8, height: '500px' }}
                />
              </div>

              {/* Right: Preview */}
              <div style={{ flex: 1 }}>
                <Typography.Text strong>Preview:</Typography.Text>
                <div
                  style={{
                    marginTop: 8,
                    padding: 12,
                    border: `1px solid ${token.colorBorder}`,
                    borderRadius: 4,
                    height: '500px',
                    overflow: 'auto',
                    background: token.colorBgContainer,
                  }}
                >
                  {markdownContent.trim() ? (
                    <MarkdownRenderer content={markdownContent} />
                  ) : (
                    <Typography.Text type="secondary">Preview will appear here...</Typography.Text>
                  )}
                </div>
              </div>
            </div>
          </Modal>
        )}

        {/* Unsaved zone drafts whose zone left the canvas: copy or discard */}
        {lostZoneDrafts.length > 0 && (
          <Modal
            open={true}
            title="Zone changes not saved"
            onCancel={() => setLostZoneDrafts([])}
            footer={[
              <Button
                key="copy"
                onClick={() =>
                  void copyDraft(lostZoneDrafts.map((draft) => draft.text).join('\n\n'))
                }
              >
                Copy draft
              </Button>,
              <Button key="discard" onClick={() => setLostZoneDrafts([])}>
                Discard
              </Button>,
            ]}
          >
            {lostZoneDrafts.map((draft) => (
              <div key={draft.key} style={{ marginBottom: 16 }}>
                <Alert
                  type="warning"
                  showIcon
                  title={
                    board?.objects?.[draft.objectId]
                      ? `Zone "${draft.zoneName}" was reloaded while you were editing it.`
                      : `Zone "${draft.zoneName}" no longer exists.`
                  }
                  description="Your changes were not saved. Copy your draft to keep it."
                  style={{ marginBottom: 8 }}
                />
                <Input.TextArea
                  aria-label={`Unsaved draft for zone ${draft.zoneName}`}
                  value={draft.text}
                  readOnly
                  autoSize={{ minRows: 2, maxRows: 10 }}
                />
              </div>
            ))}
          </Modal>
        )}

        {/* Branch Zone Trigger Modal */}
        {branchTriggerModal && (
          <BranchZoneTriggerModal
            modal={branchTriggerModal}
            onCancel={handleCancelBranchTrigger}
            client={client}
            branch={branches.find((branch) => branch.branch_id === branchTriggerModal.branchId)}
            board={board}
            availableAgents={availableAgents}
            currentUser={currentUserId ? userById.get(currentUserId) || null : null}
            onExecute={handleExecuteBranchTrigger}
          />
        )}

        {/* Card Detail Modal */}
        {selectedCard && (
          <CardModal
            open={cardModalOpen}
            card={selectedCard}
            board={board}
            readOnlyReason={boardReady ? undefined : 'This board is still loading.'}
            requireLoadedBoard
            zoneName={
              selectedCard
                ? (() => {
                    const bo = boardObjectByCard.get(selectedCard.card_id);
                    return bo?.zone_id ? zoneLabels[bo.zone_id] || undefined : undefined;
                  })()
                : undefined
            }
            zoneColor={
              selectedCard
                ? (() => {
                    const bo = boardObjectByCard.get(selectedCard.card_id);
                    if (!bo?.zone_id) return undefined;
                    const zoneObj = board?.objects?.[bo.zone_id];
                    return zoneObj && zoneObj.type === 'zone'
                      ? zoneObj.borderColor || zoneObj.color
                      : undefined;
                  })()
                : undefined
            }
            client={client}
            onClose={() => {
              setCardModalOpen(false);
            }}
            afterClose={() => setSelectedCard(null)}
            onCardUpdated={(updatedCard) => {
              setSelectedCard(updatedCard);
            }}
            onCardDeleted={() => {
              setCardModalOpen(false);
            }}
          />
        )}
      </div>
    );
  }
);

SessionCanvasInner.displayName = 'SessionCanvas';

// Memoized so the canvas is insulated from its parent's top-down re-renders:
// AgorApp re-renders on every live store patch, but SessionCanvas re-renders only
// when one of its own props actually changes OR one of its `useAgorStore`
// selector slices fires. The bailout holds only while the parent keeps every
// prop referentially stable (see the stabilized handlers at the App render site).
const SessionCanvas = React.memo(SessionCanvasInner);

export default SessionCanvas;
