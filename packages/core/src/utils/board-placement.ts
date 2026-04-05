import type { BoardPosition, ZoneBoardObject } from '../types/board.js';

/** Standard worktree card dimensions used for zone placement calculations */
export const WORKTREE_CARD_WIDTH = 500;
export const WORKTREE_CARD_HEIGHT = 200;
const ZONE_DESIRED_PADDING = 80;

/** @deprecated Use BoardPosition from types/board instead */
export type Position = BoardPosition;

/**
 * Convert a zone-relative position to absolute canvas coordinates.
 * Used when entities are pinned to a zone and need their true board position.
 */
export function toAbsolutePosition(relativePos: Position, zoneOrigin: Position): Position {
  return {
    x: relativePos.x + zoneOrigin.x,
    y: relativePos.y + zoneOrigin.y,
  };
}

/**
 * Compute the median of a numeric array (sorted in place).
 */
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * Compute the center of the bounding box enclosing all zones.
 * Returns undefined if zones is empty.
 */
export function getZoneBoundingBoxCenter(
  zones: readonly Pick<ZoneBoardObject, 'x' | 'y' | 'width' | 'height'>[]
): Position | undefined {
  if (zones.length === 0) return undefined;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const z of zones) {
    minX = Math.min(minX, z.x);
    minY = Math.min(minY, z.y);
    maxX = Math.max(maxX, z.x + z.width);
    maxY = Math.max(maxY, z.y + z.height);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

interface ZoneMapEntry extends Pick<ZoneBoardObject, 'x' | 'y' | 'width' | 'height'> {
  id: string;
}

/**
 * Resolve absolute canvas positions for a set of board entities.
 * Zone-pinned entities have their positions converted from zone-relative to absolute.
 *
 * All inputs must come from the same board — this function does not validate board_id
 * consistency, the caller is responsible for passing board-scoped data.
 */
export function resolveEntityAbsolutePositions(
  entities: readonly { position: Position; zone_id?: string }[],
  zones: readonly ZoneMapEntry[]
): Position[] {
  const zoneMap = new Map(zones.map((z) => [z.id, z]));
  return entities.map((entity) => {
    if (entity.zone_id) {
      const zone = zoneMap.get(entity.zone_id);
      if (zone) return toAbsolutePosition(entity.position, zone);
    }
    return entity.position;
  });
}

/**
 * Compute a default board position for a new entity based on existing positions
 * and zones from a single board.
 *
 * Strategy 1: Median of existing positions + jitter (robust to outliers).
 * Strategy 2: Center of zone bounding box + jitter (when no entities exist).
 * Strategy 3: Near origin (when no zones either).
 *
 * All inputs must come from the same board — this function does not validate board_id
 * consistency, the caller is responsible for passing board-scoped data.
 */
export function computeDefaultBoardPosition(
  absolutePositions: Position[],
  zones: readonly Pick<ZoneBoardObject, 'x' | 'y' | 'width' | 'height'>[]
): Position {
  // Strategy 1: median of existing entity positions
  if (absolutePositions.length > 0) {
    const medianX = median(absolutePositions.map((p) => p.x));
    const medianY = median(absolutePositions.map((p) => p.y));
    return {
      x: medianX + (Math.random() - 0.5) * 200,
      y: medianY + (Math.random() - 0.5) * 200,
    };
  }

  // Strategy 2: center of zone bounding box
  const center = getZoneBoundingBoxCenter(zones);
  if (center) {
    return {
      x: center.x + (Math.random() - 0.5) * 100,
      y: center.y + (Math.random() - 0.5) * 100,
    };
  }

  // Strategy 3: near origin
  return { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 };
}

/** Standard card dimensions used for zone placement calculations */
export const CARD_WIDTH = 400;
export const CARD_HEIGHT = 150;

/**
 * Calculate a random position within a zone for placing an entity.
 * Returns a position relative to the zone origin (not absolute canvas coordinates).
 * Uses adaptive padding and jitter to prevent entities from stacking on top of each other.
 *
 * Defaults to worktree card dimensions. Pass entityWidth/entityHeight/desiredPadding
 * to use for other entity types (e.g. cards).
 */
export function computeZoneRelativePosition(
  zone: Pick<ZoneBoardObject, 'width' | 'height'>,
  options?: { entityWidth?: number; entityHeight?: number; desiredPadding?: number }
): BoardPosition {
  const entityWidth = options?.entityWidth ?? WORKTREE_CARD_WIDTH;
  const entityHeight = options?.entityHeight ?? WORKTREE_CARD_HEIGHT;
  const desiredPadding = options?.desiredPadding ?? ZONE_DESIRED_PADDING;

  const maxPaddingX = Math.max(0, (zone.width - entityWidth) / 2);
  const maxPaddingY = Math.max(0, (zone.height - entityHeight) / 2);
  const paddingX = Math.min(desiredPadding, maxPaddingX);
  const paddingY = Math.min(desiredPadding, maxPaddingY);

  const jitterRangeX = Math.max(0, zone.width - entityWidth - 2 * paddingX);
  const jitterRangeY = Math.max(0, zone.height - entityHeight - 2 * paddingY);

  if (zone.width < entityWidth || zone.height < entityHeight) {
    console.warn(
      `⚠️  Zone is smaller than entity (${zone.width}x${zone.height} < ${entityWidth}x${entityHeight}), entity may overflow zone bounds`
    );
  }

  return {
    x: paddingX + Math.random() * jitterRangeX,
    y: paddingY + Math.random() * jitterRangeY,
  };
}
