// biome-ignore-all lint/plugin/noHardcodedColorLiteral: centralized categorical data-visualization palette
/**
 * Whole-namespace Knowledge graph view: documents as nodes, `references` edges
 * as links, laid out with a `d3-force` simulation (see `useForceLayout`).
 *
 * Highlight state (the focused/hovered doc and its neighbours) flows through a
 * React context that the custom node consumes, so hover styling never has to
 * call `setNodes` — which would otherwise fight the running simulation.
 */

import type {
  KnowledgeDocumentKind,
  KnowledgeGraphDocEdge,
  KnowledgeGraphDocNode,
} from '@agor/core/types';
import { Empty, Spin, Typography, theme } from 'antd';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { ForcePanel } from './ForcePanel';
import {
  DEFAULT_FORCE_PARAMS,
  type ForceLink,
  type ForceParams,
  useForceLayout,
} from './useForceLayout';

const { Text } = Typography;

const KIND_COLORS: Record<KnowledgeDocumentKind, string> = {
  doc: '#4096ff',
  memory: '#9254de',
  skill: '#36cfc9',
  prompt: '#73d13d',
  guide: '#ffa940',
  decision: '#ff7875',
  bundle: '#bae637',
  external: '#8c8c8c',
};

interface HighlightState {
  focusId: string | null;
  neighborIds: Set<string>;
  hasFocus: boolean;
}

const HighlightContext = createContext<HighlightState>({
  focusId: null,
  neighborIds: new Set(),
  hasFocus: false,
});

interface DocNodeData {
  documentId: string;
  title: string;
  kind: KnowledgeDocumentKind;
  iconEmoji?: string | null;
}

interface DocNodeLabelProps {
  title: string;
  iconEmoji?: string | null;
}

export function KnowledgeGraphDocNodeLabel({ title, iconEmoji }: DocNodeLabelProps) {
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        lineHeight: 1.3,
      }}
    >
      {iconEmoji ? (
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            flex: '0 0 auto',
            lineHeight: 1,
          }}
        >
          {iconEmoji}
        </span>
      ) : null}
      <Text
        style={{
          fontSize: 12,
          fontWeight: 500,
          lineHeight: 1.3,
          minWidth: 0,
          flex: '1 1 auto',
        }}
        ellipsis={{ tooltip: title }}
      >
        {title}
      </Text>
    </span>
  );
}

const DocNode = memo(({ id, data }: NodeProps<DocNodeData>) => {
  const { token } = theme.useToken();
  const { focusId, neighborIds, hasFocus } = useContext(HighlightContext);
  const isFocus = focusId === id;
  const isNeighbor = neighborIds.has(id);
  const dimmed = hasFocus && !isFocus && !isNeighbor;
  const accent = KIND_COLORS[data.kind] ?? KIND_COLORS.doc;

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        maxWidth: 180,
        padding: '6px 12px',
        borderRadius: token.borderRadiusLG,
        border: `1px solid ${isFocus ? accent : token.colorBorder}`,
        borderLeft: `4px solid ${accent}`,
        background: token.colorBgElevated,
        boxShadow: isFocus ? `0 0 0 2px ${accent}` : token.boxShadowTertiary,
        opacity: dimmed ? 0.25 : 1,
        transition: 'opacity 120ms ease, box-shadow 120ms ease',
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <KnowledgeGraphDocNodeLabel title={data.title} iconEmoji={data.iconEmoji} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
});
DocNode.displayName = 'KnowledgeGraphDocNode';

const nodeTypes = { kbDoc: DocNode };

export interface KnowledgeGraphProps {
  nodes: KnowledgeGraphDocNode[];
  edges: KnowledgeGraphDocEdge[];
  activeDocId: string | null;
  hoverDocId: string | null;
  onSelectDoc: (documentId: string) => void;
  onHoverDoc: (documentId: string | null) => void;
  loading?: boolean;
  emptyText?: string;
}

function nodeIdSignature(nodes: KnowledgeGraphDocNode[]): string {
  return nodes
    .map((n) => n.document_id)
    .sort()
    .join(',');
}

// Includes the rendered fields (title, kind) so the React Flow node `data` is
// refreshed when a document is edited, even when the node-id set is unchanged.
function nodeDataSignature(nodes: KnowledgeGraphDocNode[]): string {
  return nodes
    .map((n) => `${n.document_id}:${n.title}:${n.kind}:${n.icon_emoji ?? ''}`)
    .sort()
    .join('|');
}

export function KnowledgeGraph({
  nodes: docNodes,
  edges: docEdges,
  activeDocId,
  hoverDocId,
  onSelectDoc,
  onHoverDoc,
  loading = false,
  emptyText = 'No documents in this space yet.',
}: KnowledgeGraphProps) {
  const { token } = theme.useToken();
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [forceParams, setForceParams] = useState<ForceParams>(DEFAULT_FORCE_PARAMS);

  const nodeSignature = nodeIdSignature(docNodes);
  const dataSignature = nodeDataSignature(docNodes);
  const docNodeById = useMemo(
    () => new Map<string, KnowledgeGraphDocNode>(docNodes.map((n) => [n.document_id, n])),
    [docNodes]
  );

  // Rebuild the React Flow node set when the document set OR its rendered data
  // (title/kind) changes, preserving any positions already settled by the
  // simulation for surviving nodes. Keyed on `dataSignature` (which subsumes the
  // id set) so edits refresh labels/colors without resetting positions; the
  // separate fit/re-arm effects stay keyed on the id set only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `dataSignature`; reading `docNodes`/state via closure is intentional to avoid clobbering live positions.
  useEffect(() => {
    setRfNodes((current) => {
      const positionById = new Map(current.map((n) => [n.id, n.position]));
      // Seed new nodes on a ring (not the origin) so the very first auto-fit
      // frames a sensible spread instead of a pile at (0, 0); the force
      // simulation then relaxes them into their final layout.
      const radius = 60 + docNodes.length * 12;
      return docNodes.map((doc, index) => {
        const angle = (index / Math.max(docNodes.length, 1)) * 2 * Math.PI;
        return {
          id: doc.document_id,
          type: 'kbDoc',
          position: positionById.get(doc.document_id) ?? {
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius,
          },
          data: {
            documentId: doc.document_id,
            title: doc.title,
            kind: doc.kind,
            iconEmoji: doc.icon_emoji ?? null,
          },
        };
      });
    });
  }, [dataSignature, setRfNodes]);

  const links: ForceLink[] = useMemo(
    () => docEdges.map((e) => ({ source: e.source_document_id, target: e.target_document_id })),
    [docEdges]
  );
  const nodeIds = useMemo(() => docNodes.map((n) => n.document_id), [docNodes]);

  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const fitFrame = useRef<number | null>(null);
  // Instant, rAF-coalesced fit. Animating each call would stack tweens; instead
  // we snap the viewport so it can track the layout smoothly across many ticks.
  const fitToContent = useCallback(() => {
    if (fitFrame.current != null) return;
    fitFrame.current = requestAnimationFrame(() => {
      fitFrame.current = null;
      rfInstance.current?.fitView({ padding: 0.2 });
    });
  }, []);

  // The viewport follows the simulation only while it auto-lays-out (on load or
  // after a topology change), producing one continuous zoom-to-fit. A previous
  // version fit eagerly to the tight initial ring and again once the graph
  // spread out, which read as a jarring zoom-in-then-out. User drags disable
  // tracking so the camera never fights the pointer.
  const trackViewport = useRef(true);
  const trackFit = useCallback(() => {
    if (trackViewport.current) fitToContent();
  }, [fitToContent]);

  const { onDragStart, onDrag, onDragStop } = useForceLayout({
    nodeIds,
    links,
    params: forceParams,
    setNodes: setRfNodes,
    onTick: trackFit,
    onSettle: () => {
      trackFit();
      trackViewport.current = false;
    },
  });

  // Retuning forces reheats the simulation; re-arm viewport tracking so the
  // camera follows the graph as it re-settles instead of letting nodes drift
  // out of frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on forceParams; re-arm tracking when the layout is retuned.
  useEffect(() => {
    if (docNodes.length === 0) return;
    trackViewport.current = true;
  }, [forceParams]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the node-id set; re-arm tracking and frame the graph whenever that set changes.
  useEffect(() => {
    if (docNodes.length === 0) return;
    trackViewport.current = true;
    fitToContent();
    return () => {
      if (fitFrame.current != null) cancelAnimationFrame(fitFrame.current);
      fitFrame.current = null;
    };
  }, [nodeSignature, fitToContent]);

  // Adjacency for neighbour highlighting.
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of docEdges) {
      if (!map.has(edge.source_document_id)) map.set(edge.source_document_id, new Set());
      if (!map.has(edge.target_document_id)) map.set(edge.target_document_id, new Set());
      map.get(edge.source_document_id)!.add(edge.target_document_id);
      map.get(edge.target_document_id)!.add(edge.source_document_id);
    }
    return map;
  }, [docEdges]);

  const focusId = hoverDocId ?? activeDocId;
  const highlight: HighlightState = useMemo(
    () => ({
      focusId,
      neighborIds: focusId ? (adjacency.get(focusId) ?? new Set()) : new Set(),
      hasFocus: Boolean(focusId && docNodeById.has(focusId)),
    }),
    [focusId, adjacency, docNodeById]
  );

  // Styled edges (recomputed on highlight change — edges carry no position so
  // this never interferes with the simulation).
  const styledEdges: Edge[] = useMemo(() => {
    return docEdges.map((edge) => {
      const id = `${edge.source_document_id}->${edge.target_document_id}`;
      const touchesFocus =
        highlight.hasFocus &&
        (edge.source_document_id === highlight.focusId ||
          edge.target_document_id === highlight.focusId);
      const dimmed = highlight.hasFocus && !touchesFocus;
      return {
        id,
        source: edge.source_document_id,
        target: edge.target_document_id,
        animated: touchesFocus,
        style: {
          stroke: touchesFocus ? token.colorPrimary : token.colorBorder,
          strokeWidth: touchesFocus ? 2 : 1,
          opacity: dimmed ? 0.15 : 0.6,
        },
      } satisfies Edge;
    });
  }, [docEdges, highlight, token.colorPrimary, token.colorBorder]);

  if (!loading && docNodes.length === 0) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <Empty description={emptyText} />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', width: '100%', position: 'relative' }}>
      {loading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 10,
            display: 'grid',
            placeItems: 'center',
            background: `${token.colorBgContainer}99`,
            pointerEvents: 'none',
          }}
        >
          <Spin />
        </div>
      )}
      <HighlightContext.Provider value={highlight}>
        <ReactFlow
          nodes={rfNodes}
          edges={styledEdges}
          nodeTypes={nodeTypes}
          onInit={(instance) => {
            rfInstance.current = instance;
          }}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node: Node) => onSelectDoc(node.id)}
          onNodeMouseEnter={(_, node: Node) => onHoverDoc(node.id)}
          onNodeMouseLeave={() => onHoverDoc(null)}
          onNodeDragStart={(_, node: Node) => {
            trackViewport.current = false;
            onDragStart(node.id, node.position.x, node.position.y);
          }}
          // Disable auto-fit when the user pans/zooms so the camera never fights
          // the pointer. Programmatic moves (our own fitView) pass a null event,
          // so they don't cancel tracking mid-settle.
          onMoveStart={(event) => {
            if (event) trackViewport.current = false;
          }}
          onNodeDrag={(_, node: Node) => onDrag(node.id, node.position.x, node.position.y)}
          onNodeDragStop={(_, node: Node) => onDragStop(node.id)}
          fitView
          minZoom={0.1}
          // Figma-style navigation, matching SessionCanvas: two-finger scroll
          // pans, and zoom requires holding Cmd/Ctrl while scrolling.
          panOnScroll
          zoomActivationKeyCode={['Meta', 'Control']}
          proOptions={{ hideAttribution: true }}
        >
          <Background color={token.colorBorderSecondary} gap={20} />
          <Controls position="top-left" showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => KIND_COLORS[(node.data as DocNodeData)?.kind] ?? KIND_COLORS.doc}
            style={{ background: token.colorBgContainer }}
          />
          <Panel position="top-right">
            <ForcePanel
              params={forceParams}
              onChange={setForceParams}
              onReset={() => setForceParams(DEFAULT_FORCE_PARAMS)}
            />
          </Panel>
        </ReactFlow>
      </HighlightContext.Provider>
    </div>
  );
}
