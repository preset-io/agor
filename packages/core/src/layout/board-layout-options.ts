import type {
  BoardLayoutContext,
  BoardLayoutLastRow,
  BoardLayoutSettings,
  BoardLayoutTrackAxis,
  LayoutDensityPolicy,
} from '../types/board.js';
import type { BoardZoneArrangementOptions } from './board-zone-arrangement.js';
import {
  LAYOUT_SPACING_DEFAULTS,
  normalizeAxisSpacing,
  normalizeLayoutSpacing,
} from './layout-spacing.js';

export type {
  BoardLayoutLastRow,
  BoardLayoutMode,
  BoardLayoutSettings,
  BoardLayoutTrackAxis,
} from '../types/board.js';
export {
  LAYOUT_SPACING_DEFAULTS,
  MAX_LAYOUT_SPACING,
  normalizeAxisSpacing,
  normalizeLayoutSpacing,
} from './layout-spacing.js';

export const DEFAULT_BOARD_LAYOUT_SETTINGS: Readonly<BoardLayoutSettings> = Object.freeze({
  mode: 'grid',
  density: 'preserve',
  trackAxis: 'auto',
  trackCount: 3,
  columnGap: LAYOUT_SPACING_DEFAULTS.boardColumnGap,
  rowGap: LAYOUT_SPACING_DEFAULTS.boardRowGap,
  outerMargin: LAYOUT_SPACING_DEFAULTS.boardOuterMargin,
  packZoneContents: true,
  resizeZoneFrames: true,
  justifyRows: true,
  lastRow: 'start',
  matchRowHeights: true,
  matchColumnWidths: true,
});

const finiteInteger = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;

export function normalizeBoardLayoutSettings(
  value: Partial<BoardLayoutSettings> | undefined,
  itemCount: number
): BoardLayoutSettings {
  const count = Math.max(1, finiteInteger(itemCount, 1));
  const mode = value?.mode === 'compact' ? 'compact' : 'grid';
  const trackAxis =
    value?.trackAxis === 'columns' || value?.trackAxis === 'rows' ? value.trackAxis : 'auto';
  const density: LayoutDensityPolicy =
    value?.density === 'collapse' || value?.density === 'expand' ? value.density : 'preserve';
  const lastRow: BoardLayoutLastRow =
    value?.lastRow === 'center' || value?.lastRow === 'end' || value?.lastRow === 'justify'
      ? value.lastRow
      : 'start';
  const spacing = normalizeAxisSpacing(value?.columnGap, value?.rowGap, value?.gap, {
    columnGap: DEFAULT_BOARD_LAYOUT_SETTINGS.columnGap,
    rowGap: DEFAULT_BOARD_LAYOUT_SETTINGS.rowGap,
  });
  return {
    mode,
    density,
    trackAxis,
    trackCount: Math.max(1, Math.min(count, finiteInteger(value?.trackCount, 3))),
    ...spacing,
    outerMargin: normalizeLayoutSpacing(
      value?.outerMargin,
      DEFAULT_BOARD_LAYOUT_SETTINGS.outerMargin
    ),
    packZoneContents: value?.packZoneContents !== false,
    resizeZoneFrames: value?.resizeZoneFrames !== false,
    justifyRows: value?.justifyRows !== false,
    lastRow,
    matchRowHeights: value?.matchRowHeights !== false,
    matchColumnWidths: value?.matchColumnWidths !== false,
    ...(value?.cellHorizontalAlignment === 'center' || value?.cellHorizontalAlignment === 'end'
      ? { cellHorizontalAlignment: value.cellHorizontalAlignment }
      : {}),
    ...(value?.cellVerticalAlignment === 'center' || value?.cellVerticalAlignment === 'end'
      ? { cellVerticalAlignment: value.cellVerticalAlignment }
      : {}),
  };
}

export function boardLayoutTracks(
  itemCount: number,
  axis: BoardLayoutTrackAxis,
  requestedCount: number
): { columns?: number; rows?: number } {
  if (axis === 'auto') return {};
  const count = Math.max(1, Math.floor(itemCount));
  const tracks = Math.max(1, Math.min(count, Math.floor(requestedCount)));
  return axis === 'columns'
    ? { columns: tracks, rows: Math.ceil(count / tracks) }
    : { columns: Math.ceil(count / tracks), rows: tracks };
}

/** The only translation from product settings to deterministic planner options. */
export function boardZoneArrangementOptions(
  settings: Partial<BoardLayoutSettings> | undefined,
  itemCount: number
): Omit<BoardZoneArrangementOptions, 'looseItems'> {
  const normalized = normalizeBoardLayoutSettings(settings, itemCount);
  if (normalized.mode === 'compact') {
    return {
      mode: 'compact',
      density: normalized.density,
      gapX: normalized.columnGap,
      gapY: normalized.rowGap,
      outerMargin: normalized.outerMargin,
      packZoneContents: normalized.packZoneContents,
      resizeZoneFrames: normalized.resizeZoneFrames,
    };
  }
  const tracks = boardLayoutTracks(itemCount, normalized.trackAxis, normalized.trackCount);
  return {
    mode: 'grid',
    density: normalized.density,
    gapX: normalized.columnGap,
    gapY: normalized.rowGap,
    outerMargin: normalized.outerMargin,
    packZoneContents: normalized.packZoneContents,
    resizeZoneFrames: normalized.resizeZoneFrames,
    justifyRows: normalized.justifyRows,
    justifyLastRow: normalized.lastRow === 'justify',
    lastRowAlignment: normalized.lastRow === 'justify' ? 'start' : normalized.lastRow,
    matchRowHeights: normalized.matchRowHeights,
    matchColumnWidths: normalized.matchColumnWidths,
    ...(normalized.cellHorizontalAlignment
      ? { cellHorizontalAlignment: normalized.cellHorizontalAlignment }
      : {}),
    ...(normalized.cellVerticalAlignment
      ? { cellVerticalAlignment: normalized.cellVerticalAlignment }
      : {}),
    ...(tracks.columns === undefined
      ? {}
      : { fixedItemsPerRow: tracks.columns, compactFixedGrid: true }),
  };
}

/**
 * Rehydrate an applied plan without letting a later viewport or size change
 * recompute its Grid membership. Cells are persisted with the atomic layout,
 * so their resolved column count is authoritative even when the editor was on
 * Auto tracks.
 */
export function boardLayoutContextOptions(
  context: BoardLayoutContext
): Omit<BoardZoneArrangementOptions, 'looseItems'> {
  const options = boardZoneArrangementOptions(context.settings, context.root_ids.length);
  if (context.settings.mode !== 'grid') return options;
  const cells = context.root_ids.flatMap((id) => {
    const cell = context.cells[id];
    return cell ? [cell] : [];
  });
  if (cells.length === 0) return options;
  return {
    ...options,
    fixedItemsPerRow: Math.max(...cells.map((cell) => cell.column)) + 1,
    compactFixedGrid: true,
  };
}
