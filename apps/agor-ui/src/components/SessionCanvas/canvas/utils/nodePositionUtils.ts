/**
 * Utilities for calculating React Flow node positions
 *
 * Handles absolute position calculation for nodes with parent transforms,
 * including recursive resolution for nested parent-child relationships.
 */

import type { Node } from 'reactflow';

/**
 * Calculate absolute position of a node, handling parent transforms recursively
 *
 * React Flow nodes can have:
 * - positionAbsolute: Pre-calculated absolute position (preferred)
 * - parentId + position: Relative position that needs parent lookup
 * - position only: Already absolute (no parent)
 *
 * This function handles all cases and recursively resolves nested parents.
 *
 * @param node - The React Flow node to calculate position for
 * @param allNodes - All nodes in the canvas (needed for parent lookups)
 * @returns Absolute { x, y } position on the canvas
 *
 * @example
 * // Node with positionAbsolute
 * getAbsoluteNodePosition(zoneNode, nodes) // { x: 100, y: 200 }
 *
 * @example
 * // Worktree inside zone (nested)
 * getAbsoluteNodePosition(worktreeNode, nodes)
 * // Resolves: zone.position + worktree.position = absolute
 */
export function getAbsoluteNodePosition(node: Node, allNodes: Node[]): { x: number; y: number } {
  // Fast path: React Flow already calculated absolute position
  if (node.positionAbsolute) {
    return { x: node.positionAbsolute.x, y: node.positionAbsolute.y };
  }

  // Node has parent - calculate absolute from relative position
  if (node.parentId) {
    const parentNode = allNodes.find(n => n.id === node.parentId);
    if (parentNode) {
      // Recursive: parent might also need resolution
      const parentPos = getAbsoluteNodePosition(parentNode, allNodes);
      return {
        x: parentPos.x + node.position.x,
        y: parentPos.y + node.position.y,
      };
    }
  }

  // No parent or positionAbsolute - position is already absolute
  return { x: node.position.x, y: node.position.y };
}
