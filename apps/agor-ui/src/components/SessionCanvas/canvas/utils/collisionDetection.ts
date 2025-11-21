/**
 * Utilities for detecting node collisions on canvas
 *
 * Provides point-in-rect collision detection for zones and worktrees,
 * using measured DOM dimensions and absolute positions.
 */

import type { BoardObject } from '@agor/core/types';
import type { Node } from 'reactflow';
import { getNodeAbsolutePosition, getNodeCenter, type Position } from './coordinateTransforms';
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
  const intersectingNodes = allNodes.filter(node => {
    if (node.type !== 'zone' && node.type !== 'worktreeNode') return false;

    // Use measured dimensions (React Flow calculates from DOM)
    // Fall back to width/height props if not yet measured
    const rfNode = node as ReactFlowNode;
    const nodeWidth =
      rfNode.measured?.width ||
      node.width ||
      (typeof node.style?.width === 'number' ? node.style.width : 0);
    const nodeHeight =
      rfNode.measured?.height ||
      node.height ||
      (typeof node.style?.height === 'number' ? node.style.height : 0);

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
    worktreeNode: intersectingNodes.find(n => n.type === 'worktreeNode'),
    zoneNode: intersectingNodes.find(n => n.type === 'zone'),
  };
}

/**
 * Zone collision result with metadata
 */
export interface ZoneCollision {
  zoneId: string;
  zoneData: BoardObject & { type: 'zone' };
}

/**
 * Find zone that a node's center intersects with
 *
 * Uses the node's CENTER POINT in ABSOLUTE coordinates for collision detection.
 * This correctly handles nodes that are pinned to parents (with relative positions).
 *
 * @param node - The node being dragged (position could be relative or absolute)
 * @param allNodes - All nodes on the canvas (needed for parent resolution)
 * @param boardObjects - Board objects map (zones)
 * @param nodeWidth - Node width for center calculation (default 400)
 * @param nodeHeight - Node height for center calculation (default 200)
 * @returns Zone collision info, or null if not intersecting any zone
 *
 * @example
 * // Correct usage in drag handler
 * const zoneCollision = findZoneForNode(draggedNode, allNodes, board.objects);
 * if (zoneCollision) {
 *   console.log('Dropped on zone:', zoneCollision.zoneData.label);
 * }
 */
export function findZoneForNode(
  node: Node,
  allNodes: Node[],
  boardObjects: Record<string, BoardObject> | undefined,
  nodeWidth = 400,
  nodeHeight = 200
): ZoneCollision | null {
  if (!boardObjects) return null;

  // Get absolute position (handles relative positions correctly)
  const absolutePos = getNodeAbsolutePosition(node, allNodes);

  // Calculate center point for collision detection
  const center = getNodeCenter(absolutePos, nodeWidth, nodeHeight);

  // Check each zone
  for (const [zoneId, zoneData] of Object.entries(boardObjects)) {
    if (zoneData.type !== 'zone') continue;

    // Check if center is within zone bounds
    const isInZone =
      center.x >= zoneData.x &&
      center.x <= zoneData.x + zoneData.width &&
      center.y >= zoneData.y &&
      center.y <= zoneData.y + zoneData.height;

    if (isInZone) {
      return {
        zoneId,
        zoneData: zoneData as BoardObject & { type: 'zone' },
      };
    }
  }

  return null;
}

/**
 * Find zone at an absolute position (point-based collision)
 *
 * @param absolutePosition - Position in board coordinates
 * @param boardObjects - Board objects map (zones)
 * @returns Zone collision info, or null if not intersecting any zone
 */
export function findZoneAtPosition(
  absolutePosition: Position,
  boardObjects: Record<string, BoardObject> | undefined
): ZoneCollision | null {
  if (!boardObjects) return null;

  for (const [zoneId, zoneData] of Object.entries(boardObjects)) {
    if (zoneData.type !== 'zone') continue;

    const isInZone =
      absolutePosition.x >= zoneData.x &&
      absolutePosition.x <= zoneData.x + zoneData.width &&
      absolutePosition.y >= zoneData.y &&
      absolutePosition.y <= zoneData.y + zoneData.height;

    if (isInZone) {
      return {
        zoneId,
        zoneData: zoneData as BoardObject & { type: 'zone' },
      };
    }
  }

  return null;
}
