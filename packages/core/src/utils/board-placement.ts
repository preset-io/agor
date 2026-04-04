import type { ZoneBoardObject } from '../types/board.js';

/** Standard worktree card dimensions used for zone placement calculations */
export const WORKTREE_CARD_WIDTH = 500;
export const WORKTREE_CARD_HEIGHT = 200;
const ZONE_DESIRED_PADDING = 80;

/**
 * Calculate a random position within a zone for placing a worktree card.
 * Returns a position relative to the zone origin (not absolute canvas coordinates).
 * Uses adaptive padding and jitter to prevent cards from stacking on top of each other.
 */
export function computeZoneRelativePosition(zone: ZoneBoardObject): { x: number; y: number } {
  const maxPaddingX = Math.max(0, (zone.width - WORKTREE_CARD_WIDTH) / 2);
  const maxPaddingY = Math.max(0, (zone.height - WORKTREE_CARD_HEIGHT) / 2);
  const paddingX = Math.min(ZONE_DESIRED_PADDING, maxPaddingX);
  const paddingY = Math.min(ZONE_DESIRED_PADDING, maxPaddingY);

  const jitterRangeX = Math.max(0, zone.width - WORKTREE_CARD_WIDTH - 2 * paddingX);
  const jitterRangeY = Math.max(0, zone.height - WORKTREE_CARD_HEIGHT - 2 * paddingY);

  if (zone.width < WORKTREE_CARD_WIDTH || zone.height < WORKTREE_CARD_HEIGHT) {
    console.warn(
      `⚠️  Zone is smaller than worktree card (${zone.width}x${zone.height} < ${WORKTREE_CARD_WIDTH}x${WORKTREE_CARD_HEIGHT}), card may overflow zone bounds`
    );
  }

  return {
    x: paddingX + Math.random() * jitterRangeX,
    y: paddingY + Math.random() * jitterRangeY,
  };
}
