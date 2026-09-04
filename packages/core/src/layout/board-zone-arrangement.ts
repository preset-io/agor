import type {
  BoardEntityType,
  BoardPosition,
  LayoutDensityPolicy,
  ZoneLayoutPolicy,
} from '../types/board.js';
import {
  type JustifiedZoneResult,
  layoutJustifiedZones,
  zoneShapesForItems,
} from './justified-zones.js';
import {
  BOARD_GRID_SIZE,
  type CompactRectangleLayoutResult,
  ceilBoardGridValue,
  layoutCompactRectangles,
  layoutRectangles,
  placeLayoutAroundFixedObstacles,
  type RectanglePlacement,
} from './rectangle-packing.js';
import {
  compactZoneItemSize,
  getZoneLayoutFrame,
  isBoardEntityDensityExpandable,
  layoutCompactTarget,
  normalizeZoneLayoutPolicy,
  sortZoneLayoutItems,
  type ZoneLayoutSortItem,
} from './zone-layout.js';

export const DEFAULT_BOARD_ZONE_ARRANGEMENT = Object.freeze({
  targetWidth: 1600,
  targetRowHeight: 600,
  gap: 40,
  startX: 80,
  startY: 80,
  justifyLastRow: false,
});

/** Empty explicit packs return to the ordinary seeded/creation width. */
export const EMPTY_PACKED_ZONE_SIZE = Object.freeze({ width: 600, height: 240 });

export interface BoardZoneArrangementItem extends ZoneLayoutSortItem {
  /** Present for branch/card placements; canvas nodes keep their natural size. */
  entityType?: BoardEntityType;
  width: number;
  height: number;
  compact?: boolean;
  /** Definitive rendered density capability; required to compact generic cards. */
  densityExpandable?: boolean;
  /** Natural expanded geometry used when an explicit Expand starts collapsed. */
  expandedSize?: { width: number; height: number };
}

export interface BoardZoneArrangementInput {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize?: number;
  /** Inverse canvas zoom for screen-stable zone title geometry. */
  fontScale?: number;
  status?: string;
  layout?: Partial<ZoneLayoutPolicy>;
  items: readonly BoardZoneArrangementItem[];
}

export interface BoardZoneArrangementLooseItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  entityType?: BoardEntityType;
  compact?: boolean;
  densityExpandable?: boolean;
  expandedSize?: { width: number; height: number };
}

export interface BoardZoneArrangementOptions {
  /** One outer-board presentation shared by UI selection, toolbar, and MCP. */
  mode?: 'grid' | 'compact';
  /** Orthogonal presentation intent. Omitted uses each zone policy; preserve is recommended. */
  density?: LayoutDensityPolicy;
  /** Usable viewport aspect; target size is then derived from content area. */
  targetAspectRatio?: number;
  targetWidth?: number;
  targetHeight?: number;
  targetRowHeight?: number;
  gap?: number;
  startX?: number;
  startY?: number;
  maxPerRow?: number;
  /** Exact outer grid columns for an explicit selection layout. */
  fixedItemsPerRow?: number;
  /** Preserve measured compact tracks for an explicit selection grid. */
  compactFixedGrid?: boolean;
  /** Pack final heterogeneous zone frames without justified row-track slack. */
  compactOuterLayout?: boolean;
  /** Stretch complete rows toward targetWidth. Defaults to true in Grid. */
  justifyRows?: boolean;
  justifyLastRow?: boolean;
  /** Give every zone in an outer row the row's tallest final frame. */
  matchRowHeights?: boolean;
  /** Give every zone in an outer column that column's widest final frame. */
  matchColumnWidths?: boolean;
  /** Master switch for changing zone frames. Pack still grows unsafe frames. */
  resizeZoneFrames?: boolean;
  /** Alignment for a short, non-justified final row. */
  lastRowAlignment?: 'start' | 'center' | 'end';
  /** Free top-level board nodes packed beside the content-sized zone frames. */
  looseItems?: readonly BoardZoneArrangementLooseItem[];
  /** Unselected visible peers that selection-scoped layout may not move or overlap. */
  fixedObstacles?: readonly BoardZoneArrangementLooseItem[];
  /** Center the compact result on the source selection rather than a board-wide origin. */
  anchorToSelectionBounds?: boolean;
  /**
   * Re-pack each eligible zone before arranging the resulting outer frames.
   * Defaults to true for the explicit Arrange board/MCP operation. Set false
   * to preserve every zone frame and child-relative placement while arranging
   * only the top-level board objects.
   */
  packZoneContents?: boolean;
}

export interface BoardZoneArrangementPlacement extends RectanglePlacement {
  compact?: boolean;
}

export interface ArrangedBoardZone {
  id: string;
  position: BoardPosition;
  width: number;
  height: number;
  row: number;
  column: number;
  contentColumns: number;
  slackY: number;
  items: BoardZoneArrangementPlacement[];
}

export interface BoardZoneArrangementPlan {
  layout: JustifiedZoneResult;
  zones: ArrangedBoardZone[];
  looseItems: BoardZoneArrangementPlacement[];
  /** Present when the operation also packed free top-level board nodes. */
  boardLayout?: CompactRectangleLayoutResult;
}

const gridGap = (value: number): number =>
  value === 0 ? 0 : Math.max(BOARD_GRID_SIZE, ceilBoardGridValue(value));

const exactGap = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

export interface BoardZoneMembershipRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Resolve geometric canvas membership consistently in the browser and MCP.
 *
 * Legacy canvas objects have no persisted zone id. The center remains the
 * ordinary membership signal, but an object whose top-left anchor is inside a
 * too-small zone is also a child: otherwise the exact protrusion that Pack is
 * meant to repair is misclassified as a loose board object. Smallest-area then
 * stable-id tie-breaking matches nested/overlapping-zone behavior everywhere.
 */
export function containingBoardZoneId(
  item: Omit<BoardZoneMembershipRect, 'id'>,
  zones: readonly BoardZoneMembershipRect[]
): string | undefined {
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  return [...zones]
    .filter(
      (zone) =>
        (centerX >= zone.x &&
          centerX <= zone.x + zone.width &&
          centerY >= zone.y &&
          centerY <= zone.y + zone.height) ||
        (item.x >= zone.x &&
          item.x <= zone.x + zone.width &&
          item.y >= zone.y &&
          item.y <= zone.y + zone.height)
    )
    .sort(
      (left, right) =>
        left.width * left.height - right.width * right.height || left.id.localeCompare(right.id)
    )[0]?.id;
}

/**
 * Plan both levels of a board-zone arrange as one deterministic operation.
 *
 * Callers supply measured visible child rectangles and persist the returned
 * geometry. Keeping the solver here makes the browser action and MCP tool use
 * identical defaults, row breaking, zone shapes, and final child packing.
 */
export function planBoardZoneArrangement(
  sourceZones: readonly BoardZoneArrangementInput[],
  options: BoardZoneArrangementOptions = {}
): BoardZoneArrangementPlan {
  const packZoneContents = options.packZoneContents !== false;
  const mode = options.mode ?? (options.compactOuterLayout ? 'compact' : 'grid');
  const resizeZoneFrames = packZoneContents && options.resizeZoneFrames !== false;
  const outerGap = gridGap(options.gap ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.gap);
  // Callers provide the persisted logical order. Sorting it by the geometry
  // this function is about to replace makes row order feed back into the next
  // invocation (and lets Arrange oscillate between two valid grids).
  const orderedZones = [...sourceZones];
  const orderedLooseItems = [...(options.looseItems ?? [])];
  const zoneIds = new Set(orderedZones.map((zone) => zone.id));
  const duplicateId = orderedLooseItems.find((item) => zoneIds.has(item.id));
  if (duplicateId)
    throw new Error(`Board layout item '${duplicateId.id}' conflicts with a zone id.`);

  const prepared = orderedZones.map((zone) => {
    const policy = normalizeZoneLayoutPolicy(zone.layout);
    const density = packZoneContents ? (options.density ?? policy.density) : 'preserve';
    const frame = getZoneLayoutFrame(zone, { fontScale: zone.fontScale });
    const orderedItems =
      policy.preset === 'grid' && policy.columns === undefined && policy.sortBy === 'position'
        ? [...zone.items]
        : sortZoneLayoutItems(zone.items, policy);
    // A compact list is full-width *within its own natural content frame*, not
    // within the zone's previous (or newly justified) outer frame. Deriving
    // this width from frame.usableWidth creates a feedback loop: every outer
    // row stretch widens the compact children, which widens the next explicit
    // Arrange again. The largest measured/fallback child is a stable natural
    // width and still gives the list one aligned track.
    const compactListWidth = ceilBoardGridValue(
      Math.max(BOARD_GRID_SIZE, ...orderedItems.map((item) => item.width))
    );
    const compactById = new Map<string, boolean | undefined>();
    const items = orderedItems.map((item) => {
      const densityExpandable = Boolean(
        item.entityType &&
          (item.densityExpandable ?? isBoardEntityDensityExpandable(item.entityType))
      );
      const compact = layoutCompactTarget(density, item.compact, densityExpandable);
      compactById.set(item.id, compact);
      const size =
        compact === true && item.entityType
          ? compactZoneItemSize(item.entityType, compactListWidth)
          : compact === false && item.compact === true && item.expandedSize
            ? item.expandedSize
            : { width: item.width, height: item.height };
      return {
        id: item.id,
        ...size,
        sourceX: item.position.x,
        sourceY: item.position.y - frame.headerInset,
      };
    });
    const gap = exactGap(policy.gap ?? 24);
    const compact =
      packZoneContents && policy.preset === 'grid' && policy.columns === undefined
        ? layoutCompactRectangles(items, {
            padding: frame.padding,
            gapX: gap,
            gapY: gap,
            gridSize: BOARD_GRID_SIZE,
            preserveInputOrder: true,
          })
        : undefined;
    const shapes = !packZoneContents
      ? [{ columns: 1, width: zone.width, height: zone.height }]
      : items.length === 0
        ? [{ columns: 1, ...EMPTY_PACKED_ZONE_SIZE }]
        : compact
          ? [
              {
                columns: compact.columns,
                width: Math.max(400, ceilBoardGridValue(compact.width)),
                height: Math.max(240, ceilBoardGridValue(compact.height + frame.headerInset)),
              },
            ]
          : zoneShapesForItems(items, {
              titleInset: frame.headerInset,
              padding: frame.padding,
              gapX: gap,
              gapY: gap,
              maxColumns: policy.preset === 'compact_list' ? 1 : policy.columns,
              gridSize: BOARD_GRID_SIZE,
            });
    return { zone, policy, frame, orderedItems, items, shapes, gap, compact, compactById };
  });
  const preparedById = new Map(prepared.map((entry) => [entry.zone.id, entry]));
  const preparedLooseItems = orderedLooseItems.map((item) => {
    const densityExpandable = Boolean(
      item.entityType && (item.densityExpandable ?? isBoardEntityDensityExpandable(item.entityType))
    );
    const compact = layoutCompactTarget(
      packZoneContents ? (options.density ?? 'preserve') : 'preserve',
      item.compact,
      densityExpandable
    );
    const size =
      compact === true && item.entityType
        ? compactZoneItemSize(item.entityType, item.width)
        : compact === false && item.compact === true && item.expandedSize
          ? item.expandedSize
          : { width: item.width, height: item.height };
    return { ...item, ...size, compact };
  });

  const compactShapeById = new Map(
    prepared.map((entry) => {
      const shape = [...entry.shapes].sort(
        (left, right) =>
          Math.max(left.width, left.height) - Math.max(right.width, right.height) ||
          left.width * left.height - right.width * right.height ||
          left.columns - right.columns
      )[0];
      if (!shape) throw new Error(`Zone '${entry.zone.id}' has no content-safe frame.`);
      return [entry.zone.id, shape] as const;
    })
  );

  const sourceRoots = [
    ...orderedZones.map((zone) => ({
      id: zone.id,
      x: zone.x,
      y: zone.y,
      width: zone.width,
      height: zone.height,
      kind: 'zone' as const,
    })),
    ...preparedLooseItems.map((item) => ({ ...item, kind: 'loose' as const })),
  ];

  const targetAspect =
    Number.isFinite(options.targetAspectRatio) && (options.targetAspectRatio ?? 0) > 0
      ? Math.max(0.5, Math.min(3, options.targetAspectRatio as number))
      : undefined;
  const estimatedArea = sourceRoots.reduce((total, root) => {
    const shapes = preparedById.get(root.id)?.shapes;
    const shape = shapes?.reduce((best, candidate) =>
      candidate.width * candidate.height < best.width * best.height ? candidate : best
    );
    return total + (shape ? shape.width * shape.height : root.width * root.height);
  }, 0);
  const targetWidth =
    options.targetWidth ??
    (targetAspect
      ? Math.max(
          0,
          ...sourceRoots.map((root) =>
            Math.min(...(preparedById.get(root.id)?.shapes ?? [root]).map((shape) => shape.width))
          ),
          ceilBoardGridValue(Math.sqrt(Math.max(1, estimatedArea) * 1.25 * targetAspect))
        )
      : DEFAULT_BOARD_ZONE_ARRANGEMENT.targetWidth);
  const targetHeight =
    options.targetHeight ??
    (targetAspect ? ceilBoardGridValue(targetWidth / targetAspect) : undefined);

  const gridLayout =
    mode === 'grid'
      ? layoutJustifiedZones(
          sourceRoots.map((root) => {
            const entry = preparedById.get(root.id);
            return {
              id: root.id,
              shapes: entry?.shapes ?? [{ columns: 1, width: root.width, height: root.height }],
              resizable: Boolean(entry && resizeZoneFrames),
            };
          }),
          {
            targetWidth,
            targetRowHeight:
              options.targetRowHeight ??
              (targetHeight
                ? Math.max(
                    240,
                    targetHeight /
                      Math.max(
                        1,
                        Math.ceil(Math.sqrt(sourceRoots.length * (targetHeight / targetWidth)))
                      )
                  )
                : DEFAULT_BOARD_ZONE_ARRANGEMENT.targetRowHeight),
            gap: outerGap,
            startX: 0,
            startY: 0,
            maxPerRow: options.maxPerRow,
            fixedItemsPerRow: options.fixedItemsPerRow,
            stretchFixedTracks: options.compactFixedGrid !== true,
            justifyRows: options.justifyRows !== false,
            justifyLastRow: options.justifyLastRow ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.justifyLastRow,
            lastRowAlignment: options.lastRowAlignment ?? 'start',
            matchRowHeights: resizeZoneFrames && options.matchRowHeights !== false,
            gridSize: BOARD_GRID_SIZE,
          }
        )
      : undefined;
  const gridPlacementById = new Map(
    gridLayout?.placements.map((placement) => [placement.id, placement]) ?? []
  );

  const selectedShapeById = new Map(
    prepared.map((entry) => {
      const gridPlacement = gridPlacementById.get(entry.zone.id);
      const preferred =
        gridPlacement === undefined
          ? compactShapeById.get(entry.zone.id)
          : entry.shapes
              .filter((shape) => shape.columns === gridPlacement.columns)
              .sort(
                (left, right) =>
                  Math.abs(left.height - (gridPlacement.height - gridPlacement.slackY)) -
                    Math.abs(right.height - (gridPlacement.height - gridPlacement.slackY)) ||
                  left.width - right.width
              )[0];
      if (!preferred) throw new Error(`Missing selected shape for zone '${entry.zone.id}'.`);
      return [entry.zone.id, preferred] as const;
    })
  );

  const finalFrameById = new Map(
    prepared.map((entry) => {
      const shape = selectedShapeById.get(entry.zone.id);
      if (!shape) throw new Error(`Missing final shape for zone '${entry.zone.id}'.`);
      const placement = gridPlacementById.get(entry.zone.id);
      if (!packZoneContents) {
        return [entry.zone.id, { width: entry.zone.width, height: entry.zone.height }] as const;
      }
      if (resizeZoneFrames && placement) {
        return [
          entry.zone.id,
          {
            width: options.matchColumnWidths === false ? shape.width : placement.width,
            height: options.matchRowHeights === false ? shape.height : placement.height,
          },
        ] as const;
      }
      if (resizeZoneFrames) {
        return [entry.zone.id, { width: shape.width, height: shape.height }] as const;
      }
      // The OFF control preserves a safe manual frame. A frame that is already
      // too small still grows just enough; Pack may never leave protruding children.
      return [
        entry.zone.id,
        {
          width: Math.max(entry.zone.width, shape.width),
          height: Math.max(entry.zone.height, shape.height),
        },
      ] as const;
    })
  );

  const rootFrames = sourceRoots.map((root) => {
    const frame = finalFrameById.get(root.id);
    return { ...root, ...(frame ?? { width: root.width, height: root.height }) };
  });
  const compactLayout =
    mode === 'compact'
      ? layoutCompactRectangles(
          rootFrames.map((root) => ({
            id: root.id,
            width: root.width,
            height: root.height,
            sourceX: root.x,
            sourceY: root.y,
          })),
          { gapX: outerGap, gapY: outerGap, gridSize: BOARD_GRID_SIZE }
        )
      : undefined;

  const unpositioned = mode === 'compact' ? compactLayout?.placements : gridLayout?.placements;
  if (!unpositioned) throw new Error('Missing outer board layout.');
  const rootFrameById = new Map(rootFrames.map((root) => [root.id, root]));
  const collisionFootprint: RectanglePlacement[] = unpositioned.map((placement, index) => {
    const frame = rootFrameById.get(placement.id);
    return {
      ...placement,
      ...(frame ? { width: frame.width, height: frame.height } : {}),
      stackIndex: 'stackIndex' in placement ? placement.stackIndex : index,
      deckDepth: 'deckDepth' in placement ? placement.deckDepth : 0,
    };
  });
  const sourceLeft = sourceRoots.length > 0 ? Math.min(...sourceRoots.map((root) => root.x)) : 0;
  const sourceTop = sourceRoots.length > 0 ? Math.min(...sourceRoots.map((root) => root.y)) : 0;
  const sourceRight =
    sourceRoots.length > 0 ? Math.max(...sourceRoots.map((root) => root.x + root.width)) : 0;
  const sourceBottom =
    sourceRoots.length > 0 ? Math.max(...sourceRoots.map((root) => root.y + root.height)) : 0;
  const targetLeft =
    collisionFootprint.length > 0
      ? Math.min(...collisionFootprint.map((placement) => placement.x))
      : 0;
  const targetTop =
    collisionFootprint.length > 0
      ? Math.min(...collisionFootprint.map((placement) => placement.y))
      : 0;
  const targetRight =
    collisionFootprint.length > 0
      ? Math.max(...collisionFootprint.map((placement) => placement.x + placement.width))
      : 0;
  const targetBottom =
    collisionFootprint.length > 0
      ? Math.max(...collisionFootprint.map((placement) => placement.y + placement.height))
      : 0;
  const desiredOrigin = options.anchorToSelectionBounds
    ? {
        x: (sourceLeft + sourceRight - (targetRight - targetLeft)) / 2,
        y: (sourceTop + sourceBottom - (targetBottom - targetTop)) / 2,
      }
    : {
        x: options.startX ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.startX,
        y: options.startY ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.startY,
      };
  const positioned = placeLayoutAroundFixedObstacles(collisionFootprint, {
    desiredOrigin,
    obstacles: options.fixedObstacles,
    gapX: outerGap,
    gapY: outerGap,
    gridSize: BOARD_GRID_SIZE,
  });
  const rootPlacementById = new Map(
    positioned.placements.map((placement) => [placement.id, placement])
  );
  const stableRootIndexById = new Map(
    [...sourceRoots]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((root, index) => [root.id, index])
  );

  const layout: JustifiedZoneResult = gridLayout
    ? {
        ...gridLayout,
        placements: gridLayout.placements.map((placement) => {
          const positionedPlacement = rootPlacementById.get(placement.id);
          return positionedPlacement
            ? { ...placement, x: positionedPlacement.x, y: positionedPlacement.y }
            : placement;
        }),
      }
    : {
        placements: positioned.placements.map((placement) => ({
          ...placement,
          columns: selectedShapeById.get(placement.id)?.columns ?? 1,
          slackY: 0,
        })),
        rows: compactLayout?.rows ?? 0,
        width: compactLayout?.width ?? 0,
        height: compactLayout?.height ?? 0,
        gap: outerGap,
        rowHeights: [...new Set(positioned.placements.map((placement) => placement.y))]
          .sort((left, right) => left - right)
          .map((y) =>
            Math.max(
              ...positioned.placements
                .filter((placement) => placement.y === y)
                .map((placement) => placement.height)
            )
          ),
        overflowingRows: [],
      };

  const zones = prepared.map((entry): ArrangedBoardZone => {
    const root = rootPlacementById.get(entry.zone.id);
    const finalFrame = finalFrameById.get(entry.zone.id);
    const shape = selectedShapeById.get(entry.zone.id);
    if (!root || !finalFrame || !shape) {
      throw new Error(`Missing final arrangement for zone '${entry.zone.id}'.`);
    }
    const frame = getZoneLayoutFrame(
      { ...entry.zone, width: finalFrame.width },
      { fontScale: entry.zone.fontScale }
    );
    // Reuse the natural sizes prepared before outer-frame justification.
    // Recomputing compact-list widths from finalFrame would make child content
    // scale with the container and destroy idempotence.
    const items = entry.items;
    const packed = !packZoneContents
      ? {
          columns: 1,
          placements: entry.orderedItems.map((item, index) => ({
            id: item.id,
            x: item.position.x,
            y: item.position.y,
            width: item.width,
            height: item.height,
            row: 0,
            column: index,
            stackIndex: index,
            deckDepth: 0,
          })),
          overflowingItemIds: [] as string[],
        }
      : entry.policy.preset === 'grid' && entry.policy.columns === undefined
        ? layoutCompactRectangles(items, {
            bounds: { width: finalFrame.width, height: finalFrame.height - frame.headerInset },
            padding: frame.padding,
            gapX: entry.gap,
            gapY: entry.gap,
            gridSize: BOARD_GRID_SIZE,
            preserveInputOrder: true,
          })
        : layoutRectangles(items, {
            bounds: { width: finalFrame.width, height: finalFrame.height - frame.headerInset },
            padding: frame.padding,
            minPadding: frame.padding,
            gapX: entry.gap,
            gapY: entry.gap,
            minGapX: entry.gap,
            minGapY: entry.gap,
            exactColumns: Math.max(1, Math.min(items.length || 1, shape.columns)),
            allowDeck: false,
            gridSize: BOARD_GRID_SIZE,
          });
    if (packed.overflowingItemIds.length > 0) {
      throw new Error(
        `Zone '${entry.zone.id}' shape did not contain ${packed.overflowingItemIds.join(', ')}.`
      );
    }
    return {
      id: entry.zone.id,
      position: { x: root.x, y: root.y },
      width: finalFrame.width,
      height: finalFrame.height,
      row: root.row,
      column: root.column,
      contentColumns: packed.columns,
      slackY: Math.max(0, root.height - finalFrame.height),
      items: packed.placements.map((item) => {
        // Source coordinates are solver hints, not durable output geometry.
        // Omitting them also makes a repeated plan structurally idempotent.
        const {
          sourceX: _sourceX,
          sourceY: _sourceY,
          ...placement
        } = item as RectanglePlacement & {
          sourceX?: number;
          sourceY?: number;
        };
        return {
          ...placement,
          y: packZoneContents ? placement.y + frame.headerInset : placement.y,
          ...(entry.compactById.get(placement.id) === undefined
            ? {}
            : { compact: entry.compactById.get(placement.id) }),
        };
      }),
    };
  });

  const looseItems = preparedLooseItems.map((item) => {
    const placement = rootPlacementById.get(item.id);
    if (!placement) throw new Error(`Missing placement for board item '${item.id}'.`);
    return {
      ...placement,
      width: item.width,
      height: item.height,
      ...(item.compact === undefined ? {} : { compact: item.compact }),
      stackIndex: stableRootIndexById.get(item.id) ?? placement.stackIndex,
    };
  });

  return {
    layout,
    zones,
    looseItems,
    ...(compactLayout ? { boardLayout: compactLayout } : {}),
  };
}
