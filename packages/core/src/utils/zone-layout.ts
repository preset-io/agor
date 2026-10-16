/**
 * Zone layouts: how a zone places the branches and cards pinned to it.
 *
 * `free` zones keep each entity's stored position. `grid` and `list` zones
 * place entities in columns computed on every screen from measured heights;
 * those positions are display-only and are never written back. While a zone
 * is auto-laid-out, an entity's stored zone-relative position only serves as
 * its order key, so the planner here is pure and shared by the UI and daemon.
 */
import type { BoardPosition, ZoneBoardObject, ZoneLayout } from '../types/board.js';
import {
  BRANCH_CARD_HEIGHT,
  BRANCH_CARD_WIDTH,
  computeZoneRelativePosition,
} from './board-placement.js';

export const ZONE_LAYOUTS: readonly ZoneLayout[] = ['free', 'grid', 'list'];

/** Board grid step; every computed top and pitch snaps to it. */
export const ZONE_GRID_STEP = 20;
/** Column width: the branch card width, so narrower cards also fit. */
export const ZONE_GRID_COLUMN_WIDTH = BRANCH_CARD_WIDTH;
export const ZONE_GRID_GAP = 20;
export const ZONE_GRID_PADDING = 20;
/** Space kept clear for the zone label and status above the first row. */
export const ZONE_GRID_HEADER = 80;

export type AutoZoneLayout = Exclude<ZoneLayout, 'free'>;

/** The zone's layout, treating missing or unknown values as `free`. */
export function zoneLayoutOf(zone: Pick<ZoneBoardObject, 'layout'> | undefined): ZoneLayout {
  const layout = zone?.layout;
  return layout === 'grid' || layout === 'list' ? layout : 'free';
}

export function isAutoZoneLayout(layout: ZoneLayout): layout is AutoZoneLayout {
  return layout !== 'free';
}

const snapUp = (value: number) => Math.ceil(value / ZONE_GRID_STEP) * ZONE_GRID_STEP;

/** Fewest columns a grid shows; a narrower zone widens on screen to fit them. */
export const ZONE_GRID_MIN_COLUMNS = 2;

/** Columns a zone of this width fits (at least two for a grid); a list always has one. */
export function zoneGridColumnCount(layout: AutoZoneLayout, zoneWidth: number): number {
  if (layout === 'list') return 1;
  const usable = zoneWidth - 2 * ZONE_GRID_PADDING + ZONE_GRID_GAP;
  return Math.max(
    ZONE_GRID_MIN_COLUMNS,
    Math.floor(usable / (ZONE_GRID_COLUMN_WIDTH + ZONE_GRID_GAP))
  );
}

/** Zone width that fits this many columns, padding included. */
function zoneWidthFor(columnCount: number): number {
  return (
    2 * ZONE_GRID_PADDING + columnCount * ZONE_GRID_COLUMN_WIDTH + (columnCount - 1) * ZONE_GRID_GAP
  );
}

export interface ZoneGridOrderItem {
  id: string;
  /** Stored zone-relative position, used only as the order key. */
  position: BoardPosition;
}

export interface ZoneGridPlanItem {
  id: string;
  /** Measured rendered height; callers estimate it until the node is measured. */
  height: number;
}

export interface ZoneGridPlan {
  /** Zone-relative top-left of each item, keyed by id. */
  positions: Map<string, BoardPosition>;
  /** Column of each item, keyed by id. */
  columns: Map<string, number>;
  /** Zone height that fits every item, header and bottom padding included. */
  contentHeight: number;
  /** Zone width that fits every column, padding included. */
  contentWidth: number;
}

/**
 * Place already-ordered items. Item n always goes in column n mod columns and
 * stacks under the item above it, so a height change only moves the items
 * below it in the same column and never moves an item to another column.
 */
export function planZoneGrid(
  layout: AutoZoneLayout,
  zoneWidth: number,
  items: readonly ZoneGridPlanItem[]
): ZoneGridPlan {
  const columnCount = zoneGridColumnCount(layout, zoneWidth);
  const columnTops = new Array<number>(columnCount).fill(ZONE_GRID_HEADER);
  const positions = new Map<string, BoardPosition>();
  const columns = new Map<string, number>();
  let bottom = ZONE_GRID_HEADER;

  items.forEach((item, index) => {
    const column = index % columnCount;
    const y = columnTops[column];
    positions.set(item.id, {
      x: ZONE_GRID_PADDING + column * (ZONE_GRID_COLUMN_WIDTH + ZONE_GRID_GAP),
      y,
    });
    columns.set(item.id, column);
    const height = Number.isFinite(item.height) && item.height > 0 ? item.height : 0;
    columnTops[column] = snapUp(y + height + ZONE_GRID_GAP);
    bottom = Math.max(bottom, y + height);
  });

  return {
    positions,
    columns,
    contentHeight: snapUp(bottom + ZONE_GRID_PADDING),
    contentWidth: zoneWidthFor(columnCount),
  };
}

/** Spacing of stored order keys: readable as a single column if a zone turns free unsaved. */
const ORDER_KEY_STEP = BRANCH_CARD_HEIGHT + ZONE_GRID_GAP;

/**
 * Stored position for an entity entering an auto-laid-out zone: below every
 * sibling's order key, so it appears last.
 */
export function zoneGridEntryPosition(siblingPositions: readonly BoardPosition[]): BoardPosition {
  const lowest = siblingPositions.reduce<number | null>(
    (max, position) => (max === null || position.y > max ? position.y : max),
    null
  );
  return {
    x: ZONE_GRID_PADDING,
    y:
      lowest === null
        ? ZONE_GRID_HEADER
        : snapUp(Math.max(lowest, ZONE_GRID_HEADER) + ORDER_KEY_STEP),
  };
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Reading order of a zone's entities: row by row across the grid columns that
 * fit the zone, each entity in the column nearest its stored x. Grid and list
 * read the same way, so switching between them keeps the order. It inverts
 * planZoneGrid, and order keys in one column read top to bottom.
 */
export function readZoneGridOrder<T extends ZoneGridOrderItem>(
  zoneWidth: number,
  items: readonly T[]
): T[] {
  const columnCount = zoneGridColumnCount('grid', zoneWidth);
  const pitch = ZONE_GRID_COLUMN_WIDTH + ZONE_GRID_GAP;
  const columns = new Map<number, T[]>();
  for (const item of items) {
    const raw = Math.round((item.position.x - ZONE_GRID_PADDING) / pitch);
    const column = Math.min(columnCount - 1, Math.max(0, raw));
    columns.set(column, [...(columns.get(column) ?? []), item]);
  }
  const keyed: Array<{ item: T; column: number; rank: number }> = [];
  for (const [column, members] of columns) {
    members
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || byId(a, b))
      .forEach((item, rank) => {
        keyed.push({ item, column, rank });
      });
  }
  return keyed
    .sort((a, b) => a.rank - b.rank || a.column - b.column || byId(a.item, b.item))
    .map(({ item }) => item);
}

/** Stored order keys for entities in this order: one column, top to bottom. */
export function zoneGridOrderKeys(orderedIds: readonly string[]): Map<string, BoardPosition> {
  return new Map(
    orderedIds.map((id, index) => [
      id,
      { x: ZONE_GRID_PADDING, y: ZONE_GRID_HEADER + index * ORDER_KEY_STEP },
    ])
  );
}

/**
 * Stored position for an entity entering a zone: appended last in a grid or
 * list zone, a random spot otherwise. Siblings load only for auto zones.
 */
export async function computeZoneEntryPosition(
  zone: Pick<ZoneBoardObject, 'width' | 'height' | 'layout'>,
  loadSiblingPositions: () => Promise<BoardPosition[]>,
  options?: Parameters<typeof computeZoneRelativePosition>[1]
): Promise<BoardPosition> {
  if (!isAutoZoneLayout(zoneLayoutOf(zone))) return computeZoneRelativePosition(zone, options);
  return zoneGridEntryPosition(await loadSiblingPositions());
}

/**
 * Where a card dropped inside an auto zone goes: the index among the other
 * cards whose planned slot for it lies nearest the drop point.
 */
export function zoneGridDropIndex(
  layout: AutoZoneLayout,
  zoneWidth: number,
  others: readonly ZoneGridPlanItem[],
  dragged: ZoneGridPlanItem,
  drop: BoardPosition
): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= others.length; index++) {
    const order = [...others.slice(0, index), dragged, ...others.slice(index)];
    const slot = planZoneGrid(layout, zoneWidth, order).positions.get(dragged.id);
    if (!slot) continue;
    const distance = Math.hypot(slot.x - drop.x, slot.y - drop.y);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * An order key between two neighbours' keys, or undefined when they leave no
 * room or aren't one-column keys (the caller then rewrites every key).
 */
export function zoneGridOrderKeyBetween(
  before: BoardPosition | undefined,
  after: BoardPosition | undefined
): BoardPosition | undefined {
  if ((before && before.x !== ZONE_GRID_PADDING) || (after && after.x !== ZONE_GRID_PADDING)) {
    return undefined;
  }
  if (!before && !after) return { x: ZONE_GRID_PADDING, y: ZONE_GRID_HEADER };
  if (!before && after) return { x: ZONE_GRID_PADDING, y: after.y - ORDER_KEY_STEP };
  if (before && !after) return { x: ZONE_GRID_PADDING, y: before.y + ORDER_KEY_STEP };
  if (before && after && after.y - before.y >= 2) {
    return { x: ZONE_GRID_PADDING, y: Math.floor((before.y + after.y) / 2) };
  }
  return undefined;
}
