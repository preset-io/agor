import type { AgorClient } from '@agor/core/api';
import type { MCPServer, User } from '@agor/core/types';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  type NodeDragHandler,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { Board, Session, Task } from '../../types';
import SessionCard from '../SessionCard';

interface SessionCanvasProps {
  board: Board | null;
  client: AgorClient | null;
  sessions: Session[];
  tasks: Record<string, Task[]>;
  users: User[];
  currentUserId?: string;
  mcpServers?: MCPServer[];
  sessionMcpServerIds?: Record<string, string[]>; // Map sessionId -> mcpServerIds[]
  onSessionClick?: (sessionId: string) => void;
  onTaskClick?: (taskId: string) => void;
  onSessionUpdate?: (sessionId: string, updates: Partial<Session>) => void;
  onSessionDelete?: (sessionId: string) => void;
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
  onOpenSettings?: (sessionId: string) => void;
}

interface SessionNodeData {
  session: Session;
  tasks: Task[];
  users: User[];
  currentUserId?: string;
  mcpServers: MCPServer[];
  sessionMcpServerIds: string[];
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: () => void;
  onUpdate?: (sessionId: string, updates: Partial<Session>) => void;
  onDelete?: (sessionId: string) => void;
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
  compact?: boolean;
}

// Custom node component that renders SessionCard
const SessionNode = ({ data }: { data: SessionNodeData }) => {
  return (
    <div className="session-node" style={{ cursor: 'default' }}>
      <SessionCard
        session={data.session}
        tasks={data.tasks}
        users={data.users}
        currentUserId={data.currentUserId}
        mcpServers={data.mcpServers}
        sessionMcpServerIds={data.sessionMcpServerIds}
        onTaskClick={data.onTaskClick}
        onSessionClick={data.onSessionClick}
        onUpdate={data.onUpdate}
        onDelete={data.onDelete}
        onUpdateSessionMcpServers={data.onUpdateSessionMcpServers}
        compact={data.compact}
      />
    </div>
  );
};

// Define nodeTypes outside component to avoid recreation on every render
const nodeTypes = {
  sessionNode: SessionNode,
};

const SessionCanvas = ({
  board,
  client,
  sessions,
  tasks,
  users,
  currentUserId,
  mcpServers = [],
  sessionMcpServerIds = {},
  onSessionClick,
  onTaskClick,
  onSessionUpdate,
  onSessionDelete,
  onUpdateSessionMcpServers,
  onOpenSettings,
}: SessionCanvasProps) => {
  // Debounce timer ref for position updates
  const layoutUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingLayoutUpdatesRef = useRef<Record<string, { x: number; y: number }>>({});
  const isDraggingRef = useRef(false);
  // Track positions we've explicitly set (to avoid being overwritten by other clients)
  const localPositionsRef = useRef<Record<string, { x: number; y: number }>>({});

  // Convert sessions to React Flow nodes
  const initialNodes: Node[] = useMemo(() => {
    // Simple layout algorithm: place nodes vertically with offset for children
    const nodeMap = new Map<string, { x: number; y: number; level: number }>();
    let currentY = 0;
    const VERTICAL_SPACING = 450;
    const HORIZONTAL_SPACING = 500;

    // First pass: identify root sessions (no parent, no forked_from)
    const rootSessions = sessions.filter(
      s => !s.genealogy.parent_session_id && !s.genealogy.forked_from_session_id
    );

    // Recursive function to layout session and its children
    const layoutSession = (session: Session, level: number, offsetX: number) => {
      nodeMap.set(session.session_id, { x: offsetX, y: currentY, level });
      currentY += VERTICAL_SPACING;

      // Layout children (both spawned and forked)
      const children = sessions.filter(
        s =>
          s.genealogy.parent_session_id === session.session_id ||
          s.genealogy.forked_from_session_id === session.session_id
      );

      children.forEach((child, index) => {
        layoutSession(child, level + 1, offsetX + index * HORIZONTAL_SPACING);
      });
    };

    // Layout all root sessions
    rootSessions.forEach((root, index) => {
      layoutSession(root, 0, index * HORIZONTAL_SPACING * 2);
    });

    // Convert to React Flow nodes
    return sessions.map(session => {
      // Use stored position from board layout if available, otherwise use auto-layout
      const storedPosition = board?.layout?.[session.session_id];
      const autoPosition = nodeMap.get(session.session_id) || { x: 0, y: 0 };
      const position = storedPosition || autoPosition;

      return {
        id: session.session_id,
        type: 'sessionNode',
        position,
        draggable: true,
        data: {
          session,
          tasks: tasks[session.session_id] || [],
          users,
          currentUserId,
          mcpServers,
          sessionMcpServerIds: sessionMcpServerIds[session.session_id] || [],
          onTaskClick,
          onSessionClick: () => onSessionClick?.(session.session_id),
          onUpdate: onSessionUpdate,
          onDelete: onSessionDelete,
          onUpdateSessionMcpServers,
          compact: false,
        },
      };
    });
  }, [
    board?.layout,
    sessions,
    tasks,
    users,
    currentUserId,
    mcpServers,
    sessionMcpServerIds,
    onSessionClick,
    onTaskClick,
    onSessionUpdate,
    onSessionDelete,
    onUpdateSessionMcpServers,
  ]);

  // Convert session relationships to React Flow edges
  const initialEdges: Edge[] = useMemo(() => {
    const edges: Edge[] = [];

    sessions.forEach(session => {
      // Fork relationship (dashed line)
      if (session.genealogy.forked_from_session_id) {
        edges.push({
          id: `fork-${session.genealogy.forked_from_session_id}-${session.session_id}`,
          source: session.genealogy.forked_from_session_id,
          target: session.session_id,
          type: 'default',
          animated: false,
          style: { strokeDasharray: '5,5', stroke: '#00b4d8' },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: '#00b4d8',
          },
          label: 'fork',
          labelStyle: { fill: '#00b4d8', fontWeight: 500 },
        });
      }

      // Spawn relationship (solid line)
      if (session.genealogy.parent_session_id) {
        edges.push({
          id: `spawn-${session.genealogy.parent_session_id}-${session.session_id}`,
          source: session.genealogy.parent_session_id,
          target: session.session_id,
          type: 'default',
          animated: true,
          style: { stroke: '#9333ea' },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: '#9333ea',
          },
          label: 'spawn',
          labelStyle: { fill: '#9333ea', fontWeight: 500 },
        });
      }
    });

    return edges;
  }, [sessions]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

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
      if (!board || !client) return;

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
          // CRITICAL: Only update the layout field to avoid race conditions
          // Merge with existing layout to preserve positions of non-moved nodes
          const newLayout = {
            ...board.layout,
            ...updates,
          };

          await client.service('boards').patch(board.board_id, {
            layout: newLayout,
          });

          console.log('✓ Layout persisted:', Object.keys(updates).length, 'sessions');
        } catch (error) {
          console.error('Failed to persist layout:', error);
        }
      }, 500);
    },
    [board, client]
  );

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (layoutUpdateTimerRef.current) {
        clearTimeout(layoutUpdateTimerRef.current);
      }
    };
  }, []);

  // Sync nodes when sessions or tasks change (WebSocket updates)
  // Prefer local positions over incoming WebSocket positions to avoid conflicts
  useEffect(() => {
    if (isDraggingRef.current) {
      // Skip sync during drag operations
      return;
    }

    setNodes(currentNodes => {
      return initialNodes.map(newNode => {
        // Check if we have a local position for this node
        const localPosition = localPositionsRef.current[newNode.id];

        // Check if the incoming position is different from our local cache
        const incomingPosition = newNode.position;
        const positionChanged =
          localPosition &&
          (Math.abs(localPosition.x - incomingPosition.x) > 1 ||
            Math.abs(localPosition.y - incomingPosition.y) > 1);

        if (positionChanged) {
          // Another client moved this node - clear our local cache and use their position
          delete localPositionsRef.current[newNode.id];
          return newNode;
        }

        if (localPosition) {
          // Use our local position (we moved it recently and no one else has)
          return {
            ...newNode,
            position: localPosition,
          };
        }

        // No local override - use the position from initialNodes (board.layout or auto-layout)
        return newNode;
      });
    });
  }, [initialNodes, setNodes]);

  // Sync edges when sessions change (genealogy updates)
  useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        nodeTypes={nodeTypes}
        snapToGrid={true}
        snapGrid={[20, 20]}
        fitView
        minZoom={0.1}
        maxZoom={1.5}
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background />
        <Controls />
        <MiniMap
          nodeColor={node => {
            const session = node.data.session as Session;
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
    </div>
  );
};

export default SessionCanvas;
