/**
 * Force-directed layout for React Flow, powered by `d3-force`.
 *
 * React Flow is position-agnostic — it renders nodes at whatever `{x, y}` you
 * give it. This hook runs a d3-force simulation over the graph's topology and
 * writes the evolving positions back into React Flow each tick, so the layout
 * settles with the familiar force-directed animation. Dragging a node pins it
 * (`fx`/`fy`) and reheats the simulation so the rest re-settle around it.
 *
 * The force parameters are live-tunable: the simulation is built once per
 * topology change, and a separate effect mutates the existing forces in place
 * (then reheats) whenever the params change — so sliders can retune the layout
 * without reseeding positions.
 */

import {
  type ForceLink as D3ForceLink,
  type ForceCenter,
  type ForceCollide,
  type ForceManyBody,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  type Simulation,
} from 'd3-force';
import { useCallback, useEffect, useRef } from 'react';
import type { Node } from 'reactflow';

interface SimNode {
  id: string;
  x: number;
  y: number;
  // Velocity components written by d3 each tick; the vertical force nudges `vy`.
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

interface SimLink {
  source: string;
  target: string;
}

/** Edge resolved to its endpoint nodes, used by the directional vertical force. */
interface SimNodeLink {
  source: SimNode;
  target: SimNode;
}

export interface ForceLink {
  source: string;
  target: string;
}

/** Live-tunable knobs for the simulation. See `DEFAULT_FORCE_PARAMS`. */
export interface ForceParams {
  /** Many-body repulsion (negative = repel). More negative = airier graph. */
  chargeStrength: number;
  /** Resting length of each edge spring. */
  linkDistance: number;
  /** Edge spring stiffness (0–1). */
  linkStrength: number;
  /** How firmly the whole cloud is pulled toward the origin (0–1). */
  centerStrength: number;
  /** Minimum spacing between nodes (overlap prevention). */
  collideRadius: number;
  /** Cooling rate — lower = longer settling animation. */
  alphaDecay: number;
  /**
   * Strength of the degree-driven radial force (0 = off). When > 0, nodes are
   * pulled toward a target ring whose radius shrinks with degree, so hubs drift
   * toward the center and leaves toward the rim.
   */
  radialStrength: number;
  /** Which degree drives radial centering: incoming links only, or all links. */
  degreeMode: 'in' | 'total';
  /**
   * Strength of the directional vertical force (0 = off). For each edge it pulls
   * the source up and the target down, so links flow top-to-bottom (matching the
   * top=target / bottom=source handle layout). Only reads on roughly-acyclic
   * graphs; reciprocal links cancel out. Experimental.
   */
  verticalStrength: number;
}

export const DEFAULT_FORCE_PARAMS: ForceParams = {
  chargeStrength: -450,
  linkDistance: 140,
  linkStrength: 0.35,
  centerStrength: 1,
  collideRadius: 60,
  alphaDecay: 0.045,
  radialStrength: 0,
  degreeMode: 'in',
  verticalStrength: 0,
};

interface DegreeInfo {
  inDeg: Map<string, number>;
  totalDeg: Map<string, number>;
  count: number;
}

interface UseForceLayoutOptions {
  /** Stable list of node ids participating in the layout. */
  nodeIds: string[];
  /** Edges (by node id) used as spring links. */
  links: ForceLink[];
  /** React Flow's `setNodes` so the hook can push positions back each tick. */
  setNodes: (updater: (nodes: Node[]) => Node[]) => void;
  /** Tunable force parameters. */
  params: ForceParams;
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

/** Outer ring radius the radial force maps degree onto. Scales with graph size. */
function maxRadiusFor(count: number): number {
  return 60 + count * 14;
}

/**
 * Build a radius accessor for the radial force: a node's target distance from
 * center is inversely proportional to its (in- or total-) degree, so the most
 * linked-to documents pull toward the middle.
 */
function makeRadiusAccessor(mode: ForceParams['degreeMode'], degree: DegreeInfo) {
  const map = mode === 'in' ? degree.inDeg : degree.totalDeg;
  let maxDeg = 0;
  for (const v of map.values()) if (v > maxDeg) maxDeg = v;
  const maxRadius = maxRadiusFor(degree.count);
  return (node: SimNode) => {
    if (maxDeg === 0) return maxRadius;
    const d = map.get(node.id) ?? 0;
    return maxRadius * (1 - d / maxDeg);
  };
}

/**
 * Custom directional force: nudges each edge's source upward and target
 * downward (screen y grows down), so directed links tend to flow top-to-bottom.
 * d3 has no built-in for this; it's a plain `force(alpha)` with a no-op
 * `initialize`. The nudge scales with `alpha` so it relaxes as the sim cools.
 */
function makeVerticalForce(strength: number, links: SimNodeLink[]) {
  const force = (alpha: number) => {
    const k = strength * alpha;
    if (k === 0) return;
    for (const { source, target } of links) {
      source.vy = (source.vy ?? 0) - k;
      target.vy = (target.vy ?? 0) + k;
    }
  };
  force.initialize = () => {};
  return force;
}

/** Mutate the live simulation's forces to match `params` (does not reheat). */
function applyForces(
  sim: Simulation<SimNode, undefined>,
  params: ForceParams,
  degree: DegreeInfo,
  verticalLinks: SimNodeLink[]
) {
  (sim.force('charge') as ForceManyBody<SimNode> | undefined)?.strength(params.chargeStrength);
  (sim.force('link') as D3ForceLink<SimNode, SimLink> | undefined)
    ?.distance(params.linkDistance)
    .strength(params.linkStrength);
  (sim.force('center') as ForceCenter<SimNode> | undefined)?.strength(params.centerStrength);
  (sim.force('collide') as ForceCollide<SimNode> | undefined)?.radius(params.collideRadius);
  sim.force(
    'radial',
    forceRadial<SimNode>(makeRadiusAccessor(params.degreeMode, degree), 0, 0).strength(
      params.radialStrength
    )
  );
  sim.force('vertical', makeVerticalForce(params.verticalStrength, verticalLinks));
  sim.alphaDecay(params.alphaDecay);
}

export function useForceLayout({
  nodeIds,
  links,
  setNodes,
  params,
  onTick,
  onSettle,
}: UseForceLayoutOptions) {
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);
  const simNodesById = useRef<Map<string, SimNode>>(new Map());
  const degreeRef = useRef<DegreeInfo>({ inDeg: new Map(), totalDeg: new Map(), count: 0 });
  const verticalLinksRef = useRef<SimNodeLink[]>([]);
  // The param signature last written into the live simulation. Lets the param
  // effect skip the redundant reheat right after a fresh sim is created.
  const appliedSigRef = useRef<string | null>(null);
  // Latest inputs, read inside the effect without widening its dependency list.
  const latest = useRef({ nodeIds, links, setNodes, params, onTick, onSettle });
  latest.current = { nodeIds, links, setNodes, params, onTick, onSettle };

  const signature = topologySignature(nodeIds, links);
  const paramSig = JSON.stringify(params);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when the graph topology changes (captured by `signature`), not on every position tick.
  useEffect(() => {
    const { nodeIds: ids, links: edges, setNodes: applyNodes, params: p } = latest.current;
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

    // Degree counts (computed while links are still {source,target} strings,
    // before forceLink rewrites them to node references).
    const inDeg = new Map<string, number>();
    const totalDeg = new Map<string, number>();
    for (const link of simLinks) {
      inDeg.set(link.target, (inDeg.get(link.target) ?? 0) + 1);
      totalDeg.set(link.source, (totalDeg.get(link.source) ?? 0) + 1);
      totalDeg.set(link.target, (totalDeg.get(link.target) ?? 0) + 1);
    }
    const degree: DegreeInfo = { inDeg, totalDeg, count: ids.length };
    degreeRef.current = degree;

    // Resolve links to their endpoint nodes for the vertical force (computed
    // before forceLink runs, but byId values are stable node refs either way).
    const verticalLinks: SimNodeLink[] = simLinks.map((link) => ({
      source: byId.get(link.source)!,
      target: byId.get(link.target)!,
    }));
    verticalLinksRef.current = verticalLinks;

    const simulation = forceSimulation<SimNode>(simNodes)
      .force('charge', forceManyBody().strength(p.chargeStrength))
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((node) => node.id)
          .distance(p.linkDistance)
          .strength(p.linkStrength)
      )
      .force('center', forceCenter(0, 0).strength(p.centerStrength))
      .force('collide', forceCollide(p.collideRadius))
      .force(
        'radial',
        forceRadial<SimNode>(makeRadiusAccessor(p.degreeMode, degree), 0, 0).strength(
          p.radialStrength
        )
      )
      .force('vertical', makeVerticalForce(p.verticalStrength, verticalLinks))
      .alpha(1)
      .alphaDecay(p.alphaDecay);
    appliedSigRef.current = JSON.stringify(p);

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

  // Live-retune: mutate the running simulation's forces and reheat when params
  // change. Skipped right after a topology rebuild (which already applied them).
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    if (appliedSigRef.current === paramSig) return;
    appliedSigRef.current = paramSig;
    applyForces(sim, latest.current.params, degreeRef.current, verticalLinksRef.current);
    sim.alpha(0.3).restart();
  }, [paramSig]);

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
