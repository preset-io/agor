import type { AgorClient } from '@agor/core/api';
import type { BoardID, MCPServer, User, WorktreeID, ZoneTrigger } from '@agor/core/types';
import { BorderOutlined, CommentOutlined, DeleteOutlined, SelectOutlined } from '@ant-design/icons';
import { Input, Modal, Popover, Typography } from 'antd';
import Handlebars from 'handlebars';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  ControlButton,
  Controls,
  type Edge,
  MarkerType,
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
import type { Board, BoardObject, Session, Task, Worktree } from '@agor/core/types';

// UI-only type for agent selection (different from AgenticTool which has UUIDv7 ID)
interface AgenticToolOption {
  id: string; // AgenticToolName as string
  name: string;
  icon: string;
  installed: boolean;
  installable?: boolean;
  version?: string;
  description?: string;
}

import { useCursorTracking } from '../../hooks/useCursorTracking';
import { usePresence } from '../../hooks/usePresence';
import SessionCard from '../SessionCard';
import WorktreeCard from '../WorktreeCard';
import { CommentNode, ZoneNode } from './canvas/BoardObjectNodes';
import { CursorNode } from './canvas/CursorNode';
import { useBoardObjects } from './canvas/useBoardObjects';
import { ZoneTriggerModal } from './canvas/ZoneTriggerModal';

const { Paragraph } = Typography;

interface SessionCanvasProps {
  board: Board | null;
  client: AgorClient | null;
  sessions: Session[];
  tasks: Record<string, Task[]>;
  users: User[];
  worktrees: import('@agor/core/types').Worktree[];
  boardObjects: import('@agor/core/types').BoardEntityObject[];
  comments: import('@agor/core/types').BoardComment[];
  currentUserId?: string;
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
  onDeleteWorktree?: (worktreeId: string, deleteFromFilesystem: boolean) => void;
  onOpenTerminal?: (commands: string[]) => void;
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
  sessions: Session[];
  tasks: Record<string, Task[]>;
  users: User[];
  currentUserId?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (worktreeId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, prompt: string) => Promise<void>;
  onDelete?: (worktreeId: string) => void;
  onOpenSettings?: (worktreeId: string) => void;
  onOpenTerminal?: (commands: string[]) => void;
  onUnpin?: (worktreeId: string) => void;
  compact?: boolean;
  isPinned?: boolean;
  parentZoneId?: string;
  zoneName?: string;
  zoneColor?: string;
}

// Custom node component that renders WorktreeCard
const WorktreeNode = ({ data }: { data: WorktreeNodeData }) => {
  return (
    <div className="worktree-node">
      <WorktreeCard
        worktree={data.worktree}
        sessions={data.sessions}
        tasks={data.tasks}
        users={data.users}
        currentUserId={data.currentUserId}
        onTaskClick={data.onTaskClick}
        onSessionClick={data.onSessionClick}
        onCreateSession={data.onCreateSession}
        onForkSession={data.onForkSession}
        onSpawnSession={data.onSpawnSession}
        onDelete={data.onDelete}
        onOpenSettings={data.onOpenSettings}
        onOpenTerminal={data.onOpenTerminal}
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
  worktrees,
  boardObjects,
  comments,
  tasks,
  users,
  currentUserId,
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
  onDeleteWorktree,
  onOpenTerminal,
}: SessionCanvasProps) => {
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
  const { getBoardObjectNodes, addZoneNode, deleteObject, batchUpdateObjectPositions } =
    useBoardObjects({
      board,
      client,
      sessions,
      worktrees,
      boardObjects,
      setNodes,
      deletedObjectsRef,
      eraserMode: activeTool === 'eraser',
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
    const HORIZONTAL_SPACING = 600;

    // Create nodes for worktrees on this board
    return worktrees.map((worktree, index) => {
      // Find board object for this worktree (if positioned on this board)
      const boardObject = boardObjects.find(
        bo => bo.worktree_id === worktree.worktree_id && bo.board_id === board?.board_id
      );

      // Use stored position from boardObject if available, otherwise auto-layout
      const position = boardObject
        ? { x: boardObject.position.x, y: boardObject.position.y }
        : { x: 100, y: 100 + index * VERTICAL_SPACING };

      // Check if worktree is pinned to a zone (via board_object.zone_id)
      const zoneId = boardObject?.zone_id;
      const zoneName = zoneId ? zoneLabels[zoneId] || 'Unknown Zone' : undefined;
      const zoneColor =
        zoneId && board?.objects?.[zoneId]
          ? (board.objects[zoneId] as { color?: string }).color
          : undefined;

      // Get sessions for this worktree
      const worktreeSessions = sessions.filter(s => s.worktree_id === worktree.worktree_id);

      return {
        id: worktree.worktree_id,
        type: 'worktreeNode',
        position,
        draggable: true,
        // Constrain to parent zone if pinned
        parentId: zoneId,
        extent: zoneId ? ('parent' as const) : undefined,
        data: {
          worktree,
          sessions: worktreeSessions,
          tasks,
          users,
          currentUserId,
          onTaskClick,
          onSessionClick,
          onCreateSession: onCreateSessionForWorktree,
          onForkSession,
          onSpawnSession,
          onDelete: onDeleteWorktree,
          onOpenSettings: onOpenWorktree,
          onOpenTerminal,
          onUnpin: handleUnpinWorktree,
          compact: false,
          isPinned: !!zoneId,
          zoneName,
          zoneColor,
        },
      };
    });
  }, [
    board,
    boardObjects,
    worktrees,
    sessions,
    tasks,
    users,
    currentUserId,
    onSessionClick,
    onTaskClick,
    onCreateSessionForWorktree,
    onForkSession,
    onSpawnSession,
    onDeleteWorktree,
    onOpenWorktree,
    onOpenTerminal,
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

    // Filter to only spatial comments (with position.absolute)
    const spatialComments = comments.filter(c => c.position?.absolute);

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
      if (comment.position?.absolute) {
        // Find user who created the comment
        const user = users.find(u => u.user_id === comment.created_by);

        console.log(
          `📌 Rendering comment ${comment.comment_id.slice(0, 8)} at:`,
          comment.position.absolute
        );

        nodes.push({
          id: `comment-${comment.comment_id}`,
          type: 'comment',
          position: comment.position.absolute,
          draggable: true,
          selectable: true,
          data: {
            comment,
            replyCount: replyCount.get(comment.comment_id) || 0,
            user,
            onClick: (commentId: string) => {
              // TODO: Phase 2 - open comments panel and scroll to comment
              console.log('Clicked comment:', commentId);
            },
          },
        });
      }
    }

    return nodes;
  }, [comments, users]);

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
        const incomingPosition = newNode.position;
        const positionChanged =
          localPosition &&
          (Math.abs(localPosition.x - incomingPosition.x) > 1 ||
            Math.abs(localPosition.y - incomingPosition.y) > 1);

        if (positionChanged) {
          delete localPositionsRef.current[newNode.id];
          return { ...newNode, selected: existingNode?.selected };
        }

        if (localPosition) {
          return { ...newNode, position: localPosition, selected: existingNode?.selected };
        }

        return { ...newNode, selected: existingNode?.selected };
      });

      // Merge: worktrees + existing zones + existing cursors + existing comments
      return [...updatedWorktrees, ...existingZones, ...existingCursors, ...existingComments];
    });
  }, [initialNodes, setNodes]);

  // Sync ZONE nodes separately
  useEffect(() => {
    if (isDraggingRef.current) return;

    const boardObjectNodes = getBoardObjectNodes();

    setNodes(currentNodes => {
      // Keep existing worktrees, cursors, and comments, replace zones
      const worktrees = currentNodes.filter(n => n.type === 'worktreeNode');
      const cursors = currentNodes.filter(n => n.type === 'cursor');
      const comments = currentNodes.filter(n => n.type === 'comment');

      // Update zones with preserved selection state
      const zones = boardObjectNodes
        .filter(z => !deletedObjectsRef.current.has(z.id))
        .map(newZone => {
          const existingZone = currentNodes.find(n => n.id === newZone.id);
          // Preserve selected state from existing zone
          return { ...newZone, selected: existingZone?.selected };
        });

      return [...worktrees, ...zones, ...cursors, ...comments];
    });
  }, [getBoardObjectNodes, setNodes]); // REMOVED setNodes from dependencies

  // Sync CURSOR nodes separately
  useEffect(() => {
    if (isDraggingRef.current) return;

    setNodes(currentNodes => {
      // Keep existing worktrees, zones, and comments, replace cursors
      const worktrees = currentNodes.filter(n => n.type === 'worktreeNode');
      const zones = currentNodes.filter(n => n.type === 'zone');
      const comments = currentNodes.filter(n => n.type === 'comment');

      return [...worktrees, ...zones, ...comments, ...cursorNodes];
    });
  }, [cursorNodes, setNodes]); // REMOVED setNodes from dependencies

  // Sync COMMENT nodes separately
  useEffect(() => {
    if (isDraggingRef.current) return;

    setNodes(currentNodes => {
      // Keep existing worktrees, zones, and cursors, replace comments
      const worktrees = currentNodes.filter(n => n.type === 'worktreeNode');
      const zones = currentNodes.filter(n => n.type === 'zone');
      const cursors = currentNodes.filter(n => n.type === 'cursor');

      return [...worktrees, ...zones, ...cursors, ...commentNodes];
    });
  }, [commentNodes, setNodes]);

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
    localPositionsRef.current[node.id] = {
      x: node.position.x,
      y: node.position.y,
    };
  }, []);

  // Handle node drag end - persist layout to board (debounced)
  const handleNodeDragStop: NodeDragHandler = useCallback(
    (_event, node) => {
      if (!board || !client || !reactFlowInstanceRef.current) return;

      // Track final position locally
      localPositionsRef.current[node.id] = {
        x: node.position.x,
        y: node.position.y,
      };

      // Accumulate position updates
      pendingLayoutUpdatesRef.current[node.id] = {
        x: node.position.x,
        y: node.position.y,
      };

      // Clear existing timer
      if (layoutUpdateTimerRef.current) {
        clearTimeout(layoutUpdateTimerRef.current);
      }

      // Debounce: wait 500ms after last drag before persisting
      layoutUpdateTimerRef.current = setTimeout(async () => {
        const updates = pendingLayoutUpdatesRef.current;
        pendingLayoutUpdatesRef.current = {};
        isDraggingRef.current = false;

        try {
          // Separate updates for worktrees vs zones (all use board_objects table)
          const worktreeUpdates: Array<{
            worktree_id: string;
            position: { x: number; y: number };
            zone_id?: string;
          }> = [];
          const zoneUpdates: Record<string, { x: number; y: number }> = {};

          // Find all current nodes to check types
          const currentNodes = nodes;

          for (const [nodeId, position] of Object.entries(updates)) {
            const draggedNode = currentNodes.find(n => n.id === nodeId);

            if (draggedNode?.type === 'zone') {
              // Zone moved - update position via batchUpdateObjectPositions
              zoneUpdates[nodeId] = position;
            } else if (draggedNode?.type === 'worktreeNode') {
              // Check if worktree was dropped on a zone
              const zoneIntersection = findIntersectingZone(position);
              const droppedZoneId = zoneIntersection?.zoneId;

              // Check if worktree was already pinned to a zone before this drag
              const existingBoardObject = boardObjects.find(
                bo => bo.worktree_id === nodeId && bo.board_id === board.board_id
              );
              const wasPinned = !!existingBoardObject?.zone_id;

              // Calculate position to store
              let positionToStore = position;
              if (droppedZoneId && !wasPinned) {
                // First-time pinning: convert absolute position to relative
                const zoneData = zoneIntersection.zoneData;
                positionToStore = {
                  x: position.x - zoneData.x,
                  y: position.y - zoneData.y,
                };
                console.log(
                  `🎯 Converting to relative position: absolute (${position.x}, ${position.y}) -> relative (${positionToStore.x}, ${positionToStore.y})`
                );
              }

              // Worktree moved - update board_object position (and zone_id if dropped on zone)
              worktreeUpdates.push({
                worktree_id: nodeId,
                position: positionToStore,
                zone_id: droppedZoneId,
              });
              console.log(
                `📦 Moved worktree ${nodeId.substring(0, 8)} to (${Math.round(positionToStore.x)}, ${Math.round(positionToStore.y)})`
              );

              if (zoneIntersection) {
                const { zoneId, zoneData } = zoneIntersection;
                console.log(
                  `🎯 Worktree ${nodeId.substring(0, 8)} dropped on zone "${zoneData.label}"`
                );
                console.log(
                  `📌 Pinned worktree ${nodeId.substring(0, 8)} to zone "${zoneData.label}"`
                );

                // Handle trigger if zone has one
                const trigger = zoneData.trigger;
                if (trigger) {
                  if (trigger.behavior === 'always_new') {
                    // Always_new: Auto-create new root session and apply trigger
                    console.log('⚡ always_new behavior - creating new session...');

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

                        console.log(
                          `✓ Created new session: ${newSession.session_id.substring(0, 8)}`
                        );

                        // Send prompt to new session
                        await client.service(`sessions/${newSession.session_id}/prompt`).create({
                          prompt: renderedPrompt,
                        });

                        console.log(
                          `✅ Always_new trigger executed: session ${newSession.session_id.substring(0, 8)}`
                        );
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
            console.log('✓ Worktree positions persisted:', worktreeUpdates.length, 'worktrees');
          }

          // Update zone positions
          if (Object.keys(zoneUpdates).length > 0) {
            await batchUpdateObjectPositions(zoneUpdates);
          }
        } catch (error) {
          console.error('Failed to persist layout:', error);
        }
      }, 500);
    },
    [
      board,
      client,
      batchUpdateObjectPositions,
      nodes,
      boardObjects,
      findIntersectingZone,
      worktrees,
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
        setDrawingZone({
          start: { x: event.pageX, y: event.pageY },
          end: { x: event.pageX, y: event.pageY },
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
          end: { x: event.pageX, y: event.pageY },
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

        // Optimistic update
        setNodes(nodes => [
          ...nodes,
          {
            id: objectId,
            type: 'zone',
            position,
            draggable: true,
            style: { width, height, zIndex: -1 },
            data: {
              objectId,
              label: 'New Zone',
              width,
              height,
              color: '#d9d9d9',
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
                color: '#d9d9d9',
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
        // Get the ReactFlow wrapper element bounds to calculate container-relative coordinates
        const reactFlowBounds = (event.currentTarget as HTMLElement)
          .closest('.react-flow')
          ?.getBoundingClientRect();

        if (!reactFlowBounds) return;

        // Calculate position relative to ReactFlow container (accounting for CommentsPanel offset)
        const containerX = event.clientX - reactFlowBounds.left;
        const containerY = event.clientY - reactFlowBounds.top;

        // Project from container-relative screen coords to flow coords
        const position = reactFlowInstanceRef.current.project({
          x: containerX,
          y: containerY,
        });

        console.log('📍 Comment click:', {
          client: { x: event.clientX, y: event.clientY },
          bounds: { left: reactFlowBounds.left, top: reactFlowBounds.top },
          container: { x: containerX, y: containerY },
          flowPosition: position,
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
      console.log('💾 Saving comment at position:', commentPlacement.position);

      await client.service('board-comments').create({
        board_id: board.board_id,
        created_by: currentUserId,
        content: commentInput.trim(),
        position: {
          absolute: commentPlacement.position,
        },
        resolved: false,
        edited: false,
        reactions: [],
      });

      // Reset state
      setCommentPlacement(null);
      setCommentInput('');
      setActiveTool('select');
    } catch (error) {
      console.error('Failed to create spatial comment:', error);
    }
  }, [commentPlacement, board, client, currentUserId, commentInput]);

  // Node click handler for eraser mode
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (activeTool === 'eraser') {
        // Only delete board objects (zones), not worktrees or cursors
        if (node.type === 'zone') {
          deleteObject(node.id);
        }
        return;
      }

      // Worktree cards handle their own session clicks internally
      // (no canvas-level click handler needed for worktreeNode)
    },
    [activeTool, deleteObject]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'z') setActiveTool('zone');
      if (e.key === 'c') setActiveTool('comment');
      if (e.key === 'e') setActiveTool('eraser');
      if (e.key === 'Escape') setActiveTool('select');
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete selected nodes
        const selectedNodes = nodes.filter(n => n.selected);
        selectedNodes.forEach(n => {
          if (n.type === 'zone') {
            deleteObject(n.id);
          }
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nodes, deleteObject]);

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
            position: 'absolute',
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
        panOnDrag={activeTool === 'select'}
        className={`dark tool-mode-${activeTool}`}
      >
        <Background />
        <Controls position="top-left" showInteractive={false}>
          {/* Custom toolbox buttons */}
          <ControlButton
            onClick={e => {
              e.stopPropagation();
              setActiveTool('select');
            }}
            title="Select (Esc)"
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
            title="Add Zone (Z)"
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
            title="Add Comment (C)"
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
            title="Eraser (E) - Click to toggle"
            style={{
              borderLeft: activeTool === 'eraser' ? '3px solid #ff4d4f' : 'none',
              color: activeTool === 'eraser' ? '#ff4d4f' : 'inherit',
              backgroundColor: activeTool === 'eraser' ? '#fff1f0' : 'transparent',
            }}
          >
            <DeleteOutlined style={{ fontSize: '16px' }} />
          </ControlButton>
        </Controls>
        <MiniMap
          nodeColor={node => {
            // Handle cursor nodes (show as bright color)
            if (node.type === 'cursor') return '#faad14';

            // Handle board objects (zones)
            if (node.type === 'zone') return '#d9d9d9';

            // Handle session nodes
            const session = node.data.session as Session;
            if (!session) return '#d9d9d9';

            switch (session.status) {
              case 'running':
                return '#1890ff';
              case 'completed':
                return '#52c41a';
              case 'failed':
                return '#ff4d4f';
              default:
                return '#d9d9d9';
            }
          }}
          pannable
          zoomable
        />
      </ReactFlow>

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
                <Typography.Link
                  onClick={() => {
                    setCommentPlacement(null);
                    setCommentInput('');
                    setActiveTool('select');
                  }}
                  style={{ lineHeight: '32px' }}
                >
                  Cancel
                </Typography.Link>
                <Typography.Link
                  onClick={handleCreateSpatialComment}
                  disabled={!commentInput.trim()}
                  style={{ lineHeight: '32px', fontWeight: 500 }}
                >
                  Comment
                </Typography.Link>
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
