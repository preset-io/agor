import type { AgorClient } from '@agor/core/api';
import type {
  AgenticToolName,
  Board,
  BoardComment,
  BoardCommentCreate,
  BoardEntityObject,
  BoardID,
  BoardObject,
  MCPServer,
  Repo,
  Session,
  SpawnConfig,
  User,
  UserID,
  Worktree,
  WorktreeID,
  ZoneTrigger,
} from '@agor/core/types';
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
import { Button, Input, Modal, Popover, Slider, Tooltip, Typography, theme } from 'antd';
import Handlebars from 'handlebars';
import {
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
  MiniMap,
  type Node,
  type NodeDragHandler,
  ReactFlow,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './SessionCanvas.css';
import { mapToArray } from '@/utils/mapHelpers';
import { DEFAULT_BACKGROUNDS } from '../../constants/ui';
import { useCursorTracking } from '../../hooks/useCursorTracking';
import { usePresence } from '../../hooks/usePresence';
import type { AgenticToolOption } from '../../types';
import { isDarkTheme } from '../../utils/theme';
import { AutocompleteTextarea } from '../AutocompleteTextarea/AutocompleteTextarea';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';
import SessionCard from '../SessionCard';
import WorktreeCard from '../WorktreeCard';
import { CommentNode, ZoneNode } from './canvas/BoardObjectNodes';
import { CursorNode } from './canvas/CursorNode';
import { MarkdownNode } from './canvas/MarkdownNode';
import { useBoardObjects } from './canvas/useBoardObjects';
import { findIntersectingObjects, findZoneAtPosition } from './canvas/utils/collisionDetection';
import { getWorktreeParentInfo, getZoneParentInfo } from './canvas/utils/commentUtils';
import {
  absoluteToRelative,
  calculateStoragePosition,
  getNodeAbsolutePosition,
  type ParentInfo,
  relativeToAbsolute,
} from './canvas/utils/coordinateTransforms';
import { ZoneTriggerModal } from './canvas/ZoneTriggerModal';

const { Paragraph } = Typography;

interface SessionCanvasProps {
  board: Board | null;
  client: AgorClient | null;
  sessionById: Map<string, Session>; // O(1) ID lookups
  sessionsByWorktree: Map<string, Session[]>; // O(1) worktree filtering
  userById: Map<string, User>; // Map-based user storage
  repoById: Map<string, Repo>; // Map-based repo storage
  worktrees: Worktree[];
  worktreeById: Map<string, Worktree>;
  boardObjectById: Map<string, BoardEntityObject>; // Map-based board object storage
  commentById: Map<string, BoardComment>; // Map-based comment storage
  currentUserId?: string;
  selectedSessionId?: string | null;
  availableAgents?: AgenticToolOption[];
  mcpServerById?: Map<string, MCPServer>; // Map-based MCP server storage
  sessionMcpServerIds?: Map<string, string[]>; // Map sessionId -> mcpServerIds[]
  onSessionClick?: (sessionId: string) => void;
  onTaskClick?: (taskId: string) => void;
  onSessionUpdate?: (sessionId: string, updates: Partial<Session>) => void;
  onSessionDelete?: (sessionId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
  onOpenSettings?: (sessionId: string) => void;
  onCreateSessionForWorktree?: (worktreeId: string) => void;
  onOpenWorktree?: (worktreeId: string) => void;
  onArchiveOrDeleteWorktree?: (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onOpenTerminal?: (commands: string[], worktreeId?: string) => void;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onViewLogs?: (worktreeId: string) => void;
  onNukeEnvironment?: (worktreeId: string) => void;
  onOpenCommentsPanel?: () => void;
  onCommentHover?: (commentId: string | null) => void;
  onCommentSelect?: (commentId: string | null) => void;
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
}

// Custom node component that renders SessionCard
const SessionNode = ({ data }: { data: SessionNodeData }) => {
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
};

interface WorktreeNodeData {
  worktree: Worktree;
  repo: Repo;
  sessions: Session[];
  userById: Map<string, User>;
  currentUserId?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (worktreeId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onArchiveOrDelete?: (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onOpenSettings?: (worktreeId: string) => void;
  onOpenTerminal?: (commands: string[], worktreeId?: string) => void;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onViewLogs?: (worktreeId: string) => void;
  onUnpin?: (worktreeId: string) => void;
  compact?: boolean;
  isPinned?: boolean;
  parentZoneId?: string;
  zoneName?: string;
  zoneColor?: string;
  selectedSessionId?: string | null;
  client: AgorClient | null;
}

// Custom node component that renders WorktreeCard
const WorktreeNode = ({ data }: { data: WorktreeNodeData }) => {
  return (
    <div className="worktree-node">
      <WorktreeCard
        worktree={data.worktree}
        repo={data.repo}
        sessions={data.sessions}
        userById={data.userById}
        currentUserId={data.currentUserId}
        selectedSessionId={data.selectedSessionId}
        onTaskClick={data.onTaskClick}
        onSessionClick={data.onSessionClick}
        onCreateSession={data.onCreateSession}
        onForkSession={data.onForkSession}
        onSpawnSession={data.onSpawnSession}
        onArchiveOrDelete={data.onArchiveOrDelete}
        onOpenSettings={data.onOpenSettings}
        onOpenTerminal={data.onOpenTerminal}
        onStartEnvironment={data.onStartEnvironment}
        onStopEnvironment={data.onStopEnvironment}
        onViewLogs={data.onViewLogs}
        onUnpin={data.onUnpin}
        isPinned={data.isPinned}
        zoneName={data.zoneName}
        client={data.client}
        zoneColor={data.zoneColor}
        defaultExpanded={!data.compact}
      />
    </div>
  );
};

// Define nodeTypes outside component to avoid recreation on every render
const nodeTypes = {
  sessionNode: SessionNode,
  worktreeNode: WorktreeNode,
  zone: ZoneNode,
  cursor: CursorNode,
  comment: CommentNode,
  markdown: MarkdownNode,
};

const SessionCanvas = forwardRef<SessionCanvasRef, SessionCanvasProps>(
  (
    {
      board,
      client,
      sessionById,
      sessionsByWorktree,
      repoById,
      worktrees,
      worktreeById,
      boardObjectById,
      commentById,
      userById,
      currentUserId,
      selectedSessionId,
      availableAgents = [],
      mcpServerById = new Map(),
      sessionMcpServerIds = new Map(),
      onSessionClick,
      onTaskClick,
      onSessionUpdate,
      onSessionDelete,
      onForkSession,
      onSpawnSession,
      onUpdateSessionMcpServers,
      onOpenSettings,
      onCreateSessionForWorktree,
      onOpenWorktree,
      onArchiveOrDeleteWorktree,
      onOpenTerminal,
      onStartEnvironment,
      onStopEnvironment,
      onViewLogs,
      onNukeEnvironment,
      onOpenCommentsPanel,
      onCommentHover,
      onCommentSelect,
    }: SessionCanvasProps,
    ref
  ) => {
    const { token } = theme.useToken();
    const isDarkMode = isDarkTheme(token);
    const defaultBackground = DEFAULT_BACKGROUNDS[isDarkMode ? 'dark' : 'light'];
    const canvasBackground = board?.background_color ?? defaultBackground;

    // Note: sessionsByWorktree is now passed as prop (no longer computed locally)
    // This enables efficient O(1) lookups and stable references across re-renders

    // Stabilize board objects for this board using a JSON key for deep equality
    // This prevents recomputation when board objects on OTHER boards change
    // biome-ignore lint/correctness/useExhaustiveDependencies: Using board_id instead of board for targeted memoization
    const boardObjectsKey = useMemo(() => {
      if (!board) return '[]';
      const boardObjectsArray: BoardEntityObject[] = [];
      for (const boardObject of boardObjectById.values()) {
        if (boardObject.board_id === board.board_id) {
          boardObjectsArray.push(boardObject);
        }
      }
      // Sort by object_id for stable JSON key
      boardObjectsArray.sort((a, b) => a.object_id.localeCompare(b.object_id));
      // Include full object data (position, zone_id) so changes trigger re-renders
      return JSON.stringify(boardObjectsArray);
    }, [board?.board_id, boardObjectById]);

    // Index by worktree_id for O(1) lookups
    // biome-ignore lint/correctness/useExhaustiveDependencies: Using JSON key for deep equality of board objects
    const boardObjectByWorktree = useMemo(() => {
      if (!board) return new Map<string, BoardEntityObject>();
      const map = new Map<string, BoardEntityObject>();
      for (const boardObject of boardObjectById.values()) {
        if (boardObject.board_id === board.board_id) {
          map.set(boardObject.worktree_id, boardObject);
        }
      }
      return map;
    }, [board?.board_id, boardObjectsKey]);

    // Note: worktreeById is now passed as prop from parent (no longer computed locally)
    // This enables efficient O(1) lookups and stable references across re-renders

    // Tool state for canvas annotations
    const [activeTool, setActiveTool] = useState<
      'select' | 'zone' | 'comment' | 'eraser' | 'markdown'
    >('select');

    // Zone drawing state (drag-to-draw)
    const [drawingZone, setDrawingZone] = useState<{
      start: { x: number; y: number };
      end: { x: number; y: number };
    } | null>(null);

    // Comment placement state (click-to-place)
    const [commentPlacement, setCommentPlacement] = useState<{
      position: { x: number; y: number }; // React Flow coordinates
      screenPosition: { x: number; y: number }; // Screen coordinates for popover
    } | null>(null);
    const [commentInput, setCommentInput] = useState('');

    // Markdown note placement state (click-to-place)
    const [markdownModal, setMarkdownModal] = useState<{
      position: { x: number; y: number }; // React Flow coordinates
      objectId?: string; // For editing existing note
    } | null>(null);
    const [markdownContent, setMarkdownContent] = useState('');
    const [markdownWidth, setMarkdownWidth] = useState(500); // Default width

    // Trigger confirmation modal state
    const [triggerModal, setTriggerModal] = useState<{
      sessionId: string;
      zoneName: string;
      trigger: ZoneTrigger;
      pinData: { x: number; y: number; parentId: string };
    } | null>(null);

    // Worktree zone trigger modal state
    const [worktreeTriggerModal, setWorktreeTriggerModal] = useState<{
      worktreeId: WorktreeID;
      zoneName: string;
      zoneId: string;
      trigger: ZoneTrigger;
    } | null>(null);

    // Debounce timer ref for position updates
    const layoutUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);
    const pendingLayoutUpdatesRef = useRef<Record<string, { x: number; y: number }>>({});
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
    // Track objects we've deleted locally (to prevent them from reappearing during WebSocket updates)
    const deletedObjectsRef = useRef<Set<string>>(new Set());

    // Initialize nodes and edges state BEFORE using them
    const [nodes, setNodes, onNodesChangeInternal] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);

    // Track resize state
    const resizeTimerRef = useRef<NodeJS.Timeout | null>(null);
    const pendingResizeUpdatesRef = useRef<Record<string, { width: number; height: number }>>({});

    // Handler to open edit modal for existing markdown note
    const handleEditMarkdownNote = useCallback(
      (objectId: string, content: string, width: number) => {
        const node = reactFlowInstanceRef.current?.getNode(objectId);
        if (!node) return;

        setMarkdownContent(content);
        setMarkdownWidth(width);
        setMarkdownModal({
          position: node.position,
          objectId,
        });
        setActiveTool('markdown');
      },
      []
    );

    // Board objects hook
    const { getBoardObjectNodes, batchUpdateObjectPositions, deleteObject } = useBoardObjects({
      board,
      client,
      sessionsByWorktree,
      worktrees,
      boardObjectById,
      setNodes,
      deletedObjectsRef,
      eraserMode: activeTool === 'eraser',
      selectedSessionId,
      onEditMarkdown: handleEditMarkdownNote,
    });

    // Extract zone labels - memoized to only change when labels actually change
    const zoneLabels = useMemo(() => {
      console.log('🔄 [SessionCanvas] Recalculating zoneLabels', {
        hasBoard: !!board,
        objectsCount: Object.keys(board?.objects || {}).length,
      });
      if (!board?.objects) return {};
      const labels: Record<string, string> = {};
      Object.entries(board.objects).forEach(([id, obj]) => {
        if (obj.type === 'zone') {
          labels[id] = obj.label;
        }
      });
      console.log('✅ [SessionCanvas] zoneLabels calculated:', labels);
      return labels;
    }, [board]);

    // Handler to unpin a worktree from its zone
    const handleUnpinWorktree = useCallback(
      async (worktreeId: string) => {
        if (!board || !client) return;

        // Find the board_object for this worktree
        const boardObject = boardObjectByWorktree.get(worktreeId);

        if (!boardObject || !boardObject.zone_id) {
          console.warn('Worktree not pinned or board object not found');
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
        // Worktree's position is relative to zone when pinned, so add zone's position
        const absoluteX = boardObject.position.x + zone.x;
        const absoluteY = boardObject.position.y + zone.y;

        // Optimistically store absolute position in localPositionsRef
        // This will be used by the node sync effect until WebSocket confirms
        localPositionsRef.current[worktreeId] = {
          x: absoluteX,
          y: absoluteY,
        };

        // Trigger immediate React Flow update
        setNodes((currentNodes) =>
          currentNodes.map((node) => {
            if (node.id === worktreeId) {
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
        await client.service('board-objects').patch(boardObject.object_id, {
          position: { x: absoluteX, y: absoluteY },
          zone_id: null, // null serializes correctly, undefined gets stripped
        });
      },
      [board, client, boardObjectByWorktree, setNodes]
    );

    // Convert worktrees to React Flow nodes (worktree-centric approach)
    const initialNodes: Node[] = useMemo(() => {
      // Auto-layout for worktrees without explicit positioning
      const VERTICAL_SPACING = 500;
      const _HORIZONTAL_SPACING = 600;

      // Create nodes for worktrees on this board
      const nodes: Node[] = [];

      worktrees.forEach((worktree, index) => {
        // Find board object for this worktree (if positioned on this board)
        const boardObject = boardObjectByWorktree.get(worktree.worktree_id);

        // Use stored position from boardObject if available, otherwise auto-layout
        const position = boardObject
          ? { x: boardObject.position.x, y: boardObject.position.y }
          : { x: 100, y: 100 + index * VERTICAL_SPACING };

        // Check if worktree is pinned to a zone (via board_object.zone_id)
        // Note: zone_id in database already has 'zone-' prefix (e.g., 'zone-1234')
        const zoneId = boardObject?.zone_id; // Zone ID with 'zone-' prefix (for React Flow parentId)

        // Look up zone name using full zone ID (zoneLabels uses full IDs as keys)
        const zoneName = zoneId ? zoneLabels[zoneId] || 'Unknown Zone' : undefined;
        const zoneObj = zoneId && board?.objects?.[zoneId] ? board.objects[zoneId] : undefined;
        const zoneColor =
          zoneObj && zoneObj.type === 'zone'
            ? zoneObj.borderColor || zoneObj.color // Backwards compat: borderColor first, then fall back to deprecated color
            : undefined;

        // Get sessions for this worktree
        const worktreeSessions = sessionsByWorktree.get(worktree.worktree_id) || [];

        // Get repo for this worktree
        const repo = repoById.get(worktree.repo_id);
        if (!repo) {
          console.error(`Repo not found for worktree ${worktree.worktree_id}`);
          return;
        }

        nodes.push({
          id: worktree.worktree_id,
          type: 'worktreeNode',
          position, // When pinned (parentId set), this is relative to zone; otherwise absolute
          draggable: true,
          zIndex: 500, // Above zones, below comments
          // Set dimensions for collision detection (matches WorktreeCard size)
          width: 500,
          height: 200, // Approximate height, will be measured by React Flow
          // Set parentId for visual nesting but allow dragging outside zone
          parentId: zoneId,
          extent: undefined, // No movement restriction - can drag anywhere
          data: {
            worktree,
            repo,
            sessions: worktreeSessions,
            userById,
            currentUserId,
            selectedSessionId,
            onTaskClick,
            onSessionClick,
            onCreateSession: onCreateSessionForWorktree,
            onForkSession,
            onSpawnSession,
            onArchiveOrDelete: onArchiveOrDeleteWorktree,
            onOpenSettings: onOpenWorktree,
            onOpenTerminal,
            onStartEnvironment,
            onStopEnvironment,
            onViewLogs,
            onNukeEnvironment,
            onUnpin: handleUnpinWorktree,
            compact: false,
            isPinned: !!zoneId,
            zoneName,
            zoneColor,
            client,
          },
        });
      });

      return nodes;
    }, [
      board,
      worktrees,
      boardObjectByWorktree,
      repoById,
      sessionsByWorktree,
      currentUserId,
      selectedSessionId,
      onSessionClick,
      onTaskClick,
      onCreateSessionForWorktree,
      onForkSession,
      onSpawnSession,
      onArchiveOrDeleteWorktree,
      onOpenWorktree,
      onOpenTerminal,
      onStartEnvironment,
      onStopEnvironment,
      onViewLogs,
      onNukeEnvironment,
      handleUnpinWorktree,
      zoneLabels,
      userById,
      client,
    ]);

    // No edges needed for worktree-centric boards
    // (Session genealogy is visualized within WorktreeCard, not as canvas edges)
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

    // Cursor tracking hook
    useCursorTracking({
      client,
      boardId: board?.board_id as BoardID | null,
      reactFlowInstance: reactFlowInstanceRef.current,
      enabled: !!board && !!client,
    });

    // Presence tracking hook (get remote cursors)
    const { remoteCursors } = usePresence({
      client,
      boardId: board?.board_id as BoardID | null,
      users: mapToArray(userById),
      enabled: !!board && !!client,
    });

    // Create cursor nodes from remote cursors (for minimap visibility)
    // Large dimensions ensure good visibility in minimap (visual size controlled by inverse scaling)
    const cursorNodes: Node[] = useMemo(() => {
      const nodes: Node[] = [];

      for (const [userId, { x, y, user }] of remoteCursors.entries()) {
        nodes.push({
          id: `cursor-${userId}`,
          type: 'cursor',
          position: { x, y },
          draggable: false,
          selectable: false,
          focusable: false,
          zIndex: 2000, // Cursors always on top (live presence)
          data: { user },
          width: 150,
          height: 150,
          style: {
            pointerEvents: 'none',
            transition: 'transform 0.1s ease-out',
          },
        });
      }

      return nodes;
    }, [remoteCursors]);

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
          // Comment pinned to zone or worktree - use relative position
          const rel = comment.position.relative;
          position = { x: rel.offset_x, y: rel.offset_y };

          if (rel.parent_type === 'zone') {
            // Parent is a zone - validate zone exists
            // Note: rel.parent_id is stored without 'zone-' prefix, but board.objects keys have it
            const zoneKey = `zone-${rel.parent_id}`;
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
          } else if (rel.parent_type === 'worktree') {
            // Parent is a worktree - validate worktree exists
            const worktree = worktreeById.get(rel.parent_id);
            if (worktree) {
              const info = getWorktreeParentInfo(rel.parent_id, worktrees);
              parentId = info.parentId;
              parentLabel = info.parentLabel;
              parentColor = info.parentColor;
            } else {
              // Worktree was deleted - skip rendering this comment
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
          draggable: true,
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
      worktrees,
      userById,
      worktreeById,
      onOpenCommentsPanel,
      onCommentHover,
      onCommentSelect,
    ]);

    // Sync SESSION nodes only (don't trigger on zone changes)
    useEffect(() => {
      if (isDraggingRef.current) return;

      setNodes((currentNodes) => {
        // Separate existing nodes by type
        const existingZones = currentNodes.filter((n) => n.type === 'zone');
        const existingMarkdown = currentNodes.filter((n) => n.type === 'markdown');
        const existingCursors = currentNodes.filter((n) => n.type === 'cursor');
        const existingComments = currentNodes.filter((n) => n.type === 'comment');

        // Update worktree nodes with preserved state
        const updatedWorktrees = initialNodes.map((newNode) => {
          const existingNode = currentNodes.find((n) => n.id === newNode.id);
          const localPosition = localPositionsRef.current[newNode.id];

          // If we have a local position (user is dragging or just dragged), use it
          if (localPosition) {
            // Get the incoming position in ABSOLUTE coordinates for comparison
            // If node has parentId, position is relative to parent - must convert to absolute
            let incomingAbsolutePosition = newNode.position;
            if (newNode.parentId) {
              // Parent could be a zone or another worktree
              const parentNode = [...initialNodes, ...existingZones].find(
                (n) => n.id === newNode.parentId
              );
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
              return { ...newNode, selected: existingNode?.selected };
            }

            // Still waiting for confirmation or another client moved it
            // If node now has parentId, convert local absolute position to relative
            let positionToUse = localPosition;
            if (newNode.parentId) {
              // Parent could be a zone or another worktree
              const parentNode = [...initialNodes, ...existingZones].find(
                (n) => n.id === newNode.parentId
              );
              if (parentNode) {
                positionToUse = absoluteToRelative(localPosition, parentNode.position);
              }
            }

            return { ...newNode, position: positionToUse, selected: existingNode?.selected };
          }

          // No local override, use incoming position
          return { ...newNode, selected: existingNode?.selected };
        });

        // Merge: zones (back) + worktrees (middle) + markdown + cursors/comments (front)
        return [
          ...existingZones,
          ...updatedWorktrees,
          ...existingMarkdown,
          ...existingCursors,
          ...existingComments,
        ];
      });
    }, [initialNodes, setNodes]);

    // Helper: Partition nodes by type
    const partitionNodesByType = useCallback((nodes: Node[]) => {
      return {
        zones: nodes.filter((n) => n.type === 'zone'),
        markdown: nodes.filter((n) => n.type === 'markdown'),
        worktrees: nodes.filter((n) => n.type === 'worktreeNode'),
        comments: nodes.filter((n) => n.type === 'comment'),
        cursors: nodes.filter((n) => n.type === 'cursor'),
      };
    }, []);

    // Helper: Apply consistent z-ordering to nodes
    // Z-order: zones < worktrees < markdown < comments < cursors (cursors always on top)
    const applyZOrder = useCallback(
      (zones: Node[], markdown: Node[], worktrees: Node[], comments: Node[], cursors: Node[]) => {
        return [...zones, ...worktrees, ...markdown, ...comments, ...cursors];
      },
      []
    );

    // Sync ZONE and MARKDOWN nodes separately
    useEffect(() => {
      if (isDraggingRef.current) return;

      const boardObjectNodes = getBoardObjectNodes();

      setNodes((currentNodes) => {
        const { worktrees, comments, cursors } = partitionNodesByType(currentNodes);

        // Separate zones and markdown from boardObjectNodes
        const zones = boardObjectNodes
          .filter((n) => n.type === 'zone' && !deletedObjectsRef.current.has(n.id))
          .map((newZone) => {
            const existingZone = currentNodes.find((n) => n.id === newZone.id);
            return { ...newZone, selected: existingZone?.selected };
          });

        const markdown = boardObjectNodes
          .filter((n) => n.type === 'markdown' && !deletedObjectsRef.current.has(n.id))
          .map((newMarkdown) => {
            const existingMarkdown = currentNodes.find((n) => n.id === newMarkdown.id);
            return { ...newMarkdown, selected: existingMarkdown?.selected };
          });

        return applyZOrder(zones, markdown, worktrees, comments, cursors);
      });
    }, [getBoardObjectNodes, setNodes, applyZOrder, partitionNodesByType]);

    // Sync CURSOR nodes separately
    useEffect(() => {
      if (isDraggingRef.current) return;

      setNodes((currentNodes) => {
        const { zones, markdown, worktrees, comments } = partitionNodesByType(currentNodes);
        return applyZOrder(zones, markdown, worktrees, comments, cursorNodes);
      });
    }, [cursorNodes, setNodes, applyZOrder, partitionNodesByType]);

    // Sync COMMENT nodes separately
    useEffect(() => {
      if (isDraggingRef.current) return;

      setNodes((currentNodes) => {
        const { zones, markdown, worktrees, cursors } = partitionNodesByType(currentNodes);

        // Apply local position overrides to comment nodes (to prevent flicker during drag)
        const commentsWithLocalPositions = commentNodes.map((newNode) => {
          const localPosition = localPositionsRef.current[newNode.id];

          if (localPosition) {
            // Get the incoming position in ABSOLUTE coordinates for comparison
            // If node has parentId, position is relative to parent - must convert to absolute
            let incomingAbsolutePosition = newNode.position;
            if (newNode.parentId) {
              const parentNode = [...worktrees, ...zones].find((n) => n.id === newNode.parentId);
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
              const parentNode = [...worktrees, ...zones].find((n) => n.id === newNode.parentId);
              if (parentNode) {
                positionToUse = absoluteToRelative(localPosition, parentNode.position);
              }
            }

            return { ...newNode, position: positionToUse };
          }

          return newNode;
        });

        return applyZOrder(zones, markdown, worktrees, commentsWithLocalPositions, cursors);
      });
    }, [commentNodes, setNodes, applyZOrder, partitionNodesByType]);

    // Sync edges
    useEffect(() => {
      setEdges(initialEdges);
    }, [initialEdges, setEdges]); // REMOVED setEdges from dependencies

    // Fit view ONCE when entering a board (not on every node change)
    // This ensures nodes are visible when navigating between boards or on initial load,
    // but doesn't disrupt the user's zoom level when comments/cursors/zones change
    // biome-ignore lint/correctness/useExhaustiveDependencies: nodes.length is used to gate execution (wait for nodes to load), not to trigger re-runs
    useEffect(() => {
      // Wait for ReactFlow to be ready and nodes to be loaded
      if (!isReactFlowReady || !reactFlowInstanceRef.current || nodes.length === 0) return;

      // Only fit view once per board - skip if we already fit for this board
      if (board?.board_id === lastFitBoardIdRef.current) return;

      // Use a small delay to ensure DOM has updated
      const timer = setTimeout(() => {
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
    }, [isReactFlowReady, nodes.length, board?.board_id]); // isReactFlowReady + board_id triggers check, nodes.length gates execution

    // Intercept onNodesChange to detect resize events
    const onNodesChange = useCallback(
      // biome-ignore lint/suspicious/noExplicitAny: React Flow change event types are not exported
      (changes: any) => {
        // Detect resize by checking for dimensions changes
        // biome-ignore lint/suspicious/noExplicitAny: React Flow change event types are not exported
        changes.forEach((change: any) => {
          if (change.type === 'dimensions' && change.dimensions) {
            const node = nodes.find((n) => n.id === change.id);
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

              // Accumulate resize updates
              pendingResizeUpdatesRef.current[change.id] = {
                width: newWidth,
                height: newHeight,
              };

              // Clear existing timer
              if (resizeTimerRef.current) {
                clearTimeout(resizeTimerRef.current);
              }

              // Debounce: wait 500ms after last resize before persisting
              resizeTimerRef.current = setTimeout(async () => {
                const updates = pendingResizeUpdatesRef.current;
                pendingResizeUpdatesRef.current = {};

                if (!board || !client) return;

                // Persist all resize changes
                for (const [nodeId, dimensions] of Object.entries(updates)) {
                  const objectData = board.objects?.[nodeId];
                  if (objectData && objectData.type === 'zone') {
                    const updatedObject = {
                      ...objectData,
                      width: dimensions.width,
                      height: dimensions.height,
                    };

                    try {
                      await client.service('boards').patch(board.board_id, {
                        _action: 'upsertObject',
                        objectId: nodeId,
                        objectData: updatedObject,
                        // biome-ignore lint/suspicious/noExplicitAny: Board patch with custom _action field
                      } as any);
                    } catch (error) {
                      console.error('Failed to persist zone resize:', error);
                    }
                  }
                }
              }, 500);
            }
          }
        });

        // Call the original handler
        onNodesChangeInternal(changes);
      },
      [nodes, board, client, onNodesChangeInternal]
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

        // Reset dragging flag immediately to allow node sync effects to run
        isDraggingRef.current = false;

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
        };

        // Clear existing timer
        if (layoutUpdateTimerRef.current) {
          clearTimeout(layoutUpdateTimerRef.current);
        }

        // Debounce: wait 500ms after last drag before persisting
        layoutUpdateTimerRef.current = setTimeout(async () => {
          const updates = pendingLayoutUpdatesRef.current;
          pendingLayoutUpdatesRef.current = {};

          try {
            // Separate updates for worktrees vs zones vs markdown vs comments
            const worktreeUpdates: Array<{
              worktree_id: string;
              position: { x: number; y: number };
              zone_id?: string;
            }> = [];
            const zoneUpdates: Record<string, { x: number; y: number }> = {};
            const markdownUpdates: Record<string, { x: number; y: number }> = {};
            const commentUpdates: Array<{
              comment_id: string;
              position: { x: number; y: number };
              parentId?: string;
              parentType?: 'zone' | 'worktree';
              newReactFlowParentId?: string;
            }> = [];

            // Find all current nodes to check types
            const currentNodes = nodes;

            for (const [nodeId, position] of Object.entries(updates)) {
              const draggedNode = currentNodes.find((n) => n.id === nodeId);

              if (draggedNode?.type === 'zone') {
                // Zone moved - update position via batchUpdateObjectPositions
                zoneUpdates[nodeId] = position;
              } else if (draggedNode?.type === 'markdown') {
                // Markdown note moved - update position via batchUpdateObjectPositions
                markdownUpdates[nodeId] = position;
              } else if (draggedNode?.type === 'comment') {
                // Comment pin moved - extract comment_id from node id
                const commentId = nodeId.replace('comment-', '');

                // Use the absolute position we stored at drag time
                // Don't recalculate from draggedNode because WebSocket might have already
                // updated it with a parentId, making draggedNode.position relative
                const absolutePosition = position;

                // Find zones/worktrees that the comment intersects with at this absolute position
                const { worktreeNode, zoneNode } = findIntersectingObjects(
                  absolutePosition,
                  currentNodes
                );

                let parentId: string | undefined;
                let parentType: 'zone' | 'worktree' | undefined;
                let newReactFlowParentId: string | undefined;

                if (worktreeNode) {
                  parentId = worktreeNode.id; // Worktree ID has no prefix
                  parentType = 'worktree';
                  newReactFlowParentId = worktreeNode.id; // React Flow uses same ID
                } else if (zoneNode) {
                  parentId = zoneNode.id.replace('zone-', ''); // Database uses ID without prefix
                  parentType = 'zone';
                  newReactFlowParentId = zoneNode.id; // React Flow uses 'zone-{id}'
                }

                commentUpdates.push({
                  comment_id: commentId,
                  position: absolutePosition, // Always use absolute position for DB storage calculation
                  parentId,
                  parentType,
                  newReactFlowParentId, // Track new parentId for immediate React Flow update
                });
              } else if (draggedNode?.type === 'worktreeNode') {
                // Use the absolute position we stored at drag time
                // Don't recalculate from draggedNode because WebSocket might have already
                // updated it with a parentId, making draggedNode.position relative
                const absolutePosition = position;

                // Check if worktree was dropped on a zone
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

                // Check if worktree was already pinned to a zone before this drag
                // Use direct Map lookup instead of array conversion for better performance
                const existingBoardObject = boardObjectByWorktree.get(nodeId);
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

                // Worktree moved - update board_object position (and zone_id if dropped on zone)
                worktreeUpdates.push({
                  worktree_id: nodeId,
                  position: positionToStore,
                  zone_id: droppedZoneId,
                });

                if (zoneCollision) {
                  const { zoneId, zoneData } = zoneCollision;

                  // Only trigger if zone assignment changed (moved to different zone or first-time pinning)
                  const zoneChanged = oldZoneId !== zoneId;

                  // Handle trigger if zone has one AND zone assignment changed
                  const trigger = zoneData.trigger;
                  if (trigger && zoneChanged) {
                    if (trigger.behavior === 'always_new') {
                      // Always_new: Auto-create new root session and apply trigger

                      // Execute async trigger (don't await to avoid blocking drag handler)
                      (async () => {
                        try {
                          // Find the worktree
                          const worktree = worktrees.find((wt) => wt.worktree_id === nodeId);

                          // Render template
                          const context = {
                            worktree: worktree
                              ? {
                                  name: worktree.name || '',
                                  ref: worktree.ref || '',
                                  issue_url: worktree.issue_url || '',
                                  pull_request_url: worktree.pull_request_url || '',
                                  notes: worktree.notes || '',
                                  path: worktree.path || '',
                                  context: worktree.custom_context || {},
                                }
                              : {},
                            board: {
                              name: board?.name || '',
                              description: board?.description || '',
                              context: board?.custom_context || {},
                            },
                            session: {
                              description: '',
                              context: {},
                            },
                          };
                          const template = Handlebars.compile(trigger.template);
                          const renderedPrompt = template(context);

                          // Create new root session
                          const newSession = await client.service('sessions').create({
                            worktree_id: nodeId as WorktreeID,
                            description: `Session from zone "${zoneData.label}"`,
                            status: 'idle',
                            agentic_tool: 'claude-code',
                          });

                          // Send prompt to new session
                          await client.service(`sessions/${newSession.session_id}/prompt`).create({
                            prompt: renderedPrompt,
                          });
                        } catch (error) {
                          console.error('❌ Failed to execute always_new trigger:', error);
                        }
                      })();
                    } else {
                      // Default: show_picker - open modal for session selection
                      setWorktreeTriggerModal({
                        worktreeId: nodeId as WorktreeID,
                        zoneName: zoneData.label,
                        zoneId,
                        trigger,
                      });
                    }
                  }
                }
              }
            }

            // Update worktree positions in board_objects
            if (worktreeUpdates.length > 0) {
              for (const { worktree_id, position, zone_id } of worktreeUpdates) {
                // Find existing board_object or create new one
                // Use direct Map lookup instead of array conversion for better performance
                const existingBoardObject = boardObjectByWorktree.get(worktree_id);

                if (existingBoardObject) {
                  // Update existing board_object (position and zone_id)
                  const updateData: { position: { x: number; y: number }; zone_id?: string } = {
                    position,
                  };
                  // Only update zone_id if it's defined (dropped on zone) or explicitly undefined (moved off zone)
                  if (zone_id !== undefined) {
                    updateData.zone_id = zone_id;
                  }
                  await client
                    .service('board-objects')
                    .patch(existingBoardObject.object_id, updateData);
                } else {
                  // Create new board_object (with zone_id if dropped on zone)
                  await client.service('board-objects').create({
                    board_id: board.board_id,
                    worktree_id,
                    position,
                    // zone_id will be included if worktree was dropped on zone
                    ...(zone_id ? { zone_id } : {}),
                  });
                }
              }
            }

            // Update zone positions
            if (Object.keys(zoneUpdates).length > 0) {
              await batchUpdateObjectPositions(zoneUpdates);
            }

            // Update markdown positions
            if (Object.keys(markdownUpdates).length > 0) {
              await batchUpdateObjectPositions(markdownUpdates);
            }

            // Update comment positions
            for (const {
              comment_id,
              position,
              parentId,
              parentType,
              newReactFlowParentId,
            } of commentUpdates) {
              const commentData: Partial<BoardComment> = {};

              if (parentId && parentType === 'zone') {
                // Comment pinned to zone
                const zoneNode = currentNodes.find((n) => n.id === `zone-${parentId}`);
                if (zoneNode) {
                  const zoneAbsPos = getNodeAbsolutePosition(zoneNode, currentNodes);
                  const relativePos = calculateStoragePosition(position, {
                    id: parentId,
                    position: zoneAbsPos,
                  });
                  commentData.position = {
                    relative: {
                      parent_id: parentId,
                      parent_type: 'zone',
                      offset_x: relativePos.x,
                      offset_y: relativePos.y,
                    },
                  };
                } else {
                  console.warn(
                    `⚠️ Zone ${parentId} not found for comment ${comment_id}, using absolute position`
                  );
                  commentData.position = { absolute: position };
                  // biome-ignore lint/suspicious/noExplicitAny: need null to clear DB field, not undefined
                  commentData.worktree_id = null as any;
                }
              } else if (parentId && parentType === 'worktree') {
                // Comment pinned to worktree
                const worktreeNode = currentNodes.find((n) => n.id === parentId);
                if (worktreeNode) {
                  const worktreeAbsPos = getNodeAbsolutePosition(worktreeNode, currentNodes);
                  const relativePos = calculateStoragePosition(position, {
                    id: parentId,
                    position: worktreeAbsPos,
                  });
                  commentData.worktree_id = parentId as WorktreeID;
                  commentData.position = {
                    relative: {
                      parent_id: parentId,
                      parent_type: 'worktree',
                      offset_x: relativePos.x,
                      offset_y: relativePos.y,
                    },
                  };
                } else {
                  console.warn(
                    `⚠️ Worktree ${parentId} not found for comment ${comment_id}, using absolute position`
                  );
                  commentData.position = { absolute: position };
                  // biome-ignore lint/suspicious/noExplicitAny: need null to clear DB field, not undefined
                  commentData.worktree_id = null as any;
                }
              } else {
                // Free-floating comment - use absolute positioning
                commentData.position = { absolute: position };
                // IMPORTANT: Use null to explicitly clear worktree association
                // (undefined would be omitted from the patch, leaving old value)
                // biome-ignore lint/suspicious/noExplicitAny: need null to clear DB field, not undefined
                commentData.worktree_id = null as any;
              }

              await client.service('board-comments').patch(comment_id, commentData);

              // Clear localPositionsRef immediately after patching
              // We've saved the correct position to DB, no need to keep overriding
              delete localPositionsRef.current[`comment-${comment_id}`];

              // Immediately update React Flow node to reflect new parentId
              // This prevents visual glitches while waiting for WebSocket sync
              setNodes((prevNodes) =>
                prevNodes.map((n) => {
                  if (n.id === `comment-${comment_id}`) {
                    // Update parentId to match new parent (or undefined if free-floating)
                    const updates: Partial<Node> = { parentId: newReactFlowParentId };

                    // If parent changed, also update position
                    if (newReactFlowParentId !== n.parentId) {
                      if (newReactFlowParentId) {
                        // Now has parent - convert to relative position
                        const parent = prevNodes.find((p) => p.id === newReactFlowParentId);
                        if (parent) {
                          const parentAbsPos = getNodeAbsolutePosition(parent, prevNodes);
                          const relativePos = calculateStoragePosition(position, {
                            id: newReactFlowParentId,
                            position: parentAbsPos,
                          });

                          updates.position = relativePos;
                        }
                      } else {
                        // No parent - use absolute position
                        updates.position = position;
                      }
                    }

                    return { ...n, ...updates };
                  }
                  return n;
                })
              );
            }
          } catch (error) {
            console.error('Failed to persist layout:', error);
          }
        }, 500);
      },
      [board, client, batchUpdateObjectPositions, nodes, boardObjectByWorktree, worktrees, setNodes]
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
          });
        }
      },
      [activeTool]
    );

    const handlePointerMove = useCallback(
      (event: React.PointerEvent) => {
        if (activeTool === 'zone' && drawingZone && event.buttons === 1) {
          setDrawingZone({
            start: drawingZone.start,
            end: { x: event.clientX, y: event.clientY },
          });
        }
      },
      [activeTool, drawingZone]
    );

    const handlePointerUp = useCallback(() => {
      if (activeTool === 'zone' && drawingZone && reactFlowInstanceRef.current) {
        const { start, end } = drawingZone;

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
          const defaultBorderColor = '#d9d9d9';
          const defaultBackgroundColor = '#d9d9d91a'; // 10% opacity

          // Optimistic update
          setNodes((nodes) => [
            ...nodes,
            {
              id: objectId,
              type: 'zone',
              position,
              draggable: true,
              zIndex: 100, // Zones behind worktrees and comments
              style: { width, height },
              data: {
                objectId,
                label: 'New Zone',
                width,
                height,
                borderColor: defaultBorderColor,
                backgroundColor: defaultBackgroundColor,
                onUpdate: (id: string, data: BoardObject) => {
                  if (board && client) {
                    client
                      .service('boards')
                      .patch(board.board_id, {
                        _action: 'upsertObject',
                        objectId: id,
                        objectData: data,
                        // biome-ignore lint/suspicious/noExplicitAny: Board patch with custom _action field
                      } as any)
                      .catch(console.error);
                  }
                },
              },
            },
          ]);

          // Persist to backend
          if (board && client) {
            client
              .service('boards')
              .patch(board.board_id, {
                _action: 'upsertObject',
                objectId,
                objectData: {
                  type: 'zone',
                  x: position.x,
                  y: position.y,
                  width,
                  height,
                  label: 'New Zone',
                  borderColor: defaultBorderColor,
                  backgroundColor: defaultBackgroundColor,
                },
                // biome-ignore lint/suspicious/noExplicitAny: Board patch with custom _action field
              } as any)
              .catch((error: unknown) => {
                console.error('Failed to add zone:', error);
                setNodes((nodes) => nodes.filter((n) => n.id !== objectId));
              });
          }
        }

        setDrawingZone(null);
        setActiveTool('select');
      }
    }, [activeTool, drawingZone, board, client, setNodes]);

    // Pane click handler for comment placement
    const handlePaneClick = useCallback(
      (event: React.MouseEvent) => {
        if (activeTool === 'comment' && reactFlowInstanceRef.current) {
          // Use screenToFlowPosition which automatically handles all offsets (including CommentsPanel)
          const position = reactFlowInstanceRef.current.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          });

          setCommentPlacement({
            position, // React Flow coordinates for storing in DB
            screenPosition: { x: event.clientX, y: event.clientY }, // Screen coords for popover
          });
        }

        // Markdown tool: click-to-place
        if (activeTool === 'markdown' && reactFlowInstanceRef.current) {
          const position = reactFlowInstanceRef.current.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          });

          setMarkdownModal({ position });
        }
      },
      [activeTool]
    );

    // Handler to create spatial comment
    const handleCreateSpatialComment = useCallback(async () => {
      if (!commentPlacement || !board || !client || !currentUserId || !commentInput.trim()) {
        return;
      }

      try {
        const position = commentPlacement.position;

        // Check what object the comment was placed on (zone or worktree)
        // Get all current nodes with their measured dimensions
        const currentNodes = reactFlowInstanceRef.current?.getNodes() || [];

        // Find zones/worktrees that the comment intersects with
        const { worktreeNode, zoneNode } = findIntersectingObjects(position, currentNodes);

        // Prepare comment data based on placement target
        const commentData: BoardCommentCreate = {
          board_id: board.board_id,
          created_by: currentUserId as UserID,
          content: commentInput.trim(),
          resolved: false,
          edited: false,
          reactions: [],
        };

        if (worktreeNode) {
          // Comment pinned to worktree - use FK + relative positioning
          const worktreeId = worktreeNode.id; // Worktree ID has no prefix
          commentData.worktree_id = worktreeId as WorktreeID;
          commentData.position = {
            relative: {
              parent_id: worktreeId,
              parent_type: 'worktree',
              offset_x: position.x - worktreeNode.position.x,
              offset_y: position.y - worktreeNode.position.y,
            },
          };
          console.log(`✓ Comment pinned to worktree ${worktreeId}`);
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
          console.log(`✓ Comment pinned to zone ${zoneId}`);
        } else {
          // Free-floating comment - use absolute positioning
          commentData.position = {
            absolute: position,
          };
          console.log('✓ Comment placed at absolute position');
        }

        await client.service('board-comments').create(commentData);

        // Reset state
        setCommentPlacement(null);
        setCommentInput('');
        setActiveTool('select');
      } catch (error) {
        console.error('Failed to create spatial comment:', error);
      }
    }, [commentPlacement, board, client, currentUserId, commentInput]);

    // Handler to create/update markdown note
    const handleCreateMarkdownNote = useCallback(async () => {
      if (!markdownModal || !board || !client || !markdownContent.trim()) {
        return;
      }

      const objectId = markdownModal.objectId || `markdown-${Date.now()}`;
      const position = markdownModal.position;

      // Optimistic update
      setNodes((nodes) => {
        // If editing, update existing node
        if (markdownModal.objectId) {
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

        // If creating new, add node
        return [
          ...nodes,
          {
            id: objectId,
            type: 'markdown',
            position,
            draggable: true,
            zIndex: 300, // Above zones (100), below worktrees (500)
            data: {
              objectId,
              content: markdownContent,
              width: markdownWidth,
              onUpdate: (id: string, data: BoardObject) => {
                if (board && client) {
                  client
                    .service('boards')
                    .patch(board.board_id, {
                      _action: 'upsertObject',
                      objectId: id,
                      objectData: data,
                      // biome-ignore lint/suspicious/noExplicitAny: Board patch with custom _action field
                    } as any)
                    .catch(console.error);
                }
              },
              onEdit: handleEditMarkdownNote,
            },
          },
        ];
      });

      // Persist to backend
      try {
        await client.service('boards').patch(board.board_id, {
          _action: 'upsertObject',
          objectId,
          objectData: {
            type: 'markdown',
            x: position.x,
            y: position.y,
            width: markdownWidth,
            content: markdownContent,
          },
          // biome-ignore lint/suspicious/noExplicitAny: Board patch with custom _action field
        } as any);

        console.log(
          `✓ ${markdownModal.objectId ? 'Updated' : 'Created'} markdown note ${objectId}`
        );
      } catch (error) {
        console.error('Failed to save markdown note:', error);
        // Rollback optimistic update
        if (!markdownModal.objectId) {
          setNodes((nodes) => nodes.filter((n) => n.id !== objectId));
        }
      }

      // Reset state
      setMarkdownModal(null);
      setMarkdownContent('');
      setMarkdownWidth(500);
      setActiveTool('select');
    }, [
      markdownModal,
      board,
      client,
      markdownContent,
      markdownWidth,
      setNodes,
      handleEditMarkdownNote,
    ]);

    // Node click handler for eraser mode and comment placement
    const handleNodeClick = useCallback(
      (event: React.MouseEvent, node: Node) => {
        if (activeTool === 'eraser') {
          // Only delete board objects (zones, markdown), not worktrees or cursors
          if (node.type === 'zone' || node.type === 'markdown') {
            deleteObject(node.id);
          }
          return;
        }

        if (activeTool === 'comment' && reactFlowInstanceRef.current) {
          // Allow comment placement on sessions and zones
          if (node.type === 'worktreeNode' || node.type === 'zone') {
            // Use screenToFlowPosition which automatically handles all offsets (including CommentsPanel)
            const position = reactFlowInstanceRef.current.screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            });

            setCommentPlacement({
              position, // React Flow coordinates for storing in DB
              screenPosition: { x: event.clientX, y: event.clientY }, // Screen coords for popover
            });
          }
          return;
        }

        // Worktree cards handle their own session clicks internally
        // (no canvas-level click handler needed for worktreeNode)
      },
      [activeTool, deleteObject]
    );

    // Clear comment placement state when switching away from comment tool
    useEffect(() => {
      if (activeTool !== 'comment' && commentPlacement) {
        setCommentPlacement(null);
        setCommentInput('');
      }
    }, [activeTool, commentPlacement]);

    return (
      <div
        style={{
          width: '100%',
          height: '100vh',
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
              border: '2px dashed #1677ff',
              background: 'rgba(22, 119, 255, 0.1)',
              pointerEvents: 'none',
              zIndex: 1000,
            }}
          />
        )}

        <div
          ref={reactFlowWrapperRef}
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
            nodeTypes={nodeTypes}
            snapToGrid={true}
            snapGrid={[20, 20]}
            minZoom={0.1}
            maxZoom={1.5}
            nodesDraggable={true}
            nodesConnectable={false}
            elementsSelectable={true}
            elevateNodesOnSelect={false}
            // Two-finger scrolling to pan when in select mode (Figma-style)
            // Also allow click-drag to pan since selection box isn't useful here
            // Disable all panning when actively drawing a zone to prevent interference
            panOnScroll={activeTool === 'select' && !drawingZone}
            panOnDrag={!drawingZone} // Always allow drag to pan (left mouse in select, any in other modes)
            selectionOnDrag={false} // Disable selection box - not useful for worktree cards
            className={`tool-mode-${activeTool}`}
            // Disable React Flow's default keyboard shortcuts to prevent conflicts
            // Note: React Flow keyboard shortcuts were causing Spatial Messages to appear
            // undesirably when clicking/typing. Disabling all keyboard shortcuts for now.
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            panActivationKeyCode={null}
            zoomActivationKeyCode={null}
            disableKeyboardA11y={true}
            style={{ background: 'transparent' }}
          >
            {!canvasBackground && <Background />}
            <Controls
              position="top-left"
              showZoom={false}
              showFitView={false}
              showInteractive={false}
            >
              {/* Zoom controls */}
              <Tooltip title="Zoom In" placement="right" mouseEnterDelay={0.3}>
                <ControlButton
                  onClick={(e) => {
                    e.stopPropagation();
                    reactFlowInstanceRef.current?.zoomIn();
                  }}
                >
                  <PlusOutlined style={{ fontSize: '16px' }} />
                </ControlButton>
              </Tooltip>
              <Tooltip title="Zoom Out" placement="right" mouseEnterDelay={0.3}>
                <ControlButton
                  onClick={(e) => {
                    e.stopPropagation();
                    reactFlowInstanceRef.current?.zoomOut();
                  }}
                >
                  <MinusOutlined style={{ fontSize: '16px' }} />
                </ControlButton>
              </Tooltip>
              <Tooltip title="Fit View" placement="right" mouseEnterDelay={0.3}>
                <ControlButton
                  onClick={(e) => {
                    e.stopPropagation();
                    reactFlowInstanceRef.current?.fitView();
                  }}
                >
                  <ZoomInOutlined style={{ fontSize: '16px' }} />
                </ControlButton>
              </Tooltip>
              {/* Custom toolbox buttons */}
              <Tooltip title="Select" placement="right" mouseEnterDelay={0.3}>
                <ControlButton
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveTool('select');
                  }}
                  style={{
                    borderLeft: activeTool === 'select' ? '3px solid #1677ff' : 'none',
                  }}
                >
                  <SelectOutlined style={{ fontSize: '16px' }} />
                </ControlButton>
              </Tooltip>
              <Tooltip title="Add Zone" placement="right" mouseEnterDelay={0.3}>
                <ControlButton
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveTool('zone');
                  }}
                  style={{
                    borderLeft: activeTool === 'zone' ? '3px solid #1677ff' : 'none',
                  }}
                >
                  <BorderOutlined style={{ fontSize: '16px' }} />
                </ControlButton>
              </Tooltip>
              <Tooltip title="Add Comment" placement="right" mouseEnterDelay={0.3}>
                <ControlButton
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveTool('comment');
                  }}
                  style={{
                    borderLeft: activeTool === 'comment' ? '3px solid #1677ff' : 'none',
                  }}
                >
                  <CommentOutlined style={{ fontSize: '16px' }} />
                </ControlButton>
              </Tooltip>
              <Tooltip title="Add Markdown Note" placement="right" mouseEnterDelay={0.3}>
                <ControlButton
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveTool('markdown');
                  }}
                  style={{
                    borderLeft: activeTool === 'markdown' ? '3px solid #1677ff' : 'none',
                  }}
                >
                  <FileMarkdownOutlined style={{ fontSize: '16px' }} />
                </ControlButton>
              </Tooltip>
              <Tooltip title="Eraser - Click to toggle" placement="right" mouseEnterDelay={0.3}>
                <ControlButton
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveTool(activeTool === 'eraser' ? 'select' : 'eraser');
                  }}
                  style={{
                    borderLeft: activeTool === 'eraser' ? `3px solid ${token.colorError}` : 'none',
                    color: activeTool === 'eraser' ? token.colorError : 'inherit',
                    backgroundColor:
                      activeTool === 'eraser' ? `${token.colorError}15` : 'transparent',
                  }}
                >
                  <DeleteOutlined style={{ fontSize: '16px' }} />
                </ControlButton>
              </Tooltip>
            </Controls>
            <MiniMap
              nodeColor={(node) => {
                // Handle cursor nodes (show as bright color)
                if (node.type === 'cursor') return token.colorWarning;

                // Handle comment nodes - 100% alpha for top hierarchy
                if (node.type === 'comment') return token.colorText;

                // Handle markdown notes - 70% alpha for middle layer
                if (node.type === 'markdown') return `${token.colorText}B3`;

                // Handle board objects (zones) - 40% alpha for middle-low layer
                if (node.type === 'zone') return `${token.colorText}66`;

                // Handle session/worktree nodes - primary border color for middle-high layer
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
              }}
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

        {/* Trigger confirmation modal */}
        {triggerModal &&
          (() => {
            // Pre-render the template for display in modal
            const session = sessionById.get(triggerModal.sessionId);
            let renderedPromptPreview = triggerModal.trigger.template;

            if (session) {
              try {
                // Lookup worktree data for this session
                const worktree = worktrees.find((wt) => wt.worktree_id === session.worktree_id);

                const context = {
                  session: {
                    description: session.description || '',
                    context: session.custom_context || {},
                  },
                  board: {
                    name: board?.name || '',
                    description: board?.description || '',
                    context: board?.custom_context || {},
                  },
                  worktree: worktree
                    ? {
                        name: worktree.name || '',
                        ref: worktree.ref || '',
                        issue_url: worktree.issue_url || '',
                        pull_request_url: worktree.pull_request_url || '',
                        notes: worktree.notes || '',
                        path: worktree.path || '',
                        context: worktree.custom_context || {},
                      }
                    : {
                        name: '',
                        ref: '',
                        issue_url: '',
                        pull_request_url: '',
                        notes: '',
                        path: '',
                        context: {},
                      },
                };
                const template = Handlebars.compile(triggerModal.trigger.template);
                renderedPromptPreview = template(context);
              } catch (error) {
                console.error('Template render error for preview:', error);
                // Fall back to raw text
              }
            }

            return (
              <Modal
                title={`Execute Trigger for "${triggerModal.zoneName}"?`}
                open={true}
                onOk={async () => {
                  if (!client) {
                    console.error('❌ Cannot execute trigger: client not available');
                    setTriggerModal(null);
                    return;
                  }

                  console.log('✅ Execute trigger:', triggerModal.trigger);

                  try {
                    const { sessionId, trigger } = triggerModal;

                    // Find the session to get its data for Handlebars context
                    const session = sessionById.get(sessionId);
                    if (!session) {
                      console.error('❌ Session not found:', sessionId);
                      setTriggerModal(null);
                      return;
                    }

                    // Lookup worktree data for this session
                    const worktree = worktrees.find((wt) => wt.worktree_id === session.worktree_id);

                    // Build Handlebars context from session, board, and worktree data
                    const context = {
                      session: {
                        description: session.description || '',
                        // User-defined custom context
                        context: session.custom_context || {},
                      },
                      board: {
                        name: board?.name || '',
                        description: board?.description || '',
                        context: board?.custom_context || {},
                      },
                      worktree: worktree
                        ? {
                            name: worktree.name || '',
                            ref: worktree.ref || '',
                            issue_url: worktree.issue_url || '',
                            pull_request_url: worktree.pull_request_url || '',
                            notes: worktree.notes || '',
                            path: worktree.path || '',
                            context: worktree.custom_context || {},
                          }
                        : {
                            name: '',
                            ref: '',
                            issue_url: '',
                            pull_request_url: '',
                            notes: '',
                            path: '',
                            context: {},
                          },
                    };

                    // Render template with Handlebars
                    let renderedPrompt: string;
                    try {
                      const template = Handlebars.compile(trigger.template);
                      renderedPrompt = template(context);
                      console.log('📝 Rendered template:', renderedPrompt);
                    } catch (templateError) {
                      console.error('❌ Handlebars template error:', templateError);
                      // Fallback to raw template if template fails
                      renderedPrompt = trigger.template;
                    }

                    // Send rendered prompt to session
                    await client.service(`sessions/${sessionId}/prompt`).create({
                      prompt: renderedPrompt,
                    });

                    console.log(
                      `✨ Zone trigger executed for session ${sessionId.substring(0, 8)}: ${renderedPrompt.substring(0, 50)}...`
                    );
                  } catch (error) {
                    console.error('❌ Failed to execute trigger:', error);
                  } finally {
                    setTriggerModal(null);
                  }
                }}
                onCancel={() => {
                  console.log('⏭️  Trigger skipped by user');
                  setTriggerModal(null);
                }}
                okText="Yes, Execute"
                cancelText="No, Skip"
              >
                <Paragraph>
                  The session has been pinned to{' '}
                  <Typography.Text strong>{triggerModal.zoneName}</Typography.Text>.
                </Paragraph>
                <Paragraph>
                  This zone has a{' '}
                  <Typography.Text strong>{triggerModal.trigger.behavior}</Typography.Text> trigger
                  configured:
                </Paragraph>
                <Paragraph
                  code
                  style={{
                    whiteSpace: 'pre-wrap',
                    background: '#1f1f1f',
                    padding: '12px',
                    borderRadius: '4px',
                  }}
                >
                  {renderedPromptPreview}
                </Paragraph>
                <Paragraph type="secondary">
                  Would you like to execute this trigger for the session now?
                </Paragraph>
              </Modal>
            );
          })()}

        {/* Markdown note creation/edit modal */}
        {markdownModal && (
          <Modal
            open={true}
            title={markdownModal.objectId ? 'Edit Markdown Note' : 'Add Markdown Note'}
            onCancel={() => {
              setMarkdownModal(null);
              setMarkdownContent('');
              setMarkdownWidth(500);
              setActiveTool('select');
            }}
            onOk={handleCreateMarkdownNote}
            okText={markdownModal.objectId ? 'Save' : 'Create'}
            okButtonProps={{ disabled: !markdownContent.trim() }}
            width={1000}
          >
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

        {/* Worktree Zone Trigger Modal */}
        {worktreeTriggerModal && (
          <ZoneTriggerModal
            open={true}
            onCancel={() => setWorktreeTriggerModal(null)}
            worktreeId={worktreeTriggerModal.worktreeId}
            worktree={worktrees.find((wt) => wt.worktree_id === worktreeTriggerModal.worktreeId)}
            sessionsByWorktree={sessionsByWorktree}
            zoneName={worktreeTriggerModal.zoneName}
            trigger={worktreeTriggerModal.trigger}
            boardName={board?.name}
            boardDescription={board?.description}
            boardCustomContext={board?.custom_context}
            availableAgents={availableAgents}
            mcpServerById={mcpServerById}
            currentUser={currentUserId ? userById.get(currentUserId) || null : null}
            onExecute={async ({
              sessionId,
              action,
              renderedTemplate,
              agent,
              modelConfig,
              permissionMode,
              mcpServerIds,
            }) => {
              if (!client) {
                console.error('❌ Cannot execute trigger: client not available');
                setWorktreeTriggerModal(null);
                return;
              }

              try {
                console.log(
                  `✨ Executing ${action} for worktree ${worktreeTriggerModal.worktreeId.substring(0, 8)}`
                );

                let targetSessionId = sessionId;

                // If creating new session, create it first
                if (sessionId === 'new') {
                  const newSession = await client.service('sessions').create({
                    worktree_id: worktreeTriggerModal.worktreeId,
                    agentic_tool: (agent || 'claude-code') as AgenticToolName,
                    description: `Session from zone "${worktreeTriggerModal.zoneName}"`,
                    status: 'idle',
                    model_config: modelConfig
                      ? {
                          ...modelConfig,
                          updated_at: new Date().toISOString(),
                        }
                      : undefined,
                    permission_config: permissionMode
                      ? {
                          mode: permissionMode,
                        }
                      : undefined,
                  });
                  targetSessionId = newSession.session_id;
                  console.log(`✓ Created new session: ${targetSessionId.substring(0, 8)}`);

                  // Attach MCP servers if provided
                  if (mcpServerIds && mcpServerIds.length > 0) {
                    await client
                      .service(`sessions/${targetSessionId}/mcp-servers`)
                      .patch(null, { mcpServerIds });
                    console.log(`✓ Attached ${mcpServerIds.length} MCP servers to session`);
                  }
                }

                // Execute action
                switch (action) {
                  case 'prompt': {
                    await client.service(`sessions/${targetSessionId}/prompt`).create({
                      prompt: renderedTemplate,
                      permissionMode,
                    });
                    console.log(`✓ Sent prompt to session ${targetSessionId.substring(0, 8)}`);
                    break;
                  }
                  case 'fork': {
                    const forkedSession = (await client
                      .service(`sessions/${targetSessionId}/fork`)
                      .create({})) as Session;
                    await client.service(`sessions/${forkedSession.session_id}/prompt`).create({
                      prompt: renderedTemplate,
                      permissionMode,
                    });
                    console.log(
                      `✓ Forked session and sent prompt to ${forkedSession.session_id.substring(0, 8)}`
                    );
                    break;
                  }
                  case 'spawn': {
                    const spawnedSession = (await client
                      .service(`sessions/${targetSessionId}/spawn`)
                      .create({})) as Session;
                    await client.service(`sessions/${spawnedSession.session_id}/prompt`).create({
                      prompt: renderedTemplate,
                      permissionMode,
                    });
                    console.log(
                      `✓ Spawned child session and sent prompt to ${spawnedSession.session_id.substring(0, 8)}`
                    );
                    break;
                  }
                }

                console.log('✅ Zone trigger executed successfully');
              } catch (error) {
                console.error('❌ Failed to execute zone trigger:', error);
              } finally {
                setWorktreeTriggerModal(null);
              }
            }}
          />
        )}
      </div>
    );
  }
);

SessionCanvas.displayName = 'SessionCanvas';

export default SessionCanvas;
