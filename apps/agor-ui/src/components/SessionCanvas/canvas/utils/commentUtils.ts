/**
 * Utilities for comment positioning and parent lookups
 *
 * Handles zone and branch parent information for spatial comments,
 * including labels and colors for UI display.
 */

import type { Board, Branch } from '@agor-live/client';

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
