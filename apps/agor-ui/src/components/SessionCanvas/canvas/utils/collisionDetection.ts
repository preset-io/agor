/**
 * Utilities for detecting node collisions on canvas
 *
 * Provides point-in-rect collision detection for zones and branches,
 * using measured DOM dimensions and absolute positions.
 */

import type { BoardObject } from '@agor-live/client';
import type { Node } from 'reactflow';
import { DEFAULT_BOARD_OBJECT_Z_INDEX, sanitizeZIndex } from '../zOrder';
import { getNodeAbsolutePosition, getNodeCenter, type Position } from './coordinateTransforms';
import { getAbsoluteNodePosition } from './nodePositionUtils';
import type { ReactFlowNode } from './reactFlowTypes';

export interface CollisionResult {
  branchNode?: Node;
  zoneNode?: Node;
}

/** Pick the visually topmost node. Later nodes win equal-z ties, matching DOM paint order. */
function topmostNode(nodes: Node[]): Node | undefined {
  return nodes.reduce<Node | undefined>((top, node) => {
    if (!top) return node;
    const topZ = typeof top.zIndex === 'number' ? top.zIndex : 0;
    const nodeZ = typeof node.zIndex === 'number' ? node.zIndex : 0;
    return nodeZ >= topZ ? node : top;
  }, undefined);
}

/**
 * Find zones/branches that a point intersects with
 *
 * Uses manual point-in-rect collision detection because React Flow's
 * getIntersectingNodes() doesn't work well with dynamically sized nodes.
 *
 * Priority: branch > zone (branches render on top of zones)
 *
 * @param point - Canvas coordinates to test
 * @param allNodes - All nodes in the canvas
 * @returns Object with branchNode and/or zoneNode if intersecting
 *
 * @example
 * const result = findIntersectingObjects({ x: 100, y: 200 }, nodes);
 * if (result.branchNode) {
 *   console.log('Dropped on branch!');
 * } else if (result.zoneNode) {
 *   console.log('Dropped on zone!');
 * }
 */
export function findIntersectingObjects(
  point: { x: number; y: number },
  allNodes: Node[]
): CollisionResult {
  // Find all zones/branches that contain the point
  const intersectingNodes = allNodes.filter((node) => {
    if (node.type !== 'zone' && node.type !== 'branchNode') return false;

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

  // Priority: branch > zone (branches are rendered on top)
  return {
    branchNode: topmostNode(intersectingNodes.filter((node) => node.type === 'branchNode')),
    zoneNode: topmostNode(intersectingNodes.filter((node) => node.type === 'zone')),
  };
}

/**
 * Zone collision result with metadata
 */
export interface ZoneCollision {
  zoneId: string;
  zoneData: BoardObject & { type: 'zone' };
}

function topmostZoneAtPoint(
  point: Position,
  boardObjects: Record<string, BoardObject>
): ZoneCollision | null {
  let result: ZoneCollision | null = null;
  let resultZ = Number.NEGATIVE_INFINITY;

  // Later entries win equal-z ties, matching the order used to build React
  // Flow nodes. This keeps the visible top zone and the drop target aligned.
  for (const [zoneId, zoneData] of Object.entries(boardObjects)) {
    if (zoneData.type !== 'zone') continue;
    const isInZone =
      point.x >= zoneData.x &&
      point.x <= zoneData.x + zoneData.width &&
      point.y >= zoneData.y &&
      point.y <= zoneData.y + zoneData.height;
    if (!isInZone) continue;

    const zIndex = sanitizeZIndex(zoneData.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.zone);
    if (zIndex >= resultZ) {
      result = { zoneId, zoneData };
      resultZ = zIndex;
    }
  }

  return result;
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

  return topmostZoneAtPoint(center, boardObjects);
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

  return topmostZoneAtPoint(absolutePosition, boardObjects);
}
