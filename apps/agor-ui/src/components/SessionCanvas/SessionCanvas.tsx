import type { AgorClient } from '@agor/core/api';
import type { BoardID, MCPServer, User, UserID, WorktreeID, ZoneTrigger } from '@agor/core/types';
import { BorderOutlined, CommentOutlined, DeleteOutlined, SelectOutlined } from '@ant-design/icons';
import { Button, Input, Modal, Popover, Typography, theme } from 'antd';
import Handlebars from 'handlebars';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type {
  Board,
  BoardComment,
  BoardCommentCreate,
  BoardObject,
  Repo,
  Session,
  Task,
  Worktree,
} from '@agor/core/types';
import { useCursorTracking } from '../../hooks/useCursorTracking';
import { usePresence } from '../../hooks/usePresence';
import type { AgenticToolOption } from '../../types';
import SessionCard from '../SessionCard';
import WorktreeCard from '../WorktreeCard';
import { CommentNode, ZoneNode } from './canvas/BoardObjectNodes';
import { CursorNode } from './canvas/CursorNode';
import { useBoardObjects } from './canvas/useBoardObjects';
import {
  findIntersectingObjects,
  findZoneAtPosition,
  findZoneForNode,
  type ZoneCollision,
} from './canvas/utils/collisionDetection';
import { getWorktreeParentInfo, getZoneParentInfo } from './canvas/utils/commentUtils';
import {
  absoluteToRelative,
  calculateStoragePosition,
  getDragAbsolutePosition,
  getNodeAbsolutePosition,
  type ParentInfo,
  relativeToAbsolute,
} from './canvas/utils/coordinateTransforms';
import { getAbsoluteNodePosition } from './canvas/utils/nodePositionUtils';
import { ZoneTriggerModal } from './canvas/ZoneTriggerModal';

const { Paragraph } = Typography;

interface SessionCanvasProps {
  board: Board | null;
  client: AgorClient | null;
  sessions: Session[];
  tasks: Record<string, Task[]>;
  users: User[];
  repos: Repo[];
  worktrees: import('@agor/core/types').Worktree[];
  boardObjects: import('@agor/core/types').BoardEntityObject[];
  comments: import('@agor/core/types').BoardComment[];
  currentUserId?: string;
  selectedSessionId?: string | null;
  availableAgents?: AgenticToolOption[];
  mcpServers?: MCPServer[];
  sessionMcpServerIds?: Record<string, string[]>; // Map sessionId -> mcpServerIds[]
  onSessionClick?: (sessionId: string) => void;
  onTaskClick?: (taskId: string) => void;
  onSessionUpdate?: (sessionId: string, updates: Partial<Session>) => void;
  onSessionDelete?: (sessionId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, prompt: string) => Promise<void>;
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
  onOpenCommentsPanel?: () => void;
  onCommentHover?: (commentId: string | null) => void;
  onCommentSelect?: (commentId: string | null) => void;
}

interface SessionNodeData {
  session: Session;
  tasks: Task[];
  users: User[];
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
        tasks={data.tasks}
        users={data.users}
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
  tasks: Record<string, Task[]>;
  users: User[];
  currentUserId?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (worktreeId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, prompt: string) => Promise<void>;
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
}

// Custom node component that renders WorktreeCard
const WorktreeNode = ({ data }: { data: WorktreeNodeData }) => {
  return (
    <div className="worktree-node">
      <WorktreeCard
        worktree={data.worktree}
        repo={data.repo}
        sessions={data.sessions}
        tasks={data.tasks}
        users={data.users}
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
};

const SessionCanvas = ({
  board,
  client,
  sessions,
  repos,
  worktrees,
  boardObjects,
  comments,
  tasks,
  users,
  currentUserId,
  selectedSessionId,
  availableAgents = [],
  mcpServers = [],
  sessionMcpServerIds = {},
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
  onOpenCommentsPanel,
  onCommentHover,
  onCommentSelect,
}: SessionCanvasProps) => {
  const { token } = theme.useToken();

  // Tool state for canvas annotations
  const [activeTool, setActiveTool] = useState<'select' | 'zone' | 'comment' | 'eraser'>('select');

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

  // Debug: Log board background color
  useEffect(() => {
    if (board) {
      console.log('🎨 Board loaded:', {
        board_id: board.board_id,
        name: board.name,
        background_color: board.background_color,
      });
    }
  }, [board]);

  // Debounce timer ref for position updates
  const layoutUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingLayoutUpdatesRef = useRef<Record<string, { x: number; y: number }>>({});
  const isDraggingRef = useRef(false);

  // Helper: Check if a node intersects with a zone
  const findIntersectingZone = useCallback(
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

  // Board objects hook
  const { getBoardObjectNodes, batchUpdateObjectPositions, deleteObject } = useBoardObjects({
    board,
    client,
    sessions,
    worktrees,
    boardObjects,
    setNodes,
    deletedObjectsRef,
    eraserMode: activeTool === 'eraser',
    selectedSessionId,
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

  // Handler to unpin a worktree from its zone
  const handleUnpinWorktree = useCallback(
    async (worktreeId: string) => {
      if (!board || !client) return;

      // Find the board_object for this worktree
      const boardObject = boardObjects.find(
        bo => bo.worktree_id === worktreeId && bo.board_id === board.board_id
      );

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

      console.log(
        `📍 Unpinning worktree ${worktreeId.substring(0, 8)}: relative (${boardObject.position.x}, ${boardObject.position.y}) -> absolute (${absoluteX}, ${absoluteY})`
      );

      // Update with absolute position and clear zone_id
      await client.service('board-objects').patch(boardObject.object_id, {
        position: { x: absoluteX, y: absoluteY },
        zone_id: null, // null serializes correctly, undefined gets stripped
      });

      console.log(`✓ Unpinned worktree ${worktreeId.substring(0, 8)}`);
    },
    [board, client, boardObjects]
  );

  // Convert worktrees to React Flow nodes (worktree-centric approach)
  const initialNodes: Node[] = useMemo(() => {
    // Auto-layout for worktrees without explicit positioning
    const VERTICAL_SPACING = 500;
    const _HORIZONTAL_SPACING = 600;

    // Create nodes for worktrees on this board
    const nodes: Node[] = [];

    for (let index = 0; index < worktrees.length; index++) {
      const worktree = worktrees[index];

      // Find board object for this worktree (if positioned on this board)
      const boardObject = boardObjects.find(
        bo => bo.worktree_id === worktree.worktree_id && bo.board_id === board?.board_id
      );

      // Use stored position from boardObject if available, otherwise auto-layout
      const position = boardObject
        ? { x: boardObject.position.x, y: boardObject.position.y }
        : { x: 100, y: 100 + index * VERTICAL_SPACING };

      // Check if worktree is pinned to a zone (via board_object.zone_id)
      // Note: zone_id in database already has 'zone-' prefix (e.g., 'zone-1234')
      const zoneId = boardObject?.zone_id; // Zone ID with 'zone-' prefix (for React Flow parentId)

      const dbZoneId = zoneId?.replace('zone-', ''); // Strip prefix for zoneLabels lookup
      const zoneName = dbZoneId ? zoneLabels[dbZoneId] || 'Unknown Zone' : undefined;
      const zoneObj = zoneId && board?.objects?.[zoneId] ? board.objects[zoneId] : undefined;
      const zoneColor =
        zoneObj && 'borderColor' in zoneObj
          ? zoneObj.borderColor || zoneObj.color // Backwards compat
          : undefined;

      // Get sessions for this worktree
      const worktreeSessions = sessions.filter(s => s.worktree_id === worktree.worktree_id);

      // Get repo for this worktree
      const repo = repos.find(r => r.repo_id === worktree.repo_id);
      if (!repo) {
        console.error(`Repo not found for worktree ${worktree.worktree_id}`);
        continue;
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
        // Constrain to parent zone if pinned (zone_id already has 'zone-' prefix)
        parentId: zoneId,
        extent: zoneId ? ('parent' as const) : undefined,
        data: {
          worktree,
          repo,
          sessions: worktreeSessions,
          tasks,
          users,
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
          onUnpin: handleUnpinWorktree,
          compact: false,
          isPinned: !!dbZoneId,
          zoneName,
          zoneColor,
        },
      });
    }

    return nodes;
  }, [
    board,
    boardObjects,
    repos,
    worktrees,
    sessions,
    tasks,
    users,
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
    handleUnpinWorktree,
    zoneLabels,
  ]);

  // No edges needed for worktree-centric boards
  // (Session genealogy is visualized within WorktreeCard, not as canvas edges)
  const initialEdges: Edge[] = useMemo(() => [], []);

  // Store ReactFlow instance ref
  const reactFlowInstanceRef = useRef<ReactFlowInstance | null>(null);

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
    users,
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

    // Filter to only spatial comments on this board (absolute OR relative positioned) and not resolved
    const spatialComments = comments.filter(
      c =>
        (c.position?.absolute || c.position?.relative) &&
        c.board_id === board?.board_id &&
        !c.resolved
    );

    // Count replies for each thread root
    const replyCount = new Map<string, number>();
    for (const comment of comments) {
      if (comment.parent_comment_id) {
        replyCount.set(
          comment.parent_comment_id,
          (replyCount.get(comment.parent_comment_id) || 0) + 1
        );
      }
    }

    for (const comment of spatialComments) {
      // Find user who created the comment
      const user = users.find(u => u.user_id === comment.created_by);

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
          const worktree = worktrees.find(w => w.worktree_id === rel.parent_id);
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
  }, [comments, users, board, worktrees, onOpenCommentsPanel, onCommentHover, onCommentSelect]);

  // Sync SESSION nodes only (don't trigger on zone changes)
  useEffect(() => {
    if (isDraggingRef.current) return;

    setNodes(currentNodes => {
      // Separate existing nodes by type
      const existingZones = currentNodes.filter(n => n.type === 'zone');
      const existingCursors = currentNodes.filter(n => n.type === 'cursor');
      const existingComments = currentNodes.filter(n => n.type === 'comment');

      // Update worktree nodes with preserved state
      const updatedWorktrees = initialNodes.map(newNode => {
        const existingNode = currentNodes.find(n => n.id === newNode.id);
        const localPosition = localPositionsRef.current[newNode.id];

        // If we have a local position (user is dragging or just dragged), use it
        if (localPosition) {
          // Get the incoming position in ABSOLUTE coordinates for comparison
          // If node has parentId, position is relative to parent - must convert to absolute
          let incomingAbsolutePosition = newNode.position;
          if (newNode.parentId) {
            // Parent could be a zone or another worktree
            const parentNode = [...initialNodes, ...existingZones].find(
              n => n.id === newNode.parentId
            );
            if (parentNode) {
              incomingAbsolutePosition = relativeToAbsolute(newNode.position, parentNode.position);
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
              n => n.id === newNode.parentId
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

      // Merge: zones (back) + worktrees (middle) + cursors/comments (front)
      return [...existingZones, ...updatedWorktrees, ...existingCursors, ...existingComments];
    });
  }, [initialNodes, setNodes]);

  // Helper: Partition nodes by type
  const partitionNodesByType = useCallback((nodes: Node[]) => {
    return {
      zones: nodes.filter(n => n.type === 'zone'),
      worktrees: nodes.filter(n => n.type === 'worktreeNode'),
      comments: nodes.filter(n => n.type === 'comment'),
      cursors: nodes.filter(n => n.type === 'cursor'),
    };
  }, []);

  // Helper: Apply consistent z-ordering to nodes
  // Z-order: zones < worktrees < comments < cursors (cursors always on top)
  const applyZOrder = useCallback(
    (zones: Node[], worktrees: Node[], comments: Node[], cursors: Node[]) => {
      return [...zones, ...worktrees, ...comments, ...cursors];
    },
    []
  );

  // Sync ZONE nodes separately
  useEffect(() => {
    if (isDraggingRef.current) return;

    const boardObjectNodes = getBoardObjectNodes();

    setNodes(currentNodes => {
      const { worktrees, comments, cursors } = partitionNodesByType(currentNodes);

      // Update zones with preserved selection state
      const zones = boardObjectNodes
        .filter(z => !deletedObjectsRef.current.has(z.id))
        .map(newZone => {
          const existingZone = currentNodes.find(n => n.id === newZone.id);
          return { ...newZone, selected: existingZone?.selected };
        });

      return applyZOrder(zones, worktrees, comments, cursors);
    });
  }, [getBoardObjectNodes, setNodes, applyZOrder, partitionNodesByType]);

  // Sync CURSOR nodes separately
  useEffect(() => {
    if (isDraggingRef.current) return;

    setNodes(currentNodes => {
      const { zones, worktrees, comments } = partitionNodesByType(currentNodes);
      return applyZOrder(zones, worktrees, comments, cursorNodes);
    });
  }, [cursorNodes, setNodes, applyZOrder, partitionNodesByType]);

  // Sync COMMENT nodes separately
  useEffect(() => {
    if (isDraggingRef.current) return;

    setNodes(currentNodes => {
      const { zones, worktrees, cursors } = partitionNodesByType(currentNodes);

      // Apply local position overrides to comment nodes (to prevent flicker during drag)
      const commentsWithLocalPositions = commentNodes.map(newNode => {
        const localPosition = localPositionsRef.current[newNode.id];

        if (localPosition) {
          // Get the incoming position in ABSOLUTE coordinates for comparison
          // If node has parentId, position is relative to parent - must convert to absolute
          let incomingAbsolutePosition = newNode.position;
          if (newNode.parentId) {
            const parentNode = [...worktrees, ...zones].find(n => n.id === newNode.parentId);
            if (parentNode) {
              incomingAbsolutePosition = relativeToAbsolute(newNode.position, parentNode.position);
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
            const parentNode = [...worktrees, ...zones].find(n => n.id === newNode.parentId);
            if (parentNode) {
              positionToUse = absoluteToRelative(localPosition, parentNode.position);
            }
          }

          return { ...newNode, position: positionToUse };
        }

        return newNode;
      });

      return applyZOrder(zones, worktrees, commentsWithLocalPositions, cursors);
    });
  }, [commentNodes, setNodes, applyZOrder, partitionNodesByType]);

  // Sync edges
  useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]); // REMOVED setEdges from dependencies

  // Intercept onNodesChange to detect resize events
  const onNodesChange = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: React Flow change event types are not exported
    (changes: any) => {
      // Detect resize by checking for dimensions changes
      // biome-ignore lint/suspicious/noExplicitAny: React Flow change event types are not exported
      changes.forEach((change: any) => {
        if (change.type === 'dimensions' && change.dimensions) {
          const node = nodes.find(n => n.id === change.id);
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
          // Separate updates for worktrees vs zones vs comments
          const worktreeUpdates: Array<{
            worktree_id: string;
            position: { x: number; y: number };
            zone_id?: string;
          }> = [];
          const zoneUpdates: Record<string, { x: number; y: number }> = {};
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
            const draggedNode = currentNodes.find(n => n.id === nodeId);

            if (draggedNode?.type === 'zone') {
              // Zone moved - update position via batchUpdateObjectPositions
              zoneUpdates[nodeId] = position;
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
                const zoneNode = currentNodes.find(n => n.id === droppedZoneId);
                if (zoneNode) {
                  // Use the zone's current React Flow position (always absolute for zones)
                  zonePosition = { x: zoneNode.position.x, y: zoneNode.position.y };
                }
              }

              // Check if worktree was already pinned to a zone before this drag
              const existingBoardObject = boardObjects.find(
                bo => bo.worktree_id === nodeId && bo.board_id === board.board_id
              );
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
                        const worktree = worktrees.find(wt => wt.worktree_id === nodeId);

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
              const existingBoardObject = boardObjects.find(
                bo => bo.worktree_id === worktree_id && bo.board_id === board.board_id
              );

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
                  ...(zone_id !== undefined && { zone_id }),
                });
              }
            }
          }

          // Update zone positions
          if (Object.keys(zoneUpdates).length > 0) {
            await batchUpdateObjectPositions(zoneUpdates);
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
              const zoneNode = currentNodes.find(n => n.id === `zone-${parentId}`);
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
              const worktreeNode = currentNodes.find(n => n.id === parentId);
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
            setNodes(prevNodes =>
              prevNodes.map(n => {
                if (n.id === `comment-${comment_id}`) {
                  // Update parentId to match new parent (or undefined if free-floating)
                  const updates: Partial<Node> = { parentId: newReactFlowParentId };

                  // If parent changed, also update position
                  if (newReactFlowParentId !== n.parentId) {
                    if (newReactFlowParentId) {
                      // Now has parent - convert to relative position
                      const parent = prevNodes.find(p => p.id === newReactFlowParentId);
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
    [board, client, batchUpdateObjectPositions, nodes, boardObjects, worktrees, setNodes]
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
        setNodes(nodes => [
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
              setNodes(nodes => nodes.filter(n => n.id !== objectId));
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

  // Node click handler for eraser mode and comment placement
  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      if (activeTool === 'eraser') {
        // Only delete board objects (zones), not worktrees or cursors
        if (node.type === 'zone') {
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
        style={{
          width: '100%',
          height: '100%',
          background: board?.background_color || undefined,
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
          onInit={instance => {
            reactFlowInstanceRef.current = instance;
          }}
          nodeTypes={nodeTypes}
          snapToGrid={true}
          snapGrid={[20, 20]}
          fitView
          minZoom={0.1}
          maxZoom={1.5}
          nodesDraggable={true}
          nodesConnectable={false}
          elementsSelectable={true}
          elevateNodesOnSelect={false}
          panOnDrag={activeTool === 'select'}
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
          {!board?.background_color && <Background />}
          <Controls position="top-left" showInteractive={false}>
            {/* Custom toolbox buttons */}
            <ControlButton
              onClick={e => {
                e.stopPropagation();
                setActiveTool('select');
              }}
              title="Select"
              style={{
                borderLeft: activeTool === 'select' ? '3px solid #1677ff' : 'none',
              }}
            >
              <SelectOutlined style={{ fontSize: '16px' }} />
            </ControlButton>
            <ControlButton
              onClick={e => {
                e.stopPropagation();
                setActiveTool('zone');
              }}
              title="Add Zone"
              style={{
                borderLeft: activeTool === 'zone' ? '3px solid #1677ff' : 'none',
              }}
            >
              <BorderOutlined style={{ fontSize: '16px' }} />
            </ControlButton>
            <ControlButton
              onClick={e => {
                e.stopPropagation();
                setActiveTool('comment');
              }}
              title="Add Comment"
              style={{
                borderLeft: activeTool === 'comment' ? '3px solid #1677ff' : 'none',
              }}
            >
              <CommentOutlined style={{ fontSize: '16px' }} />
            </ControlButton>
            <ControlButton
              onClick={e => {
                e.stopPropagation();
                setActiveTool(activeTool === 'eraser' ? 'select' : 'eraser');
              }}
              title="Eraser - Click to toggle"
              style={{
                borderLeft: activeTool === 'eraser' ? `3px solid ${token.colorError}` : 'none',
                color: activeTool === 'eraser' ? token.colorError : 'inherit',
                backgroundColor: activeTool === 'eraser' ? `${token.colorError}15` : 'transparent',
              }}
            >
              <DeleteOutlined style={{ fontSize: '16px' }} />
            </ControlButton>
          </Controls>
          <MiniMap
            nodeColor={node => {
              // Handle cursor nodes (show as bright color)
              if (node.type === 'cursor') return token.colorWarning;

              // Handle comment nodes - 100% alpha for top hierarchy
              if (node.type === 'comment') return token.colorText;

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
              <Input.TextArea
                placeholder="Add a comment..."
                value={commentInput}
                onChange={e => setCommentInput(e.target.value)}
                onPressEnter={e => {
                  if (!e.shiftKey) {
                    e.preventDefault();
                    handleCreateSpatialComment();
                  }
                }}
                autoFocus
                rows={3}
                style={{ marginBottom: 8 }}
              />
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
          const session = sessions.find(s => s.session_id === triggerModal.sessionId);
          let renderedPromptPreview = triggerModal.trigger.template;

          if (session) {
            try {
              // Lookup worktree data for this session
              const worktree = worktrees.find(wt => wt.worktree_id === session.worktree_id);

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
                  const session = sessions.find(s => s.session_id === sessionId);
                  if (!session) {
                    console.error('❌ Session not found:', sessionId);
                    setTriggerModal(null);
                    return;
                  }

                  // Lookup worktree data for this session
                  const worktree = worktrees.find(wt => wt.worktree_id === session.worktree_id);

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

      {/* Worktree Zone Trigger Modal */}
      {worktreeTriggerModal && (
        <ZoneTriggerModal
          open={true}
          onCancel={() => setWorktreeTriggerModal(null)}
          worktreeId={worktreeTriggerModal.worktreeId}
          worktree={worktrees.find(wt => wt.worktree_id === worktreeTriggerModal.worktreeId)}
          sessions={sessions}
          zoneName={worktreeTriggerModal.zoneName}
          trigger={worktreeTriggerModal.trigger}
          boardName={board?.name}
          boardDescription={board?.description}
          boardCustomContext={board?.custom_context}
          availableAgents={availableAgents}
          mcpServers={mcpServers}
          currentUser={currentUserId ? users.find(u => u.user_id === currentUserId) : null}
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
                  agentic_tool: (agent ||
                    'claude-code') as import('@agor/core/types').AgenticToolName,
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
};

export default SessionCanvas;
