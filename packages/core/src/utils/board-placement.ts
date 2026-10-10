import { ceilBoardGridValue } from '../layout/rectangle-packing.js';
import { growZoneLayoutHeight } from '../layout/zone-layout.js';
import type { BoardPosition, ZoneBoardObject, ZoneResizeMode } from '../types/board.js';

/** Standard branch card dimensions used for zone placement calculations */
export const BRANCH_CARD_WIDTH = 500;
export const BRANCH_CARD_HEIGHT = 200;
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
 * Defaults to branch card dimensions. Pass entityWidth/entityHeight/desiredPadding
 * to use for other entity types (e.g. cards).
 */
export function computeZoneRelativePosition(
  zone: Pick<ZoneBoardObject, 'width' | 'height'>,
  options?: { entityWidth?: number; entityHeight?: number; desiredPadding?: number }
): BoardPosition {
  const entityWidth = options?.entityWidth ?? BRANCH_CARD_WIDTH;
  const entityHeight = options?.entityHeight ?? BRANCH_CARD_HEIGHT;
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

export interface ZoneOccupantRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlapsAnyOccupant(
  candidate: ZoneOccupantRectangle,
  occupants: readonly ZoneOccupantRectangle[]
): boolean {
  return occupants.some(
    (occupant) =>
      candidate.x < occupant.x + occupant.width &&
      occupant.x < candidate.x + candidate.width &&
      candidate.y < occupant.y + occupant.height &&
      occupant.y < candidate.y + candidate.height
  );
}

/** Shared frame/spacing options for zone slot allocation. */
export interface ZoneSlotOptions {
  entityWidth?: number;
  entityHeight?: number;
  padding?: number;
  /** Scalar spacing fallback for {@link gapX} and {@link gapY}. */
  gap?: number;
  gapX?: number;
  gapY?: number;
  titleInset?: number;
}

function resolveZoneSlotOptions(options: ZoneSlotOptions | undefined) {
  const gap = Math.max(0, options?.gap ?? 24);
  const padding = Math.max(0, options?.padding ?? 24);
  return {
    entityWidth: options?.entityWidth ?? BRANCH_CARD_WIDTH,
    entityHeight: options?.entityHeight ?? BRANCH_CARD_HEIGHT,
    padding,
    gapX: Math.max(0, options?.gapX ?? gap),
    gapY: Math.max(0, options?.gapY ?? gap),
    top: padding + Math.max(0, options?.titleInset ?? 0),
  };
}

/**
 * Find a zone-relative position for a new entity that does not land on the
 * zone's current occupants.
 *
 * {@link computeZoneRelativePosition} places by random jitter, which is fine
 * for an empty zone and wrong for a populated one: dropping a 500x200 worktree
 * into a zone of cards puts it on top of them, and the caller has no way to ask
 * for anything better. This scans candidate origins row-major and returns the
 * first free one. Candidates are the item-sized lattice from the padded top
 * inset plus the edges just past every occupant: occupants arranged with the
 * zone's own padding/gaps/title reserve sit off that lattice, and a lattice-only
 * scan then misses the obvious free band beside or below them.
 *
 * When nothing inside the zone is free the entity is parked directly below the
 * lowest occupant. That can exceed the zone's current height, which is both
 * visible and fixable (resize the zone, or arrange it with autoResizeHeight) —
 * unlike a silent overlap, which reads as data loss. Callers requiring a zone
 * pin to imply containment must use `overflow: 'reject'` instead; that path
 * never returns an out-of-frame slot, including for an empty undersized zone.
 */
export function findFreeZoneSlot(
  zone: Pick<ZoneBoardObject, 'width' | 'height'>,
  occupants: readonly ZoneOccupantRectangle[],
  options?: ZoneSlotOptions & {
    /** Reject instead of parking outside the frame when no contained slot fits. */
    overflow?: 'below' | 'reject';
  }
): BoardPosition {
  const { entityWidth, entityHeight, padding, gapX, gapY, top } = resolveZoneSlotOptions(options);

  const requireContainment = options?.overflow === 'reject';
  const fitsFrame =
    padding + entityWidth <= zone.width - padding && top + entityHeight <= zone.height - padding;
  if (requireContainment && !fitsFrame) {
    throw new Error('Zone is too small for this entity; resize the zone before placing it');
  }
  if (occupants.length === 0) return { x: padding, y: top };

  const maxX = Math.max(padding, zone.width - padding - entityWidth);
  const maxY = Math.max(top, zone.height - padding - entityHeight);
  const axisCandidates = (
    start: number,
    max: number,
    step: number,
    edges: readonly number[]
  ): number[] => {
    const values = new Set<number>();
    for (let value = start; value <= max; value += step) values.add(value);
    for (const edge of edges) if (edge >= start && edge <= max) values.add(edge);
    return [...values].sort((a, b) => a - b);
  };
  const xs = axisCandidates(
    padding,
    maxX,
    entityWidth + gapX,
    occupants.map((occupant) => occupant.x + occupant.width + gapX)
  );
  const ys = axisCandidates(
    top,
    maxY,
    entityHeight + gapY,
    occupants.map((occupant) => occupant.y + occupant.height + gapY)
  );

  for (const y of ys) {
    for (const x of xs) {
      const candidate = { x, y, width: entityWidth, height: entityHeight };
      if (!overlapsAnyOccupant(candidate, occupants)) return { x, y };
    }
  }

  if (requireContainment) {
    throw new Error('No free slot inside this zone; resize or arrange its contents before placing');
  }
  const lowestOccupiedEdge = Math.max(...occupants.map((occupant) => occupant.y + occupant.height));
  return { x: padding, y: lowestOccupiedEdge + gapY };
}

export interface ZoneSlotPlan {
  /** Zone-relative origin for the new entity. */
  position: BoardPosition;
  /** Zone size required to contain it; equals the input size unless `grew`. */
  width: number;
  height: number;
  grew: boolean;
}

/**
 * Plan a contained zone slot, growing the zone when its resize policy allows.
 *
 * A zone whose policy lets it resize (`height`/`both`) should absorb a new
 * pin rather than refuse it — refusing is what left callers with an unpinned
 * branch parked beside the zone. A `fixed` zone still rejects, and `height`
 * cannot rescue an entity wider than the frame. Growth is grow-only and
 * grid-aligned, matching the zone arrange's auto-resize contract.
 */
export function planZoneSlot(
  zone: Pick<ZoneBoardObject, 'width' | 'height'>,
  occupants: readonly ZoneOccupantRectangle[],
  options?: ZoneSlotOptions & { resize?: ZoneResizeMode }
): ZoneSlotPlan {
  const resize = options?.resize ?? 'fixed';
  try {
    const position = findFreeZoneSlot(zone, occupants, { ...options, overflow: 'reject' });
    return { position, width: zone.width, height: zone.height, grew: false };
  } catch (error) {
    if (resize === 'fixed') throw error;
  }

  const { entityWidth, entityHeight, padding, gapY, top } = resolveZoneSlotOptions(options);
  const width =
    resize === 'both'
      ? Math.max(zone.width, ceilBoardGridValue(padding * 2 + entityWidth))
      : zone.width;
  if (padding + entityWidth > width - padding) {
    throw new Error(
      'Zone is too narrow for this entity and its resize policy only grows height; widen the zone before placing it'
    );
  }
  // Below every occupant is always free, so a frame tall enough to hold that
  // slot guarantees the scan succeeds; it may still find an earlier gap.
  const lowestOccupiedEdge = Math.max(
    top - gapY,
    ...occupants.map((occupant) => occupant.y + occupant.height)
  );
  const searchHeight = Math.max(zone.height, lowestOccupiedEdge + gapY + entityHeight + padding);
  const position = findFreeZoneSlot({ width, height: searchHeight }, occupants, {
    ...options,
    overflow: 'reject',
  });
  const height = growZoneLayoutHeight(zone.height, position.y + entityHeight + padding);
  return {
    position,
    width,
    height,
    grew: width !== zone.width || height !== zone.height,
  };
}
