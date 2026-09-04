import { layoutRectangles, type RectangleLayoutItem } from './rectangle-packing.js';

/**
 * Justified row layout for zones, in the spirit of a photo grid: zones flow
 * left-to-right and top-to-bottom, every zone in a row shares that row's
 * height, and the row is stretched flush to the target width.
 *
 * The photo-grid algorithm does not port directly, and the reason matters.
 * A photo has one continuous aspect ratio: fix the row height and its width
 * follows, so a row can be justified by solving for a single height. A zone
 * cannot be scaled — its contents are fixed-size cards, a worktree card is a
 * hard 500px wide, and the zone's height is a *step function* of its width,
 * because widening it enough to fit another column removes a whole row of
 * content. So a zone does not have an aspect ratio; it has a small set of
 * legal shapes, one per column count. A one-column shape is the portrait
 * form, a four-column shape the landscape form, and the interesting layouts
 * come from choosing between them per row.
 *
 * That turns justification from "solve for a height" into "choose a shape for
 * each zone in the row". The candidate sets are tiny, so the row solver is an
 * exhaustive search over them, scored by wasted area.
 */

export interface ZoneShape {
  /** Column count the zone's contents are laid out in at this shape. */
  columns: number;
  width: number;
  height: number;
}

export interface JustifiedZoneInput {
  id: string;
  /** Legal shapes for this zone. Must be non-empty. */
  shapes: readonly ZoneShape[];
  /** Whether row justification may enlarge this frame without scaling its contents. */
  resizable?: boolean;
}

export interface JustifiedZoneOptions {
  /** Width each full row is stretched to. */
  targetWidth: number;
  gap?: number;
  startX?: number;
  startY?: number;
  /** Upper bound on zones per row. */
  maxPerRow?: number;
  /**
   * Exact number of zones in each complete row. Unlike `maxPerRow`, this is
   * an explicit grid contract: targetWidth may not break a complete row into
   * smaller visual groups. The final row contains the remainder.
   */
  fixedItemsPerRow?: number;
  /** Keep explicit tracks at their measured compact width instead of filling targetWidth. */
  stretchFixedTracks?: boolean;
  /**
   * Stretch the final row even when it holds fewer zones than fit.
   * Off by default: a photo grid leaves a short last row at its natural size
   * rather than blowing two thumbnails up to full width, and a lone zone
   * stretched across the canvas reads as a rendering fault, not a layout.
   */
  justifyLastRow?: boolean;
  /** Disable all row stretching while retaining deterministic row breaks. */
  justifyRows?: boolean;
  /** Resize eligible frames to the tallest natural shape in their row. */
  matchRowHeights?: boolean;
  /** Placement of a short final row when it is not justified. */
  lastRowAlignment?: 'start' | 'center' | 'end';
  /**
   * Preferred row height, the photo-grid knob.
   *
   * Wasted area alone will pair a 1071px-tall zone with a 505px one and leave
   * the short zone two-thirds empty, because the pairing still fills the row's
   * width. Naming a target height makes that deviation cost something, so the
   * solver will prefer a shorter shape for the tall zone — or, failing that,
   * a row it does not tower over. Omit to score on wasted area alone.
   */
  targetRowHeight?: number;
  /** Quantize zone origins and dimensions to this grid. */
  gridSize?: number;
}

export interface JustifiedZonePlacement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  row: number;
  column: number;
  /** Column count the chosen shape lays the zone's contents out in. */
  columns: number;
  /** Vertical blank space: the row is taller than this zone's natural shape. */
  slackY: number;
}

export interface JustifiedZoneResult {
  placements: JustifiedZonePlacement[];
  rows: number;
  width: number;
  height: number;
  gap: number;
  rowHeights: number[];
  /**
   * Rows that could not be squeezed into targetWidth even at every zone's
   * narrowest shape. Reported rather than silently overflowed, because the
   * caller's options (widen the canvas, split the row) are not ours to pick.
   */
  overflowingRows: number[];
}

/** Exhaustive row search is only sane while the combination count stays small. */
const MAX_ROW_COMBINATIONS = 4096;

const positive = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;

const nonNegative = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && (value as number) >= 0 ? (value as number) : fallback;

/**
 * Shapes sorted by width, with dominated ones removed.
 *
 * A shape is dominated when another is no wider and no taller: it costs more
 * canvas in both directions for nothing, and keeping it only inflates the row
 * search. Ties on width keep the shortest.
 */
function usefulShapes(shapes: readonly ZoneShape[], id: string): ZoneShape[] {
  if (shapes.length === 0) throw new Error(`Zone '${id}' has no candidate shapes.`);
  for (const shape of shapes) {
    if (!Number.isFinite(shape.width) || !Number.isFinite(shape.height)) {
      throw new Error(`Zone '${id}' has a non-finite candidate shape.`);
    }
    if (shape.width <= 0 || shape.height <= 0) {
      throw new Error(`Zone '${id}' has a non-positive candidate shape.`);
    }
  }
  const ascending = [...shapes].sort((a, b) => a.width - b.width || a.height - b.height);
  const kept: ZoneShape[] = [];
  let bestHeight = Number.POSITIVE_INFINITY;
  for (const shape of ascending) {
    // Walking widest-last, a shape is worth keeping only if it is strictly
    // shorter than every narrower shape seen so far.
    if (shape.height < bestHeight) {
      kept.push(shape);
      bestHeight = shape.height;
    }
  }
  return kept;
}

interface RowChoice {
  shapes: ZoneShape[];
  totalWidth: number;
  rowHeight: number;
}

/**
 * Pick one shape per zone in the row, minimising wasted canvas.
 *
 * Waste is the row's bounding area minus the area the zones actually occupy,
 * which prefers rows that both fill the width and agree on height — a tall
 * zone next to short ones is paid for across the whole row.
 */
function solveRow(
  row: readonly { id: string; shapes: ZoneShape[] }[],
  targetWidth: number,
  gap: number,
  targetRowHeight?: number
): RowChoice {
  const gaps = gap * (row.length - 1);
  const combinations = row.reduce((total, zone) => total * zone.shapes.length, 1);

  const measure = (shapes: ZoneShape[]): RowChoice => {
    const totalWidth = shapes.reduce((sum, shape) => sum + shape.width, 0) + gaps;
    const rowHeight = shapes.reduce((tallest, shape) => Math.max(tallest, shape.height), 0);
    return { shapes, totalWidth, rowHeight };
  };

  // Narrowest shape for every zone: the fallback, and the only option when no
  // combination fits.
  const narrowest = measure(row.map((zone) => zone.shapes[0]));

  if (combinations > MAX_ROW_COMBINATIONS) {
    // Degrade predictably rather than hang: widen zones one at a time, taking
    // the step that adds the least height, while the row still fits.
    const chosen = row.map((zone) => zone.shapes[0]);
    let current = measure(chosen);
    let improved = true;
    while (improved) {
      improved = false;
      let bestIndex = -1;
      let bestCandidate: RowChoice | null = null;
      for (let i = 0; i < row.length; i += 1) {
        const next = row[i].shapes[row[i].shapes.indexOf(chosen[i]) + 1];
        if (!next) continue;
        const trial = [...chosen];
        trial[i] = next;
        const measured = measure(trial);
        if (measured.totalWidth > targetWidth) continue;
        if (!bestCandidate || measured.rowHeight < bestCandidate.rowHeight) {
          bestCandidate = measured;
          bestIndex = i;
        }
      }
      if (bestCandidate && bestIndex >= 0) {
        chosen[bestIndex] = bestCandidate.shapes[bestIndex];
        current = bestCandidate;
        improved = true;
      }
    }
    return current;
  }

  let best: RowChoice | null = null;
  let bestWaste = Number.POSITIVE_INFINITY;
  const chosen: ZoneShape[] = new Array(row.length);

  const walk = (index: number): void => {
    if (index === row.length) {
      const measured = measure(chosen.slice());
      if (measured.totalWidth > targetWidth) return;
      const occupied = measured.shapes.reduce((sum, shape) => sum + shape.width * shape.height, 0);
      // Deviation from the preferred height is charged at the row's full width,
      // putting it in the same units as the wasted area it competes with.
      const heightPenalty =
        targetRowHeight === undefined
          ? 0
          : Math.abs(measured.rowHeight - targetRowHeight) * targetWidth;
      const waste = measured.rowHeight * targetWidth - occupied + heightPenalty;
      if (waste < bestWaste) {
        bestWaste = waste;
        best = measured;
      }
      return;
    }
    for (const shape of row[index].shapes) {
      chosen[index] = shape;
      walk(index + 1);
    }
  };
  walk(0);

  return best ?? narrowest;
}

/**
 * Stretch a row's widths to exactly `targetWidth`.
 *
 * Extra width is handed out in proportion to each zone's chosen width, so the
 * relative weight of a wide zone against a narrow one survives justification.
 * The last zone absorbs the rounding remainder so the row sums exactly.
 */
function justify(widths: number[], leftover: number, gridSize: number): number[] {
  if (leftover <= 0 || widths.length === 0) return widths;
  const widthSum = widths.reduce((sum, width) => sum + width, 0);
  if (widthSum <= 0) return widths;
  const stretched = [...widths];
  let handed = 0;
  for (let i = 0; i < stretched.length - 1; i += 1) {
    const proportional = (leftover * widths[i]) / widthSum;
    const share = Math.min(
      leftover - handed,
      gridSize > 0 ? Math.round(proportional / gridSize) * gridSize : Math.round(proportional)
    );
    stretched[i] += share;
    handed += share;
  }
  stretched[stretched.length - 1] += leftover - handed;
  return stretched;
}

function justifyResizable(
  widths: number[],
  resizable: readonly boolean[],
  leftover: number,
  gridSize: number
): number[] {
  const eligible = widths.flatMap((width, index) => (resizable[index] ? [{ width, index }] : []));
  if (eligible.length === 0) return widths;
  const stretched = justify(
    eligible.map(({ width }) => width),
    leftover,
    gridSize
  );
  const result = [...widths];
  eligible.forEach(({ index }, eligibleIndex) => {
    result[index] = stretched[eligibleIndex];
  });
  return result;
}

/**
 * Lay zones out in justified rows.
 *
 * Rows are filled greedily at each zone's narrowest shape, which keeps the
 * row feasible; the shape choice that actually gets used is then made per row
 * by {@link solveRow}.
 */
export function layoutJustifiedZones(
  zones: readonly JustifiedZoneInput[],
  options: JustifiedZoneOptions
): JustifiedZoneResult {
  const gridSize = nonNegative(options.gridSize, 0);
  const snap = (value: number): number =>
    gridSize > 0 ? Math.round(value / gridSize) * gridSize : value;
  const ceil = (value: number): number =>
    gridSize > 0 && value !== 0 ? Math.ceil(value / gridSize) * gridSize : value;
  const floor = (value: number): number =>
    gridSize > 0 ? Math.floor(value / gridSize) * gridSize : value;
  const gap = ceil(nonNegative(options.gap, 40));
  const startX = snap(Number.isFinite(options.startX) ? (options.startX as number) : 80);
  const startY = snap(Number.isFinite(options.startY) ? (options.startY as number) : 80);
  const targetWidth = Math.max(gridSize, floor(positive(options.targetWidth, 1600)));
  const maxPerRow = Math.max(1, Math.floor(positive(options.maxPerRow, Number.MAX_SAFE_INTEGER)));
  const requestedFixedItemsPerRow =
    options.fixedItemsPerRow === undefined
      ? undefined
      : Math.max(1, Math.floor(positive(options.fixedItemsPerRow, 1)));

  const prepared = zones.map((zone) => ({
    id: zone.id,
    resizable: zone.resizable !== false,
    shapes: usefulShapes(
      zone.shapes.map((shape) => ({
        ...shape,
        width: ceil(shape.width),
        height: ceil(shape.height),
      })),
      zone.id
    ),
  }));

  if (prepared.length === 0) {
    return {
      placements: [],
      rows: 0,
      width: 0,
      height: 0,
      gap,
      rowHeights: [],
      overflowingRows: [],
    };
  }
  const fixedItemsPerRow =
    requestedFixedItemsPerRow === undefined
      ? undefined
      : Math.min(prepared.length, requestedFixedItemsPerRow);

  /**
   * The width a zone wants to occupy when rows are being broken.
   *
   * Filling rows at the narrowest shape looks safe and quietly ruins the
   * layout: a tall zone gets packed beside a short one, and once they share a
   * row the tall one can no longer afford a wider, shorter shape, so the row
   * inherits its full height and the short zone is left mostly blank. Breaking
   * on the shape the zone actually wants lets it claim its own row and go
   * landscape instead. Shapes wider than the row are ignored, and the
   * narrowest shape is always a legal fallback, so a row that fits at these
   * widths still fits at the widths {@link solveRow} may pick.
   */
  const preferredWidth = (zone: (typeof prepared)[number]): number => {
    const affordable = zone.shapes.filter((shape) => shape.width <= targetWidth);
    const usable = affordable.length > 0 ? affordable : [zone.shapes[0]];
    if (options.targetRowHeight === undefined) return usable[0].width;
    const target = options.targetRowHeight;
    return usable.reduce((best, shape) =>
      Math.abs(shape.height - target) < Math.abs(best.height - target) ? shape : best
    ).width;
  };

  // A zone that cannot fit a row even alone still gets its own row — reported
  // as overflowing rather than dropped.
  const rows: (typeof prepared)[] = [];
  if (fixedItemsPerRow !== undefined) {
    for (let index = 0; index < prepared.length; index += fixedItemsPerRow) {
      rows.push(prepared.slice(index, index + fixedItemsPerRow));
    }
  } else {
    let current: typeof prepared = [];
    for (const zone of prepared) {
      const candidate = [...current, zone];
      const naturalWidth =
        candidate.reduce((sum, entry) => sum + preferredWidth(entry), 0) +
        gap * (candidate.length - 1);
      if (current.length > 0 && (naturalWidth > targetWidth || candidate.length > maxPerRow)) {
        rows.push(current);
        current = [zone];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) rows.push(current);
  }

  const placements: JustifiedZonePlacement[] = [];
  const rowHeights: number[] = [];
  const overflowingRows: number[] = [];
  const solvedRows = rows.map((row) => solveRow(row, targetWidth, gap, options.targetRowHeight));
  const fixedColumnWidths =
    fixedItemsPerRow === undefined
      ? undefined
      : Array.from({ length: fixedItemsPerRow }, (_, column) =>
          Math.max(0, ...solvedRows.map((solved) => solved.shapes[column]?.width ?? 0))
        );
  const fixedNaturalWidth =
    fixedColumnWidths === undefined
      ? 0
      : fixedColumnWidths.reduce((sum, width) => sum + width, 0) +
        gap * Math.max(0, fixedColumnWidths.length - 1);
  const fixedTrackWidths =
    fixedColumnWidths !== undefined &&
    fixedNaturalWidth <= targetWidth &&
    options.stretchFixedTracks !== false
      ? justify(fixedColumnWidths, targetWidth - fixedNaturalWidth, gridSize)
      : fixedColumnWidths;
  let y = startY;
  let widest = 0;

  rows.forEach((row, rowIndex) => {
    const solved = solvedRows[rowIndex];
    const isLastRow = rowIndex === rows.length - 1;
    const useFixedTracks =
      fixedTrackWidths !== undefined &&
      !(isLastRow && row.length < fixedTrackWidths.length && options.justifyLastRow === true);
    const shouldJustify =
      options.justifyRows !== false &&
      !useFixedTracks &&
      (!isLastRow || options.justifyLastRow === true);

    let widths = useFixedTracks
      ? solved.shapes.map((shape, column) =>
          row[column]?.resizable ? (fixedTrackWidths[column] ?? shape.width) : shape.width
        )
      : solved.shapes.map((shape) => shape.width);
    if (solved.totalWidth > targetWidth) {
      overflowingRows.push(rowIndex);
    } else if (shouldJustify) {
      widths = justifyResizable(
        widths,
        row.map((zone) => zone.resizable),
        targetWidth - solved.totalWidth,
        gridSize
      );
    }

    const actualWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (row.length - 1);
    const alignment = isLastRow ? (options.lastRowAlignment ?? 'start') : 'start';
    let x =
      startX +
      (alignment === 'center'
        ? Math.max(0, snap((targetWidth - actualWidth) / 2))
        : alignment === 'end'
          ? Math.max(0, targetWidth - actualWidth)
          : 0);
    let actualRowHeight = 0;
    row.forEach((zone, columnIndex) => {
      const shape = solved.shapes[columnIndex];
      const height =
        zone.resizable && options.matchRowHeights !== false ? solved.rowHeight : shape.height;
      placements.push({
        id: zone.id,
        x,
        y,
        width: widths[columnIndex],
        height,
        row: rowIndex,
        column: columnIndex,
        columns: shape.columns,
        slackY: height - shape.height,
      });
      x += widths[columnIndex] + gap;
      actualRowHeight = Math.max(actualRowHeight, height);
    });

    widest = Math.max(widest, actualWidth);
    rowHeights.push(actualRowHeight);
    y += actualRowHeight + gap;
  });

  return {
    placements,
    rows: rows.length,
    width: widest,
    height: rows.length === 0 ? 0 : y - gap - startY,
    gap,
    rowHeights,
    overflowingRows,
  };
}

export interface ZoneShapeOptions {
  /** Space reserved for the zone's label/status above its contents. */
  titleInset?: number;
  padding?: number;
  gapX?: number;
  gapY?: number;
  gridSize?: number;
  /** Cap on the column counts tried. */
  maxColumns?: number;
}

/**
 * The legal shapes for one zone, derived by packing its contents at each
 * column count.
 *
 * This is what makes a zone's "portrait" and "landscape" forms concrete: the
 * same items at one column are tall and narrow, at four columns short and
 * wide, and every step between is a real layout the zone can actually hold.
 * An empty zone has a single degenerate shape so it still participates in a
 * row instead of being dropped.
 */
export function zoneShapesForItems(
  items: readonly RectangleLayoutItem[],
  options: ZoneShapeOptions = {}
): ZoneShape[] {
  const gridSize = nonNegative(options.gridSize, 0);
  const ceil = (value: number): number =>
    gridSize > 0 && value !== 0 ? Math.ceil(value / gridSize) * gridSize : value;
  const titleInset = ceil(nonNegative(options.titleInset, 64));
  const padding = ceil(nonNegative(options.padding, 24));
  const gapX = nonNegative(options.gapX, 24);
  const gapY = nonNegative(options.gapY, 24);

  if (items.length === 0) {
    return [{ columns: 1, width: padding * 2 + 200, height: titleInset + padding * 2 }];
  }

  const maxColumns = Math.max(
    1,
    Math.min(items.length, Math.floor(positive(options.maxColumns, items.length)))
  );

  const shapes: ZoneShape[] = [];
  for (let columns = 1; columns <= maxColumns; columns += 1) {
    const layout = layoutRectangles(items, {
      exactColumns: columns,
      gapX,
      gapY,
      padding: 0,
      gridSize,
    });
    // `layoutRectangles` reports the content box; the zone adds its own frame.
    shapes.push({
      columns,
      width: ceil(layout.width + padding * 2),
      height: ceil(layout.height + titleInset + padding * 2),
    });
  }
  return shapes;
}
