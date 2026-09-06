export interface RectangleLayoutItem {
  id: string;
  width: number;
  height: number;
}

export interface RectanglePlacement extends RectangleLayoutItem {
  x: number;
  y: number;
  row: number;
  column: number;
  stackIndex: number;
  deckDepth: number;
}

export interface RectangleLayoutOptions {
  /** Outer container size. Omit for an unbounded canvas layout. */
  bounds?: { width: number; height: number };
  padding?: number;
  /** Smallest acceptable edge margin when a bounded grid needs compaction. */
  minPadding?: number;
  gapX?: number;
  gapY?: number;
  /** Smallest acceptable gaps when a bounded grid needs gentle compaction. */
  minGapX?: number;
  minGapY?: number;
  /** Soft grid-width preference. The nearest fitting width wins. */
  preferredColumns?: number;
  /** Exact grid width. Bounded layouts never substitute another column count. */
  exactColumns?: number;
  /** Used only when no non-overlapping grid fits. */
  allowDeck?: boolean;
  /** Legacy diagonal deck offset. Prefer deckOffsetX/deckOffsetY. */
  deckOffset?: number;
  /** Visible left-edge reveal between deck layers. */
  deckOffsetX?: number;
  /** Visible header reveal between deck layers. */
  deckOffsetY?: number;
  /** Quantize item sizes, spacing, and placements to this grid. */
  gridSize?: number;
}

/** The board grid used by React Flow manual drag/resize and every automatic layout path. */
export const BOARD_GRID_SIZE = 20;
export const BOARD_SNAP_GRID: [number, number] = [BOARD_GRID_SIZE, BOARD_GRID_SIZE];

export function snapBoardGridValue(value: number): number {
  return Math.round(value / BOARD_GRID_SIZE) * BOARD_GRID_SIZE;
}

export function ceilBoardGridValue(value: number): number {
  if (value === 0) return 0;
  return Math.ceil(value / BOARD_GRID_SIZE) * BOARD_GRID_SIZE;
}

export function snapBoardGridPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: snapBoardGridValue(point.x), y: snapBoardGridValue(point.y) };
}

export function ceilBoardGridSize(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return {
    width: ceilBoardGridValue(size.width),
    height: ceilBoardGridValue(size.height),
  };
}

export interface RectangleLayoutResult {
  mode: 'grid' | 'deck';
  placements: RectanglePlacement[];
  columns: number;
  rows: number;
  width: number;
  height: number;
  gapX: number;
  gapY: number;
  padding: number;
  fitsWithoutOverlap: boolean;
  stackCount: number;
  maxDeckDepth: number;
  deckOffsetX: number;
  deckOffsetY: number;
  overflowingItemIds: string[];
}

export interface CompactRectangleLayoutResult extends Omit<RectangleLayoutResult, 'mode'> {
  mode: 'cluster';
}

export interface CompactRectangleLayoutItem extends RectangleLayoutItem {
  /** Optional prior canvas position, used only as a final movement tie-break. */
  sourceX?: number;
  sourceY?: number;
}

export interface CompactRectangleLayoutOptions {
  /** Optional outer container. Placements stay inside it after padding. */
  bounds?: { width: number; height: number };
  padding?: number;
  gapX?: number;
  gapY?: number;
  gridSize?: number;
  /** Preserve caller order for semantic zone sorts; outer clusters use size-first search. */
  preserveInputOrder?: boolean;
}

/** A board rectangle that an explicit selection layout may not displace. */
export interface FixedLayoutObstacle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ObstacleAwareLayoutOptions {
  /** Desired absolute top-left for the compact selection cluster. */
  desiredOrigin: { x: number; y: number };
  obstacles?: readonly FixedLayoutObstacle[];
  gapX?: number;
  gapY?: number;
  gridSize?: number;
  /** Optional absolute canvas bounds. Omit for Agor's ordinary unbounded board. */
  bounds?: { x: number; y: number; width: number; height: number };
  /** Defensive search ceiling for unusually dense obstacle fields. */
  maxCandidates?: number;
}

export interface ObstacleAwareLayoutResult<T extends RectanglePlacement = RectanglePlacement> {
  placements: T[];
  origin: { x: number; y: number };
  width: number;
  height: number;
}

/** An explicit layout must fail rather than moving or overlapping fixed peers. */
export class LayoutObstacleError extends Error {
  constructor(message = 'The selected layout cannot fit without overlapping fixed board objects.') {
    super(message);
    this.name = 'LayoutObstacleError';
  }
}

interface GridCandidate {
  placements: RectanglePlacement[];
  columns: number;
  rows: number;
  width: number;
  height: number;
  gapX: number;
  gapY: number;
  padding: number;
}

const finiteNonNegative = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && (value ?? -1) >= 0 ? (value as number) : fallback;

const ceilToGrid = (value: number, gridSize: number): number =>
  gridSize > 0 && value !== 0 ? Math.ceil(value / gridSize) * gridSize : value;

const floorToGrid = (value: number, gridSize: number): number =>
  gridSize > 0 ? Math.floor(value / gridSize) * gridSize : value;

function normalizedItems(
  items: readonly RectangleLayoutItem[],
  gridSize: number
): RectangleLayoutItem[] {
  return items.map((item) => {
    if (!Number.isFinite(item.width) || !Number.isFinite(item.height)) {
      throw new Error(`Rectangle '${item.id}' has a non-finite size.`);
    }
    if (item.width <= 0 || item.height <= 0) {
      throw new Error(`Rectangle '${item.id}' must have a positive width and height.`);
    }
    return {
      ...item,
      width: ceilToGrid(item.width, gridSize),
      height: ceilToGrid(item.height, gridSize),
    };
  });
}

function buildGrid(
  items: readonly RectangleLayoutItem[],
  columns: number,
  padding: number,
  gapX: number,
  gapY: number
): GridCandidate {
  const safeColumns = Math.max(1, Math.min(items.length || 1, Math.floor(columns)));
  const rows = Math.ceil(items.length / safeColumns);
  const columnWidths = Array.from({ length: safeColumns }, () => 0);
  const rowHeights = Array.from({ length: rows }, () => 0);
  for (const [index, item] of items.entries()) {
    const column = index % safeColumns;
    const row = Math.floor(index / safeColumns);
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, item.width);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, item.height);
  }
  const columnOffsets: number[] = [];
  let nextX = padding;
  for (const width of columnWidths) {
    columnOffsets.push(nextX);
    nextX += width + gapX;
  }
  const rowOffsets: number[] = [];
  let nextY = padding;
  for (const height of rowHeights) {
    rowOffsets.push(nextY);
    nextY += height + gapY;
  }
  const placements = items.map((item, index) => {
    const column = index % safeColumns;
    const row = Math.floor(index / safeColumns);
    return {
      ...item,
      x: columnOffsets[column] ?? padding,
      y: rowOffsets[row] ?? padding,
      row,
      column,
      stackIndex: index,
      deckDepth: 0,
    };
  });
  return {
    placements,
    columns: safeColumns,
    rows,
    width:
      padding * 2 +
      columnWidths.reduce((sum, width) => sum + width, 0) +
      Math.max(0, safeColumns - 1) * gapX,
    height:
      padding * 2 +
      rowHeights.reduce((sum, height) => sum + height, 0) +
      Math.max(0, rows - 1) * gapY,
    gapX,
    gapY,
    padding,
  };
}

function fits(candidate: GridCandidate, bounds: { width: number; height: number }): boolean {
  return candidate.width <= bounds.width && candidate.height <= bounds.height;
}

function chooseGrid(
  items: readonly RectangleLayoutItem[],
  options: {
    bounds?: { width: number; height: number };
    padding: number;
    gapX: number;
    gapY: number;
    minGapX: number;
    minGapY: number;
    minPadding: number;
    preferredColumns?: number;
    exactColumns?: number;
    gridSize: number;
  }
): GridCandidate | undefined {
  if (items.length === 0) return buildGrid(items, 1, options.padding, options.gapX, options.gapY);
  const exactColumns = options.exactColumns
    ? Math.max(1, Math.min(items.length, Math.floor(options.exactColumns)))
    : undefined;
  const bounds = options.bounds;
  const minimumItemWidth = items.reduce(
    (minimum, item) => Math.min(minimum, item.width),
    Number.POSITIVE_INFINITY
  );
  // A bounded grid cannot have more columns than its width can contain at the
  // minimum allowed padding and gap. Capping the search here avoids trying all
  // n column counts (and rebuilding an n-item grid each time) on large boards.
  const maximumFittingColumns = bounds
    ? Math.max(
        0,
        Math.floor(
          (bounds.width - options.minPadding * 2 + options.minGapX) /
            (minimumItemWidth + options.minGapX)
        )
      )
    : items.length;
  const columnCounts = exactColumns
    ? [exactColumns]
    : bounds
      ? Array.from(
          { length: Math.min(items.length, maximumFittingColumns) },
          (_, index) => index + 1
        )
      : [
          options.preferredColumns
            ? Math.max(1, Math.min(items.length, Math.floor(options.preferredColumns)))
            : items.length,
        ];
  const candidates = columnCounts
    .flatMap((columns) => {
      if (!bounds) {
        return [buildGrid(items, columns, options.padding, options.gapX, options.gapY)];
      }

      // First preserve the requested margins. If that cannot fit, compact the
      // outer margin as well as the inter-item gaps before considering overlap.
      return [...new Set([options.padding, options.minPadding])].flatMap((padding) => {
        const compact = buildGrid(items, columns, padding, 0, 0);
        const horizontalDivisors = Math.max(0, compact.columns - 1);
        const verticalDivisors = Math.max(0, compact.rows - 1);
        const fittingGapX =
          horizontalDivisors === 0
            ? options.gapX
            : Math.floor((bounds.width - compact.width) / horizontalDivisors);
        const fittingGapY =
          verticalDivisors === 0
            ? options.gapY
            : Math.floor((bounds.height - compact.height) / verticalDivisors);
        const effectiveGapX = Math.min(options.gapX, fittingGapX);
        const effectiveGapY = Math.min(options.gapY, fittingGapY);
        if (effectiveGapX < options.minGapX || effectiveGapY < options.minGapY) return [];
        return [buildGrid(items, columns, padding, effectiveGapX, effectiveGapY)];
      });
    })
    .filter(
      (candidate): candidate is GridCandidate =>
        candidate !== undefined && (!bounds || fits(candidate, bounds))
    );
  const preferred = options.preferredColumns
    ? Math.max(1, Math.min(items.length, Math.floor(options.preferredColumns)))
    : undefined;
  return candidates.sort((a, b) => {
    if (preferred !== undefined) {
      const preferredDelta = Math.abs(a.columns - preferred) - Math.abs(b.columns - preferred);
      if (preferredDelta !== 0) return preferredDelta;
    }
    // With no preference, use as many complete columns as the available
    // rectangle permits. This produces a compact top-left, row-major grid.
    return (
      b.columns - a.columns ||
      b.padding - a.padding ||
      b.gapX + b.gapY - (a.gapX + a.gapY) ||
      a.height - b.height ||
      a.width - b.width
    );
  })[0];
}

function overflowingIds(
  placements: readonly RectanglePlacement[],
  bounds: { width: number; height: number }
): string[] {
  return placements
    .filter(
      (item) =>
        item.x < 0 ||
        item.y < 0 ||
        item.x + item.width > bounds.width ||
        item.y + item.height > bounds.height
    )
    .map((item) => item.id);
}

function buildDeck(
  items: readonly RectangleLayoutItem[],
  options: {
    bounds: { width: number; height: number };
    padding: number;
    gapX: number;
    gapY: number;
    minGapX: number;
    minGapY: number;
    minPadding: number;
    preferredColumns?: number;
    exactColumns?: number;
    deckOffsetX: number;
    deckOffsetY: number;
    gridSize: number;
  }
): RectangleLayoutResult | undefined {
  // Try the maximum possible number of stacks first. Overlap grows only when
  // the zone truly cannot fit another fully separated stack.
  for (let stackCount = items.length - 1; stackCount >= 1; stackCount--) {
    const exactColumns = options.exactColumns
      ? Math.max(1, Math.min(items.length, Math.floor(options.exactColumns)))
      : undefined;
    if (exactColumns !== undefined && stackCount < exactColumns) continue;
    // Aggregate every stack in one pass. Filtering the complete item list once
    // per stack made a single candidate quadratic before grid selection even
    // began, which was especially costly for large layouts that cannot fit.
    const stacks = Array.from({ length: stackCount }, (_, stackIndex) => ({
      id: `stack-${stackIndex}`,
      width: 0,
      height: 0,
    }));
    for (const [index, item] of items.entries()) {
      const stackIndex = index % stackCount;
      const depth = Math.floor(index / stackCount);
      const stack = stacks[stackIndex];
      if (!stack) throw new Error(`Missing deck stack ${stackIndex}.`);
      stack.width = Math.max(stack.width, item.width + depth * options.deckOffsetX);
      stack.height = Math.max(stack.height, item.height + depth * options.deckOffsetY);
    }
    const stackGrid = chooseGrid(stacks, options);
    if (!stackGrid) continue;
    const stackBaseByIndex = new Map(
      stackGrid.placements.map((placement, index) => [index, placement] as const)
    );
    const placements = items.map((item, index) => {
      const stackIndex = index % stackCount;
      const deckDepth = Math.floor(index / stackCount);
      const base = stackBaseByIndex.get(stackIndex);
      if (!base) throw new Error(`Missing deck stack ${stackIndex}.`);
      return {
        ...item,
        x: base.x + deckDepth * options.deckOffsetX,
        y: base.y + deckDepth * options.deckOffsetY,
        row: base.row,
        column: base.column,
        stackIndex,
        deckDepth,
      };
    });
    return {
      mode: 'deck',
      placements,
      columns: stackGrid.columns,
      rows: stackGrid.rows,
      width: stackGrid.width,
      height: stackGrid.height,
      gapX: stackGrid.gapX,
      gapY: stackGrid.gapY,
      padding: stackGrid.padding,
      fitsWithoutOverlap: false,
      stackCount,
      maxDeckDepth: Math.ceil(items.length / stackCount),
      deckOffsetX: options.deckOffsetX,
      deckOffsetY: options.deckOffsetY,
      overflowingItemIds: overflowingIds(placements, options.bounds),
    };
  }
  return undefined;
}

/**
 * Deterministic top-left rectangle packing for heterogeneous board nodes.
 *
 * Grid mode never overlaps and validates the complete rendered rectangles
 * against both container axes. Deck mode is an explicit last resort: it uses
 * the greatest number of independently packed stacks that fit, then offsets
 * each layer down and right so the underlying top and left edges remain visible.
 */
export function layoutRectangles(
  sourceItems: readonly RectangleLayoutItem[],
  options: RectangleLayoutOptions = {}
): RectangleLayoutResult {
  if (options.preferredColumns !== undefined && options.exactColumns !== undefined) {
    throw new Error('Specify either preferredColumns or exactColumns, not both.');
  }
  const gridSize = finiteNonNegative(options.gridSize, 0);
  const items = normalizedItems(sourceItems, gridSize);
  const padding = ceilToGrid(finiteNonNegative(options.padding, 0), gridSize);
  const minPadding = Math.min(
    padding,
    ceilToGrid(finiteNonNegative(options.minPadding, Math.min(8, padding)), gridSize)
  );
  // Gaps are an explicit visual-density input, not board-grid geometry. Item
  // sizes and the container frame remain grid-safe, but rounding a requested
  // 4/8/12px gap up to the 20px drag grid made several distinct UI values
  // produce the same layout (and rounded the historical 24px default to 40).
  // Keeping gaps exact also leaves collision checks honest: every solver uses
  // the same physical boundary distance it reports to the caller.
  const gapX = finiteNonNegative(options.gapX, 24);
  const gapY = finiteNonNegative(options.gapY, 24);
  const minGapX = Math.min(gapX, finiteNonNegative(options.minGapX, Math.min(12, gapX)));
  const minGapY = Math.min(gapY, finiteNonNegative(options.minGapY, Math.min(12, gapY)));
  const legacyDeckOffset = finiteNonNegative(options.deckOffset, 12);
  const deckOffsetX = ceilToGrid(
    finiteNonNegative(options.deckOffsetX, legacyDeckOffset),
    gridSize
  );
  const deckOffsetY = ceilToGrid(
    finiteNonNegative(
      options.deckOffsetY,
      options.deckOffset === undefined ? 48 : legacyDeckOffset
    ),
    gridSize
  );
  const bounds = options.bounds
    ? {
        width: floorToGrid(finiteNonNegative(options.bounds.width, 0), gridSize),
        height: floorToGrid(finiteNonNegative(options.bounds.height, 0), gridSize),
      }
    : undefined;
  const grid = chooseGrid(items, {
    bounds,
    padding,
    gapX,
    gapY,
    minGapX,
    minGapY,
    minPadding,
    preferredColumns: options.preferredColumns,
    exactColumns: options.exactColumns,
    gridSize,
  });
  if (grid) {
    return {
      mode: 'grid',
      ...grid,
      fitsWithoutOverlap: true,
      stackCount: items.length,
      maxDeckDepth: 1,
      deckOffsetX: 0,
      deckOffsetY: 0,
      overflowingItemIds: bounds ? overflowingIds(grid.placements, bounds) : [],
    };
  }
  const deck =
    bounds && options.allowDeck !== false
      ? buildDeck(items, {
          bounds,
          padding,
          gapX,
          gapY,
          minGapX,
          minGapY,
          minPadding,
          preferredColumns: options.preferredColumns,
          exactColumns: options.exactColumns,
          deckOffsetX,
          deckOffsetY,
          gridSize,
        })
      : undefined;
  if (deck) return deck;

  // An individual item is larger than the usable container, or deck mode was
  // disabled. Keep deterministic origins and report the exact rectangles that
  // cannot be contained instead of pretending the arrangement succeeded.
  const fallback = buildGrid(
    items,
    options.exactColumns ?? options.preferredColumns ?? 1,
    padding,
    gapX,
    gapY
  );
  return {
    mode: 'grid',
    ...fallback,
    fitsWithoutOverlap: true,
    stackCount: items.length,
    maxDeckDepth: 1,
    deckOffsetX: 0,
    deckOffsetY: 0,
    overflowingItemIds: bounds ? overflowingIds(fallback.placements, bounds) : [],
  };
}

type ClusterPlacement = RectanglePlacement & { sourceX?: number; sourceY?: number };

interface ClusterState {
  placements: ClusterPlacement[];
}

const COMPACT_LAYOUT_BEAM_WIDTH = 192;

const clusterSeparated = (
  left: ClusterPlacement,
  right: { x: number; y: number; width: number; height: number },
  gapX: number,
  gapY: number
): boolean =>
  left.x + left.width + gapX <= right.x ||
  right.x + right.width + gapX <= left.x ||
  left.y + left.height + gapY <= right.y ||
  right.y + right.height + gapY <= left.y;

/**
 * Pack heterogeneous canvas rectangles into a compact deterministic cluster.
 *
 * Unlike `layoutRectangles`, this is intentionally not a fixed row/column
 * grid. Every item is placed on the corner frontier created by prior items.
 * The larger enclosing dimension wins first, then area, perimeter, and
 * movement from the supplied source geometry. Input order remains stable in
 * the returned array, and source geometry resolves equally compact
 * alternatives with less motion.
 */
export function layoutCompactRectangles(
  sourceItems: readonly CompactRectangleLayoutItem[],
  options: CompactRectangleLayoutOptions = {}
): CompactRectangleLayoutResult {
  const gridSize = finiteNonNegative(options.gridSize, 0);
  const padding = ceilToGrid(finiteNonNegative(options.padding, 0), gridSize);
  const gapX = finiteNonNegative(options.gapX, 24);
  const gapY = finiteNonNegative(options.gapY, 24);
  const bounds = options.bounds;
  const usableWidth = bounds
    ? Math.max(0, floorToGrid(finiteNonNegative(bounds.width, 0) - padding * 2, gridSize))
    : Number.POSITIVE_INFINITY;
  const usableHeight = bounds
    ? Math.max(0, floorToGrid(finiteNonNegative(bounds.height, 0) - padding * 2, gridSize))
    : Number.POSITIVE_INFINITY;
  const items = normalizedItems(sourceItems, gridSize).map((item, index) => ({
    ...item,
    sourceX: sourceItems[index]?.sourceX,
    sourceY: sourceItems[index]?.sourceY,
  }));
  if (items.length === 0) {
    return {
      mode: 'cluster',
      placements: [],
      columns: 1,
      rows: 0,
      width: padding * 2,
      height: padding * 2,
      gapX,
      gapY,
      padding,
      fitsWithoutOverlap: true,
      stackCount: 0,
      maxDeckDepth: 1,
      deckOffsetX: 0,
      deckOffsetY: 0,
      overflowingItemIds: [],
    };
  }

  const finiteSourceXs = items
    .map((item) => item.sourceX)
    .filter((value): value is number => Number.isFinite(value));
  const finiteSourceYs = items
    .map((item) => item.sourceY)
    .filter((value): value is number => Number.isFinite(value));
  const sourceLeft = finiteSourceXs.length > 0 ? Math.min(...finiteSourceXs) : 0;
  const sourceTop = finiteSourceYs.length > 0 ? Math.min(...finiteSourceYs) : 0;
  const sourcePositionById = new Map(
    items.map((item) => [
      item.id,
      {
        x: Number.isFinite(item.sourceX) ? (item.sourceX as number) - sourceLeft : 0,
        y: Number.isFinite(item.sourceY) ? (item.sourceY as number) - sourceTop : 0,
      },
    ])
  );
  // Largest-first placement makes the frontier independent of caller array
  // order and prevents a run of small cards from walling a large frame onto a
  // shelf. Stable ids resolve equal shapes, so realtime array permutations do
  // not alter the result.
  const searchItems = options.preserveInputOrder
    ? [...items]
    : [...items].sort(
        (left, right) =>
          Math.max(right.width, right.height) - Math.max(left.width, left.height) ||
          right.width * right.height - left.width * left.height ||
          right.height - left.height ||
          right.width - left.width ||
          left.id.localeCompare(right.id)
      );

  const normalizeState = (placements: readonly ClusterPlacement[]): ClusterPlacement[] => {
    const minX = Math.min(...placements.map((placement) => placement.x));
    const minY = Math.min(...placements.map((placement) => placement.y));
    return placements.map((placement) => ({
      ...placement,
      x: placement.x - minX,
      y: placement.y - minY,
    }));
  };
  const stateBounds = (placements: readonly ClusterPlacement[]) => ({
    width: Math.max(...placements.map((placement) => placement.x + placement.width)),
    height: Math.max(...placements.map((placement) => placement.y + placement.height)),
  });
  const stateScore = (state: ClusterState) => {
    const frame = stateBounds(state.placements);
    const movement = state.placements.reduce((total, placement) => {
      const source = sourcePositionById.get(placement.id) ?? { x: 0, y: 0 };
      return total + (placement.x - source.x) ** 2 + (placement.y - source.y) ** 2;
    }, 0);
    const stableGeometry = [...state.placements]
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((placement) => [placement.y, placement.x]);
    return [
      Math.max(frame.width, frame.height),
      frame.width * frame.height,
      frame.width + frame.height,
      movement,
      ...stableGeometry,
    ];
  };
  const compareStates = (left: ClusterState, right: ClusterState): number => {
    const leftScore = stateScore(left);
    const rightScore = stateScore(right);
    for (let index = 0; index < Math.max(leftScore.length, rightScore.length); index += 1) {
      const delta = (leftScore[index] ?? 0) - (rightScore[index] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  };

  let beam: ClusterState[] = [{ placements: [] }];
  for (const [stackIndex, item] of searchItems.entries()) {
    const nextByGeometry = new Map<string, ClusterState>();
    for (const state of beam) {
      const candidateByKey = new Map<string, { x: number; y: number }>();
      const addCandidate = (x: number, y: number) => {
        candidateByKey.set(`${x}:${y}`, { x, y });
      };
      addCandidate(0, 0);
      for (const existing of state.placements) {
        const left = existing.x - item.width - gapX;
        const right = existing.x + existing.width + gapX;
        const above = existing.y - item.height - gapY;
        const below = existing.y + existing.height + gapY;
        addCandidate(right, existing.y);
        addCandidate(left, existing.y);
        addCandidate(existing.x, below);
        addCandidate(existing.x, above);
        addCandidate(right, existing.y + existing.height - item.height);
        addCandidate(left, existing.y + existing.height - item.height);
        addCandidate(existing.x + existing.width - item.width, below);
        addCandidate(existing.x + existing.width - item.width, above);
      }
      for (const candidate of candidateByKey.values()) {
        const previousPlacement = state.placements[state.placements.length - 1];
        if (
          options.preserveInputOrder &&
          (candidate.x < 0 ||
            candidate.y < 0 ||
            (previousPlacement &&
              (candidate.y < previousPlacement.y ||
                (candidate.y === previousPlacement.y && candidate.x < previousPlacement.x))))
        )
          continue;
        if (
          !state.placements.every((existing) =>
            clusterSeparated(
              existing,
              { ...candidate, width: item.width, height: item.height },
              gapX,
              gapY
            )
          )
        )
          continue;
        const placements = normalizeState([
          ...state.placements,
          {
            ...item,
            ...candidate,
            row: 0,
            column: 0,
            stackIndex,
            deckDepth: 0,
          },
        ]);
        const frame = stateBounds(placements);
        if (frame.width > usableWidth || frame.height > usableHeight) continue;
        const key = [...placements]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((placement) => `${placement.id}:${placement.x}:${placement.y}`)
          .join('|');
        const next = { placements };
        const previous = nextByGeometry.get(key);
        if (!previous || compareStates(next, previous) < 0) nextByGeometry.set(key, next);
      }
    }
    beam = [...nextByGeometry.values()].sort(compareStates).slice(0, COMPACT_LAYOUT_BEAM_WIDTH);
    if (beam.length === 0) {
      // Preserve the all-or-nothing contract used by bounded zone layout: an
      // unsuccessful solve still returns deterministic collision-free
      // geometry, but names every rectangle outside the requested frame so
      // callers can refuse the write without partially moving anything.
      const fallback = layoutCompactRectangles(sourceItems, { ...options, bounds: undefined });
      return {
        ...fallback,
        overflowingItemIds: bounds ? overflowingIds(fallback.placements, bounds) : [],
      };
    }
  }

  const placed = beam.sort(compareStates)[0]?.placements;
  if (!placed) throw new Error('Unable to select a compact rectangle layout.');

  const rowYs = [...new Set(placed.map((item) => item.y))].sort((a, b) => a - b);
  const rowByY = new Map(rowYs.map((y, row) => [y, row]));
  const placementById = new Map(placed.map((placement) => [placement.id, placement]));
  const placements = items.map((source, index) => {
    const item = placementById.get(source.id);
    if (!item) throw new Error(`Missing compact placement for rectangle '${source.id}'.`);
    const { sourceX: _sourceX, sourceY: _sourceY, ...geometry } = item;
    return {
      ...geometry,
      x: item.x + padding,
      y: item.y + padding,
      row: rowByY.get(item.y) ?? 0,
      column: placed.filter((peer) => peer.y === item.y && peer.x < item.x).length,
      stackIndex: index,
    };
  });
  const contentWidth = Math.max(...placed.map((item) => item.x + item.width));
  const contentHeight = Math.max(...placed.map((item) => item.y + item.height));
  const columns = Math.max(1, ...rowYs.map((y) => placed.filter((item) => item.y === y).length));
  return {
    mode: 'cluster',
    placements,
    columns,
    rows: rowYs.length,
    width: contentWidth + padding * 2,
    height: contentHeight + padding * 2,
    gapX,
    gapY,
    padding,
    fitsWithoutOverlap: true,
    stackCount: items.length,
    maxDeckDepth: 1,
    deckOffsetX: 0,
    deckOffsetY: 0,
    overflowingItemIds: bounds ? overflowingIds(placements, bounds) : [],
  };
}

export type SelectionAlignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

export interface SelectionAlignmentOptions {
  gap?: number;
  gridSize?: number;
}

/**
 * Align heterogeneous free-canvas rectangles without collapsing them onto one
 * another. The requested edge/center is shared, while the perpendicular axis
 * keeps its spatial order and only moves later rectangles far enough to clear
 * the preceding rectangle. This makes the first spatial item an intuitive
 * anchor and gives the smallest deterministic forward shift for every peer.
 */
export function layoutAlignedRectangles(
  sourceItems: readonly CompactRectangleLayoutItem[],
  alignment: SelectionAlignment,
  options: SelectionAlignmentOptions = {}
): RectanglePlacement[] {
  if (sourceItems.length === 0) return [];
  const gridSize = finiteNonNegative(options.gridSize, 0);
  const snap = (value: number) =>
    gridSize > 0 ? Math.round((Number.isFinite(value) ? value : 0) / gridSize) * gridSize : value;
  const gap = ceilToGrid(finiteNonNegative(options.gap, 0), gridSize);
  const items = sourceItems.map((item) => ({
    ...item,
    width: ceilToGrid(Math.max(1, finiteNonNegative(item.width, BOARD_GRID_SIZE)), gridSize),
    height: ceilToGrid(Math.max(1, finiteNonNegative(item.height, BOARD_GRID_SIZE)), gridSize),
    sourceX: snap(item.sourceX ?? 0),
    sourceY: snap(item.sourceY ?? 0),
  }));
  const horizontal = alignment === 'left' || alignment === 'center' || alignment === 'right';
  const left = Math.min(...items.map((item) => item.sourceX));
  const right = Math.max(...items.map((item) => item.sourceX + item.width));
  const top = Math.min(...items.map((item) => item.sourceY));
  const bottom = Math.max(...items.map((item) => item.sourceY + item.height));
  const ordered = [...items].sort((a, b) =>
    horizontal
      ? a.sourceY - b.sourceY || a.sourceX - b.sourceX || a.id.localeCompare(b.id)
      : a.sourceX - b.sourceX || a.sourceY - b.sourceY || a.id.localeCompare(b.id)
  );
  const placements: RectanglePlacement[] = [];
  let nextPerpendicular = Number.NEGATIVE_INFINITY;

  for (const [index, item] of ordered.entries()) {
    const x =
      alignment === 'left'
        ? left
        : alignment === 'center'
          ? snap((left + right - item.width) / 2)
          : alignment === 'right'
            ? right - item.width
            : Math.max(item.sourceX, nextPerpendicular);
    const y =
      alignment === 'top'
        ? top
        : alignment === 'middle'
          ? snap((top + bottom - item.height) / 2)
          : alignment === 'bottom'
            ? bottom - item.height
            : Math.max(item.sourceY, nextPerpendicular);
    placements.push({
      id: item.id,
      width: item.width,
      height: item.height,
      x,
      y,
      row: horizontal ? index : 0,
      column: horizontal ? 0 : index,
      stackIndex: index,
      deckDepth: 0,
    });
    nextPerpendicular = (horizontal ? y + item.height : x + item.width) + gap;
  }

  const byId = new Map(placements.map((placement) => [placement.id, placement]));
  return sourceItems.flatMap((item) => {
    const placement = byId.get(item.id);
    return placement ? [placement] : [];
  });
}

/**
 * Translate one already-planned selection cluster around fixed board peers.
 *
 * Grid/compact planners remain responsible for the cluster's internal shape.
 * This shared final step treats that shape as a rigid body and searches the
 * nearest grid-aligned origin that clears every unselected obstacle. Because
 * only one translation is applied, row partitioning, gaps, spatial order, and
 * heterogeneous measured sizes cannot be distorted while avoiding peers.
 */
export function placeLayoutAroundFixedObstacles<T extends RectanglePlacement>(
  sourcePlacements: readonly T[],
  options: ObstacleAwareLayoutOptions
): ObstacleAwareLayoutResult<T> {
  const gridSize = finiteNonNegative(options.gridSize, 0);
  const snap = (value: number): number =>
    gridSize > 0 ? Math.round(value / gridSize) * gridSize : value;
  const gapX = ceilToGrid(finiteNonNegative(options.gapX, 0), gridSize);
  const gapY = ceilToGrid(finiteNonNegative(options.gapY, 0), gridSize);
  const desiredOrigin = {
    x: snap(options.desiredOrigin.x),
    y: snap(options.desiredOrigin.y),
  };
  if (sourcePlacements.length === 0) {
    return { placements: [], origin: desiredOrigin, width: 0, height: 0 };
  }

  for (const placement of sourcePlacements) {
    if (
      !Number.isFinite(placement.x) ||
      !Number.isFinite(placement.y) ||
      !Number.isFinite(placement.width) ||
      !Number.isFinite(placement.height) ||
      placement.width <= 0 ||
      placement.height <= 0
    ) {
      throw new Error(`Layout placement '${placement.id}' has invalid geometry.`);
    }
  }
  const minX = Math.min(...sourcePlacements.map((placement) => placement.x));
  const minY = Math.min(...sourcePlacements.map((placement) => placement.y));
  const maxX = Math.max(...sourcePlacements.map((placement) => placement.x + placement.width));
  const maxY = Math.max(...sourcePlacements.map((placement) => placement.y + placement.height));
  const relative = sourcePlacements.map((placement) => ({
    placement,
    x: placement.x - minX,
    y: placement.y - minY,
  }));
  const width = maxX - minX;
  const height = maxY - minY;
  const obstacles = [...(options.obstacles ?? [])]
    .map((obstacle) => {
      if (
        !Number.isFinite(obstacle.x) ||
        !Number.isFinite(obstacle.y) ||
        !Number.isFinite(obstacle.width) ||
        !Number.isFinite(obstacle.height) ||
        obstacle.width <= 0 ||
        obstacle.height <= 0
      ) {
        throw new Error(`Layout obstacle '${obstacle.id}' has invalid geometry.`);
      }
      return obstacle;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const insideBounds = (origin: { x: number; y: number }): boolean => {
    const bounds = options.bounds;
    return (
      !bounds ||
      (origin.x >= bounds.x &&
        origin.y >= bounds.y &&
        origin.x + width <= bounds.x + bounds.width &&
        origin.y + height <= bounds.y + bounds.height)
    );
  };
  const firstCollision = (origin: { x: number; y: number }) => {
    for (const obstacle of obstacles) {
      const obstacleLeft = obstacle.x - gapX;
      const obstacleRight = obstacle.x + obstacle.width + gapX;
      const obstacleTop = obstacle.y - gapY;
      const obstacleBottom = obstacle.y + obstacle.height + gapY;
      for (const entry of relative) {
        const left = origin.x + entry.x;
        const top = origin.y + entry.y;
        if (
          left < obstacleRight &&
          left + entry.placement.width > obstacleLeft &&
          top < obstacleBottom &&
          top + entry.placement.height > obstacleTop
        ) {
          return { obstacle, entry };
        }
      }
    }
    return undefined;
  };
  const score = (origin: { x: number; y: number }) => {
    const dx = origin.x - desiredOrigin.x;
    const dy = origin.y - desiredOrigin.y;
    return [
      dx * dx + dy * dy,
      Math.abs(dx) + Math.abs(dy),
      Math.abs(dy),
      Math.abs(dx),
      origin.y,
      origin.x,
    ];
  };
  const compareOrigins = (left: { x: number; y: number }, right: { x: number; y: number }) => {
    const leftScore = score(left);
    const rightScore = score(right);
    for (let index = 0; index < leftScore.length; index += 1) {
      const difference = leftScore[index] - rightScore[index];
      if (difference !== 0) return difference;
    }
    return 0;
  };
  const key = (origin: { x: number; y: number }) => `${origin.x}:${origin.y}`;
  const queue = [desiredOrigin];
  const queued = new Set([key(desiredOrigin)]);
  const maxCandidates = Math.max(1, Math.floor(options.maxCandidates ?? 8192));
  let visited = 0;

  while (queue.length > 0 && visited < maxCandidates) {
    queue.sort(compareOrigins);
    const origin = queue.shift();
    if (!origin) break;
    visited += 1;
    if (!insideBounds(origin)) continue;
    const collision = firstCollision(origin);
    if (!collision) {
      return {
        placements: relative.map(({ placement, x, y }) => ({
          ...placement,
          x: origin.x + x,
          y: origin.y + y,
        })),
        origin,
        width,
        height,
      };
    }

    const { obstacle, entry } = collision;
    const candidates = [
      { x: obstacle.x - gapX - entry.x - entry.placement.width, y: origin.y },
      { x: obstacle.x + obstacle.width + gapX - entry.x, y: origin.y },
      { x: origin.x, y: obstacle.y - gapY - entry.y - entry.placement.height },
      { x: origin.x, y: obstacle.y + obstacle.height + gapY - entry.y },
    ].map(({ x, y }) => ({ x: snap(x), y: snap(y) }));
    for (const candidate of candidates) {
      const candidateKey = key(candidate);
      if (queued.has(candidateKey)) continue;
      queued.add(candidateKey);
      queue.push(candidate);
    }
  }

  throw new LayoutObstacleError();
}
