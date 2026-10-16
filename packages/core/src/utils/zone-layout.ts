/**
 * Zone layouts: how a zone places the branches and cards pinned to it.
 *
 * `free` zones keep each entity's stored position. `row`, `column` and `grid`
 * zones arrange entities in slots computed on every screen from measured heights;
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

export const ZONE_LAYOUTS: readonly ZoneLayout[] = ['free', 'row', 'column', 'grid'];

/** Board grid step; every computed top and pitch snaps to it. */
export const ZONE_GRID_STEP = 20;
/** Preferred column width: the branch card's own width. */
export const ZONE_GRID_COLUMN_WIDTH = BRANCH_CARD_WIDTH;
/** Columns stretch or shrink within these bounds so cards fill the zone's width. */
export const ZONE_GRID_MIN_COLUMN_WIDTH = 320;
export const ZONE_GRID_MAX_COLUMN_WIDTH = 560;
export const ZONE_GRID_GAP = 20;
export const ZONE_GRID_PADDING = 20;
/** Space kept clear for the zone label and status above the first row. */
export const ZONE_GRID_HEADER = 80;

export type AutoZoneLayout = Exclude<ZoneLayout, 'free'>;

/** The zone's layout, treating missing or unknown values as `free`. */
export function zoneLayoutOf(zone: Pick<ZoneBoardObject, 'layout'> | undefined): ZoneLayout {
  const layout = zone?.layout;
  return layout === 'row' || layout === 'column' || layout === 'grid' ? layout : 'free';
}

export function isAutoZoneLayout(layout: ZoneLayout): layout is AutoZoneLayout {
  return layout !== 'free';
}

const snapUp = (value: number) => Math.ceil(value / ZONE_GRID_STEP) * ZONE_GRID_STEP;

/** Fewest columns a grid shows; a narrower zone widens on screen to fit them. */
export const ZONE_GRID_MIN_COLUMNS = 2;

/** Fewest grid columns that fill this width without any exceeding the maximum. */
function gridColumnsToFill(zoneWidth: number): number {
  const usable = Math.max(0, zoneWidth - 2 * ZONE_GRID_PADDING);
  return Math.ceil((usable + ZONE_GRID_GAP) / (ZONE_GRID_MAX_COLUMN_WIDTH + ZONE_GRID_GAP));
}

export interface ZoneGridColumns {
  count: number;
  /** Width every card in the zone is shown at. */
  width: number;
}

/**
 * The columns an arranged zone shows, sized to fill its width. A row has one
 * per card and a column one; a grid has the fewest that keep each within the
 * maximum width, no more than it has cards, and at least two. Widths stay within the bounds, so a zone
 * too narrow or too wide for them shows wider or narrower than set.
 */
export function zoneGridColumns(
  layout: AutoZoneLayout,
  zoneWidth: number,
  itemCount = 1
): ZoneGridColumns {
  const usable = Math.max(0, zoneWidth - 2 * ZONE_GRID_PADDING);
  const count =
    layout === 'row'
      ? Math.max(1, itemCount)
      : layout === 'column'
        ? 1
        : Math.max(ZONE_GRID_MIN_COLUMNS, Math.min(gridColumnsToFill(zoneWidth), itemCount));
  const fill = Math.floor((usable - (count - 1) * ZONE_GRID_GAP) / count);
  return {
    count,
    width: Math.min(ZONE_GRID_MAX_COLUMN_WIDTH, Math.max(ZONE_GRID_MIN_COLUMN_WIDTH, fill)),
  };
}

/**
 * Width a zone takes when it switches to grid, or undefined to keep its own.
 * A width that would put every card in one row (say, left over from a row)
 * gets roughly square columns instead, so the grid looks like a grid.
 */
export function zoneGridWidthOnSwitch(zoneWidth: number, itemCount: number): number | undefined {
  if (itemCount < 3 || gridColumnsToFill(zoneWidth) < itemCount) return undefined;
  return zoneWidthFor(Math.max(ZONE_GRID_MIN_COLUMNS, Math.ceil(Math.sqrt(itemCount))));
}

/** Zone width that fits these columns, padding included. */
function zoneWidthFor(count: number, width = ZONE_GRID_COLUMN_WIDTH): number {
  return 2 * ZONE_GRID_PADDING + count * width + (count - 1) * ZONE_GRID_GAP;
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
  /** Width every card is shown at. */
  columnWidth: number;
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
  const { count: columnCount, width: columnWidth } = zoneGridColumns(
    layout,
    zoneWidth,
    items.length
  );
  const columnTops = new Array<number>(columnCount).fill(ZONE_GRID_HEADER);
  const positions = new Map<string, BoardPosition>();
  const columns = new Map<string, number>();
  let bottom = ZONE_GRID_HEADER;

  items.forEach((item, index) => {
    const column = index % columnCount;
    const y = columnTops[column];
    positions.set(item.id, {
      x: ZONE_GRID_PADDING + column * (columnWidth + ZONE_GRID_GAP),
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
    contentWidth: zoneWidthFor(columnCount, columnWidth),
    columnWidth,
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
 * fit the zone, each entity in the column nearest its stored x. Every
 * arranged layout reads the same way, so switching keeps the order. It inverts
 * planZoneGrid, and order keys in one column read top to bottom.
 */
export function readZoneGridOrder<T extends ZoneGridOrderItem>(
  zoneWidth: number,
  items: readonly T[]
): T[] {
  const { count: columnCount, width } = zoneGridColumns('grid', zoneWidth, items.length);
  const pitch = width + ZONE_GRID_GAP;
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
 * Stored position for an entity entering a zone: appended last in an
 * arranged zone, a random spot otherwise. Siblings load only for those.
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
