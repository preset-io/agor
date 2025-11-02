/**
 * Utilities for detecting node collisions on canvas
 *
 * Provides point-in-rect collision detection for zones and worktrees,
 * using measured DOM dimensions and absolute positions.
 */

import type { Node } from 'reactflow';
import { getAbsoluteNodePosition } from './nodePositionUtils';
import type { ReactFlowNode } from './reactFlowTypes';

export interface CollisionResult {
  worktreeNode?: Node;
  zoneNode?: Node;
}

/**
 * Find zones/worktrees that a point intersects with
 *
 * Uses manual point-in-rect collision detection because React Flow's
 * getIntersectingNodes() doesn't work well with dynamically sized nodes.
 *
 * Priority: worktree > zone (worktrees render on top of zones)
 *
 * @param point - Canvas coordinates to test
 * @param allNodes - All nodes in the canvas
 * @returns Object with worktreeNode and/or zoneNode if intersecting
 *
 * @example
 * const result = findIntersectingObjects({ x: 100, y: 200 }, nodes);
 * if (result.worktreeNode) {
 *   console.log('Dropped on worktree!');
 * } else if (result.zoneNode) {
 *   console.log('Dropped on zone!');
 * }
 */
export function findIntersectingObjects(
  point: { x: number; y: number },
  allNodes: Node[]
): CollisionResult {
  // Find all zones/worktrees that contain the point
  const intersectingNodes = allNodes.filter((node) => {
    if (node.type !== 'zone' && node.type !== 'worktreeNode') return false;

    // Use measured dimensions (React Flow calculates from DOM)
    // Fall back to width/height props if not yet measured
    const rfNode = node as ReactFlowNode;
    const nodeWidth = rfNode.measured?.width || node.width || 0;
    const nodeHeight = rfNode.measured?.height || node.height || 0;

    // Get absolute position (accounting for parent transforms)
    const { x: nodeX, y: nodeY } = getAbsoluteNodePosition(node, allNodes);

    // Point-in-rect collision check
    return (
      point.x >= nodeX &&
      point.x <= nodeX + nodeWidth &&
      point.y >= nodeY &&
      point.y <= nodeY + nodeHeight
    );
  });

  // Priority: worktree > zone (worktrees are rendered on top)
  return {
    worktreeNode: intersectingNodes.find((n) => n.type === 'worktreeNode'),
    zoneNode: intersectingNodes.find((n) => n.type === 'zone'),
  };
}
