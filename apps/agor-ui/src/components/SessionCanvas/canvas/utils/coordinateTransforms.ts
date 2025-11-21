/**
 * Coordinate transformation utilities for board objects
 *
 * Handles conversions between absolute (board) and relative (parent) coordinate spaces.
 *
 * Key concepts:
 * - Absolute: Position relative to the board origin (0, 0)
 * - Relative: Position relative to a parent object's origin
 *
 * Hierarchy:
 * - Board (root, absolute space)
 *   - Zone (absolute position on board)
 *   - Worktree (absolute OR relative to zone)
 *   - Pin/Comment (absolute OR relative to zone/worktree)
 */

import type { Node } from 'reactflow';
import { getAbsoluteNodePosition } from './nodePositionUtils';

export interface Position {
  x: number;
  y: number;
}

export interface ParentInfo {
  id: string;
  position: Position;
}

/**
 * Get the absolute position of a React Flow node, handling parentId correctly
 *
 * React Flow provides:
 * - node.position: Could be absolute OR relative depending on parentId
 * - node.positionAbsolute: Pre-calculated absolute (preferred if available)
 *
 * @param node - React Flow node
 * @param allNodes - All nodes (needed for parent lookups)
 * @returns Absolute position on the board
 */
export function getNodeAbsolutePosition(node: Node, allNodes: Node[]): Position {
  // Use React Flow's pre-calculated absolute position if available
  if (node.positionAbsolute) {
    return { x: node.positionAbsolute.x, y: node.positionAbsolute.y };
  }

  // Fall back to manual calculation
  return getAbsoluteNodePosition(node, allNodes);
}

/**
 * Convert absolute position to relative position within a parent
 *
 * @param absolutePos - Position in board coordinates
 * @param parentPos - Parent's position in board coordinates
 * @returns Position relative to parent's origin
 *
 * @example
 * const abs = { x: 500, y: 300 };
 * const parent = { x: 400, y: 200 };
 * const rel = absoluteToRelative(abs, parent);
 * // Returns: { x: 100, y: 100 }
 */
export function absoluteToRelative(absolutePos: Position, parentPos: Position): Position {
  return {
    x: absolutePos.x - parentPos.x,
    y: absolutePos.y - parentPos.y,
  };
}

/**
 * Convert relative position to absolute position
 *
 * @param relativePos - Position relative to parent
 * @param parentPos - Parent's position in board coordinates
 * @returns Position in board coordinates
 *
 * @example
 * const rel = { x: 100, y: 100 };
 * const parent = { x: 400, y: 200 };
 * const abs = relativeToAbsolute(rel, parent);
 * // Returns: { x: 500, y: 300 }
 */
export function relativeToAbsolute(relativePos: Position, parentPos: Position): Position {
  return {
    x: relativePos.x + parentPos.x,
    y: relativePos.y + parentPos.y,
  };
}

/**
 * Convert position from one parent's coordinate space to another's
 *
 * Used when moving objects between containers (e.g., Zone A to Zone B)
 *
 * @param relativePos - Position relative to oldParent
 * @param oldParent - Previous parent's position
 * @param newParent - New parent's position
 * @returns Position relative to newParent
 *
 * @example
 * // Moving worktree from Zone A to Zone B
 * const posInA = { x: 50, y: 50 };
 * const zoneA = { x: 100, y: 100 };
 * const zoneB = { x: 300, y: 200 };
 * const posInB = convertRelativePosition(posInA, zoneA, zoneB);
 * // Returns: { x: -150, y: -50 }
 */
export function convertRelativePosition(
  relativePos: Position,
  oldParent: Position,
  newParent: Position
): Position {
  // Convert to absolute, then to new parent's relative space
  const absolute = relativeToAbsolute(relativePos, oldParent);
  return absoluteToRelative(absolute, newParent);
}

/**
 * Get the absolute position to use for collision detection during drag
 *
 * This is the key function for fixing collision detection bugs.
 * React Flow gives us node.position which could be relative or absolute
 * depending on whether the node has a parent.
 *
 * @param node - The node being dragged (with potentially relative position)
 * @param allNodes - All nodes on the canvas
 * @returns Absolute position for collision detection
 */
export function getDragAbsolutePosition(node: Node, allNodes: Node[]): Position {
  // If node has positionAbsolute, use it (React Flow's pre-calculation)
  if (node.positionAbsolute) {
    return { x: node.positionAbsolute.x, y: node.positionAbsolute.y };
  }

  // If node has parent, position is relative - must convert
  if (node.parentId) {
    const parent = allNodes.find(n => n.id === node.parentId);
    if (parent) {
      const parentAbsPos = getNodeAbsolutePosition(parent, allNodes);
      return relativeToAbsolute(node.position, parentAbsPos);
    }
  }

  // No parent - position is already absolute
  return { x: node.position.x, y: node.position.y };
}

/**
 * Calculate what position to store in the database based on new parent
 *
 * Handles all cases:
 * - Unpinned → Pinned (absolute → relative)
 * - Pinned → Different Parent (relative-to-A → relative-to-B)
 * - Pinned → Unpinned (relative → absolute)
 * - Unpinned → Unpinned (absolute → absolute)
 *
 * @param currentAbsolutePos - Current absolute position on board
 * @param newParent - New parent info (null if dropping on board)
 * @returns Position to store in database
 */
export function calculateStoragePosition(
  currentAbsolutePos: Position,
  newParent: ParentInfo | null
): Position {
  if (newParent) {
    // Has parent - store as relative
    return absoluteToRelative(currentAbsolutePos, newParent.position);
  }

  // No parent - store as absolute
  return currentAbsolutePos;
}

/**
 * Calculate the center point of a node for collision detection
 *
 * @param position - Node position (should be absolute)
 * @param width - Node width
 * @param height - Node height
 * @returns Center point in absolute coordinates
 */
export function getNodeCenter(position: Position, width: number, height: number): Position {
  return {
    x: position.x + width / 2,
    y: position.y + height / 2,
  };
}
