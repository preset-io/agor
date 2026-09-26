/**
 * Utilities for comment positioning and parent lookups
 *
 * Handles zone and branch parent information for spatial comments,
 * including labels and colors for UI display.
 */

import {
  type Board,
  type BoardComment,
  type BoardCommentReposition,
  type Branch,
  boardCommentZoneParentObjectKey,
  hasMinimumRole,
  ROLES,
  type User,
} from '@agor-live/client';

export interface ParentInfo {
  parentId?: string;
  parentLabel?: string;
  parentColor?: string;
}

export interface CommentSpatialParent {
  id: string;
  type: 'zone' | 'branch';
  absolutePosition: { x: number; y: number };
  reactFlowParentId: string;
}

export interface BoardCommentRepositionPlan {
  data: BoardCommentReposition;
  reactFlowParentId?: string;
}

/** Mirror the route's author-or-admin gate for spatial comment movement. */
export function canRepositionBoardComment(
  comment: BoardComment,
  user: User | null | undefined
): boolean {
  return Boolean(
    user && (comment.created_by === user.user_id || hasMinimumRole(user.role, ROLES.ADMIN))
  );
}

/**
 * Build the exact persistence request for a comment drag. The comment's branch
 * attachment is an immutable audience anchor, distinct from its visual parent.
 * A drop on another branch therefore remains absolute instead of attempting a
 * forbidden reattachment; zones and free space may still be used visually.
 */
export function planBoardCommentReposition(
  comment: BoardComment,
  absolutePosition: { x: number; y: number },
  spatialParent?: CommentSpatialParent
): BoardCommentRepositionPlan {
  const data: BoardCommentReposition = {
    branch_id: comment.branch_id ?? null,
    position: { absolute: absolutePosition },
  };

  const canUseParent =
    spatialParent?.type === 'zone' ||
    (spatialParent?.type === 'branch' && comment.branch_id === spatialParent.id);
  if (!spatialParent || !canUseParent) return { data };

  data.position = {
    relative: {
      parent_id: spatialParent.id,
      parent_type: spatialParent.type,
      offset_x: absolutePosition.x - spatialParent.absolutePosition.x,
      offset_y: absolutePosition.y - spatialParent.absolutePosition.y,
    },
  };
  return { data, reactFlowParentId: spatialParent.reactFlowParentId };
}

/**
 * Get parent info for zone attachment
 *
 * Looks up zone data from board objects and returns formatted
 * parent information for comment display.
 *
 * @param zoneId - The zone ID (without 'zone-' prefix)
 * @param board - Current board with objects dictionary
 * @returns Parent info with ID, label, and color
 *
 * @example
 * const info = getZoneParentInfo('zone_123', board);
 * // { parentId: 'zone-zone_123', parentLabel: '📍 My Zone', parentColor: '#ff0000' }
 */
export function getZoneParentInfo(zoneId: string, board?: Board): ParentInfo {
  const parentId = boardCommentZoneParentObjectKey(zoneId);
  const zone = board?.objects?.[parentId];
  return {
    parentId,
    parentLabel: zone?.type === 'zone' ? `📍 ${zone.label}` : undefined,
    parentColor: zone?.type === 'zone' ? zone.color : undefined,
  };
}

/**
 * Get parent info for branch attachment
 *
 * Looks up branch data and returns formatted parent information
 * for comment display.
 *
 * @param branchId - The branch ID
 * @param branches - Array of all branches
 * @returns Parent info with ID and label (no color for branches)
 *
 * @example
 * const info = getBranchParentInfo('wt_123', branches);
 * // { parentId: 'wt_123', parentLabel: '🌳 feature-branch', parentColor: undefined }
 */
export function getBranchParentInfo(branchId: string, branches: Branch[]): ParentInfo {
  const branch = branches.find((w) => w.branch_id === branchId);
  return {
    parentId: branchId,
    parentLabel: branch ? `🌳 ${branch.name}` : undefined,
    parentColor: undefined, // Branches don't have colors (yet)
  };
}
