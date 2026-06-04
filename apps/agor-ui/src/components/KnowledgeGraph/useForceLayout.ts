/**
 * Force-directed layout for React Flow, powered by `d3-force`.
 *
 * React Flow is position-agnostic — it renders nodes at whatever `{x, y}` you
 * give it. This hook runs a d3-force simulation over the graph's topology and
 * writes the evolving positions back into React Flow each tick, so the layout
 * settles with the familiar force-directed animation. Dragging a node pins it
 * (`fx`/`fy`) and reheats the simulation so the rest re-settle around it.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
} from 'd3-force';
import { useCallback, useEffect, useRef } from 'react';
import type { Node } from 'reactflow';

interface SimNode {
  id: string;
  x: number;
  y: number;
  fx?: number | null;
  fy?: number | null;
}

interface SimLink {
  source: string;
  target: string;
}

export interface ForceLink {
  source: string;
  target: string;
}

interface UseForceLayoutOptions {
  /** Stable list of node ids participating in the layout. */
  nodeIds: string[];
  /** Edges (by node id) used as spring links. */
  links: ForceLink[];
  /** React Flow's `setNodes` so the hook can push positions back each tick. */
  setNodes: (updater: (nodes: Node[]) => Node[]) => void;
  /** Fired every tick (after positions are applied) so the view can track the layout as it settles. */
  onTick?: () => void;
  /** Fired once the simulation cools and positions settle (use to refit the view). */
  onSettle?: () => void;
}

/**
 * A topology signature: the simulation only restarts when the *set* of nodes or
 * edges changes, not when positions update (which would loop forever).
 */
function topologySignature(nodeIds: string[], links: ForceLink[]): string {
  return `${[...nodeIds].sort().join(',')}|${links
    .map((l) => `${l.source}>${l.target}`)
    .sort()
    .join(',')}`;
}

export function useForceLayout({
  nodeIds,
  links,
  setNodes,
  onTick,
  onSettle,
}: UseForceLayoutOptions) {
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);
  const simNodesById = useRef<Map<string, SimNode>>(new Map());
  // Latest inputs, read inside the effect without widening its dependency list.
  const latest = useRef({ nodeIds, links, setNodes, onTick, onSettle });
  latest.current = { nodeIds, links, setNodes, onTick, onSettle };

  const signature = topologySignature(nodeIds, links);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when the graph topology changes (captured by `signature`), not on every position tick.
  useEffect(() => {
    const { nodeIds: ids, links: edges, setNodes: applyNodes } = latest.current;
    if (ids.length === 0) {
      simRef.current?.stop();
      simRef.current = null;
      return;
    }

    // Seed positions, reusing any we already settled so the layout is stable
    // across reloads; new nodes start spread around a circle to avoid a pile-up
    // at the origin (which makes the simulation explode).
    const prev = simNodesById.current;
    const radius = 60 + ids.length * 12;
    const simNodes: SimNode[] = ids.map((id, index) => {
      const existing = prev.get(id);
      if (existing) return { id, x: existing.x, y: existing.y };
      const angle = (index / ids.length) * 2 * Math.PI;
      return { id, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    });
    const byId = new Map(simNodes.map((node) => [node.id, node]));
    simNodesById.current = byId;

    const simLinks: SimLink[] = edges
      .filter((edge) => byId.has(edge.source) && byId.has(edge.target))
      .map((edge) => ({ source: edge.source, target: edge.target }));

    const simulation = forceSimulation<SimNode>(simNodes)
      .force('charge', forceManyBody().strength(-450))
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((node) => node.id)
          .distance(140)
          .strength(0.35)
      )
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide(60))
      .alpha(1)
      .alphaDecay(0.045);

    simulation.on('tick', () => {
      applyNodes((nodes) =>
        nodes.map((node) => {
          const sim = byId.get(node.id);
          return sim ? { ...node, position: { x: sim.x, y: sim.y } } : node;
        })
      );
      latest.current.onTick?.();
    });
    simulation.on('end', () => latest.current.onSettle?.());

    simRef.current = simulation;
    return () => {
      simulation.stop();
      simRef.current = null;
    };
  }, [signature]);

  const onDragStart = useCallback((id: string, x: number, y: number) => {
    const node = simNodesById.current.get(id);
    if (node) {
      node.fx = x;
      node.fy = y;
    }
    simRef.current?.alphaTarget(0.3).restart();
  }, []);

  const onDrag = useCallback((id: string, x: number, y: number) => {
    const node = simNodesById.current.get(id);
    if (node) {
      node.fx = x;
      node.fy = y;
    }
  }, []);

  const onDragStop = useCallback((id: string) => {
    const node = simNodesById.current.get(id);
    if (node) {
      node.fx = null;
      node.fy = null;
    }
    simRef.current?.alphaTarget(0);
  }, []);

  return { onDragStart, onDrag, onDragStop };
}
