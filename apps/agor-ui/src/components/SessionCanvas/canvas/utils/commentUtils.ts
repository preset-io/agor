/**
 * Utilities for comment positioning and parent lookups
 *
 * Handles zone and worktree parent information for spatial comments,
 * including labels and colors for UI display.
 */

import type { Board, Worktree } from '@agor/core/types';

export interface ParentInfo {
  parentId?: string;
  parentLabel?: string;
  parentColor?: string;
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
  const zone = board?.objects?.[zoneId];
  return {
    parentId: `zone-${zoneId}`,
    parentLabel: zone?.type === 'zone' ? `📍 ${zone.label}` : undefined,
    parentColor: zone?.type === 'zone' ? zone.color : undefined,
  };
}

/**
 * Get parent info for worktree attachment
 *
 * Looks up worktree data and returns formatted parent information
 * for comment display.
 *
 * @param worktreeId - The worktree ID
 * @param worktrees - Array of all worktrees
 * @returns Parent info with ID and label (no color for worktrees)
 *
 * @example
 * const info = getWorktreeParentInfo('wt_123', worktrees);
 * // { parentId: 'wt_123', parentLabel: '🌳 feature-branch', parentColor: undefined }
 */
export function getWorktreeParentInfo(worktreeId: string, worktrees: Worktree[]): ParentInfo {
  const worktree = worktrees.find(w => w.worktree_id === worktreeId);
  return {
    parentId: worktreeId,
    parentLabel: worktree ? `🌳 ${worktree.name}` : undefined,
    parentColor: undefined, // Worktrees don't have colors (yet)
  };
}
