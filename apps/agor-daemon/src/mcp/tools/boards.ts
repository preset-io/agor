import {
  type BoardZoneArrangementPlan,
  containingBoardZoneId,
  planBoardZoneArrangement,
} from '@agor/core/layout/board-zone-arrangement';
import {
  BOARD_GRID_SIZE,
  ceilBoardGridSize,
  ceilBoardGridValue,
  layoutCompactRectangles,
  layoutRectangles,
  snapBoardGridValue,
} from '@agor/core/layout/rectangle-packing';
import { planZoneGrowthReflow } from '@agor/core/layout/zone-growth-reflow';
import {
  BOARD_DENSITY_EXPANDABLE_ENTITY_TYPES,
  compactZoneItemSize,
  estimateExpandedGenericCardHeight,
  GENERIC_BOARD_CARD_LAYOUT,
  getZoneLayoutFrame,
  growZoneLayoutHeight,
  isBoardEntityDensityExpandable,
  layoutCompactTarget,
  normalizeZoneLayoutPolicy,
  setZoneLayoutMode,
  sortZoneLayoutItems,
  ZONE_LAYOUT_MODES,
  ZONE_LAYOUT_PRESETS,
  ZONE_LAYOUT_SORT_DIRECTIONS,
  ZONE_LAYOUT_SORT_FIELDS,
  ZONE_OVERFLOW_STRATEGIES,
  ZONE_RESIZE_MODES,
  type ZoneLayoutSortItem,
  zoneLayoutBinding,
} from '@agor/core/layout/zone-layout';
import type {
  Board,
  BoardEntityObject,
  BoardEntityType,
  BoardLayoutPlacementUpdate,
  BoardObject,
  BoardObjectType,
  Branch,
  BranchID,
  Card,
  LayoutDensityPolicy,
  ZoneLayoutPolicy,
} from '@agor/core/types';
import { BRANCH_PERMISSION_LEVELS } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { BoardsServiceImpl } from '../../declarations.js';
import { emitServiceEvent } from '../../utils/emit-service-event.js';
import { boardCapabilityPoliciesSchema } from '../capability-policy-schema.js';
import {
  mcpListLimit,
  mcpOffset,
  mcpOptionalNonNegativeInt,
  mcpOptionalNumber,
  mcpOptionalPositiveInt,
  mcpOptionalString,
  mcpPageResult,
  mcpRequiredId,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope, runWithMcpTenantDatabaseWrite } from '../tenant-scope.js';

const BOARD_OBJECT_TYPES = [
  'zone',
  'text',
  'markdown',
  'app',
  'artifact',
] as const satisfies readonly BoardObjectType[];
const BOARD_ENTITY_TYPES = ['branch', 'card'] as const satisfies readonly BoardEntityType[];

// These match the rendered React Flow nodes.  Keeping the dimensions here is
// important: a zone arrange must never blindly use the branch-card spacing for
// every entity or it can place the last row below the zone.
const ARRANGE_DIMENSIONS = {
  branch: { width: 500, height: 200 },
  // A card with only a title is roughly one header row. Content adds height
  // below; using 150px as the minimum made normal cards look artificially
  // oversized and caused unnecessary deck layouts.
  card: {
    width: GENERIC_BOARD_CARD_LAYOUT.width,
    height: GENERIC_BOARD_CARD_LAYOUT.minHeight,
  },
} as const;
const DECK_OFFSET_X = 12;
const DECK_OFFSET_Y = 48;
const DEFAULT_ARRANGE_START_X = 80;
const DEFAULT_ARRANGE_START_Y = 80;
function boardGridSpacing(value: number): number {
  return value === 0 ? 0 : Math.max(BOARD_GRID_SIZE, snapBoardGridValue(value));
}

/** Density inputs are independent of the coarser canvas drag grid. */
function exactSpacing(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

type EntityLayoutMetadata = ZoneLayoutSortItem & {
  card?: Card;
  branch?: Branch;
};

async function loadEntityLayoutMetadata(
  ctx: McpContext,
  entities: readonly BoardEntityObject[]
): Promise<Map<string, EntityLayoutMetadata>> {
  const metadata = new Map<string, EntityLayoutMetadata>();
  await Promise.all(
    entities.map(async (entity) => {
      let card: Card | undefined;
      let branch: Branch | undefined;
      if (entity.card_id) {
        card = (await ctx.app.service('cards').get(entity.card_id, ctx.baseServiceParams)) as Card;
      } else if (entity.branch_id) {
        branch = (await ctx.app
          .service('branches')
          .get(entity.branch_id, ctx.baseServiceParams)) as Branch;
      }
      const cardData = card?.data ?? {};
      metadata.set(entity.object_id, {
        id: entity.object_id,
        position: entity.position,
        title: card?.title ?? branch?.name,
        createdAt: card?.created_at ?? branch?.created_at ?? entity.created_at,
        updatedAt: card?.updated_at ?? branch?.updated_at ?? entity.created_at,
        rank: typeof cardData.rank === 'number' ? cardData.rank : undefined,
        priority: cardData.priority,
        status: cardData.status ?? branch?.filesystem_status,
        card,
        branch,
      });
    })
  );
  return metadata;
}

/**
 * A persisted `size` the solver can actually lay out, or undefined.
 *
 * `size` is written by the browser once a node has been measured, so an entity
 * created over MCP legitimately has none and falls back to the nominal size for
 * its kind. A size that is present but zero, negative, or non-finite is a
 * different thing: `layoutRectangles` refuses it, and refusing it there would
 * fail the whole arrange over one bad rectangle. Discard it and fall back to
 * nominal too, reporting the id so the anomaly is visible rather than silent.
 */
function measuredSize(
  entity: Pick<BoardEntityObject, 'size'>
): { width: number; height: number } | undefined {
  const size = entity.size;
  if (!size) return undefined;
  const usable =
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0;
  return usable ? size : undefined;
}

function hasUnusableSize(entity: Pick<BoardEntityObject, 'size'>): boolean {
  return entity.size !== undefined && measuredSize(entity) === undefined;
}

type CanvasRectangle = { id: string; x: number; y: number; width: number; height: number };

function rectanglesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Zone rectangles a whole-board arrange must not lay its grid on top of.
 *
 * A zone is a container, not an annotation: dropping free-floating entities
 * into its rectangle reads as "these belong to this zone" even though the
 * arrange never pinned them. Zones that the same call is arranging are
 * excluded — they are layout items, so they move out of their own way.
 */
function zoneObstacles(board: Board, arrangingZones: boolean): CanvasRectangle[] {
  if (arrangingZones) return [];
  return Object.entries(board.objects ?? {}).flatMap(([objectId, object]) => {
    if (object.type !== 'zone') return [];
    const { x, y } = object;
    const { width, height } = getCanvasObjectDimensions(object);
    return [{ id: objectId, x, y, width, height }];
  });
}

/**
 * Zones that the given rectangle would sit on top of.
 *
 * Growing a zone to fit its contents is not free: a zone is a rectangle on a
 * shared canvas, and autoResizeHeight moves its bottom edge without asking what
 * is underneath it. A zone that silently swallows its neighbour is the same
 * class of defect this tool refuses to create *inside* a zone, so it is
 * reported rather than performed in silence. The resize still happens —
 * contents overflowing their own zone is the worse outcome — but the caller is
 * told which zones it now covers, and agor_boards_auto_arrange with
 * includeZones:true is the repair.
 */
function zonesOverlappedBy(
  board: Board,
  zoneId: string,
  rect: { x: number; y: number; width: number; height: number }
): string[] {
  return Object.entries(board.objects ?? {}).flatMap(([objectId, object]) => {
    if (objectId === zoneId || object.type !== 'zone') return [];
    const { x, y, width, height } = object;
    return rectanglesOverlap(rect, { x, y, width, height }) ? [objectId] : [];
  });
}

/**
 * Pick the grid origin for a whole-board arrange.
 *
 * An explicit `startY` is always honored — the caller asked for that row. A
 * defaulted one drops past each zone it lands on until the grid is clear,
 * which settles on the first free row rather than below the lowest zone on the
 * board: a single zone parked far down the canvas should not exile the grid
 * with it. Each pass clears every zone that was blocking, so no zone can block
 * twice and the loop terminates in at most one pass per zone.
 */
function resolveArrangeOrigin(options: {
  startX: number;
  startY: number;
  explicitStartY: boolean;
  layout: { width: number; height: number };
  gapY: number;
  obstacles: readonly CanvasRectangle[];
}): { startX: number; startY: number; avoidedZoneIds: string[] } {
  const { startX, startY, explicitStartY, layout, gapY, obstacles } = options;
  if (explicitStartY || obstacles.length === 0 || layout.width <= 0 || layout.height <= 0) {
    return { startX, startY, avoidedZoneIds: [] };
  }
  const avoidedZoneIds: string[] = [];
  let y = startY;
  for (let pass = 0; pass <= obstacles.length; pass += 1) {
    const grid = { x: startX, y, width: layout.width, height: layout.height };
    const blocking = obstacles.filter((zone) => rectanglesOverlap(grid, zone));
    if (blocking.length === 0) break;
    avoidedZoneIds.push(...blocking.map((zone) => zone.id));
    y = ceilBoardGridValue(Math.max(...blocking.map((zone) => zone.y + zone.height))) + gapY;
  }
  return { startX, startY: y, avoidedZoneIds };
}

function usableCanvasDimension(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function getCanvasObjectDimensions(object: BoardObject): { width: number; height: number } {
  if (object.type === 'text') {
    return {
      width: usableCanvasDimension(object.width, 240),
      height: usableCanvasDimension(object.height, 120),
    };
  }
  if (object.type === 'markdown') {
    const width = usableCanvasDimension(object.width, 400);
    const charsPerLine = Math.max(20, Math.floor(width / 8));
    const lines = Math.max(3, Math.ceil(object.content.length / charsPerLine));
    return { width, height: Math.max(140, 48 + lines * 20) };
  }
  if (object.type === 'app' || object.type === 'artifact' || object.type === 'zone') {
    return {
      width: usableCanvasDimension(object.width, 600),
      height: usableCanvasDimension(object.height, 400),
    };
  }
  return { width: 240, height: 120 };
}

async function filterVisibleBoardEntities(
  ctx: McpContext,
  entities: BoardEntityObject[],
  includeArchived: boolean
): Promise<BoardEntityObject[]> {
  if (includeArchived) return entities;
  const activeCardIds = new Set<string>();
  const cardIds = entities.flatMap((entity) => (entity.card_id ? [entity.card_id] : []));
  if (cardIds.length > 0) {
    const result = await ctx.app.service('cards').find({
      query: { card_id: { $in: Array.from(new Set(cardIds)) }, archived: false },
      paginate: false,
      ...ctx.baseServiceParams,
    });
    const cards = Array.isArray(result)
      ? result
      : (result as { data: Array<{ card_id: string }> }).data;
    for (const card of cards) activeCardIds.add(card.card_id);
  }
  const activeBranchIds = new Set<string>();
  const branchIds = entities.flatMap((entity) => (entity.branch_id ? [entity.branch_id] : []));
  if (branchIds.length > 0) {
    const result = await ctx.app.service('branches').find({
      query: { branch_id: { $in: Array.from(new Set(branchIds)) }, archived: false },
      paginate: false,
      ...ctx.baseServiceParams,
    });
    const branches = Array.isArray(result)
      ? result
      : (result as { data: Array<{ branch_id: string }> }).data;
    for (const branch of branches) activeBranchIds.add(branch.branch_id);
  }
  return entities.filter(
    (entity) =>
      (entity.card_id === undefined || activeCardIds.has(entity.card_id)) &&
      (entity.branch_id === undefined || activeBranchIds.has(entity.branch_id))
  );
}

function filterBoardCanvasObjects(board: Board, objectTypes?: BoardObjectType[]): Board {
  if (!objectTypes) return board;

  const allowedTypes = new Set<BoardObjectType>(objectTypes);
  const objects = Object.fromEntries(
    Object.entries(board.objects ?? {}).filter(([, object]) =>
      allowedTypes.has((object as BoardObject).type)
    )
  );

  return { ...board, objects };
}

interface ArrangeBoardZonesOptions {
  mode?: 'grid' | 'compact';
  density?: LayoutDensityPolicy;
  targetWidth?: number;
  targetRowHeight?: number;
  gap?: number;
  startX?: number;
  startY?: number;
  maxPerRow?: number;
  justifyLastRow?: boolean;
  justifyRows?: boolean;
  resizeZoneFrames?: boolean;
  lastRowAlignment?: 'start' | 'center' | 'end';
  dryRun?: boolean;
  includeLooseItems?: boolean;
  packZoneContents?: boolean;
}

type ZoneObject = BoardObject & { type: 'zone'; width: number; height: number };

interface ArrangedBoardZones {
  plan: BoardZoneArrangementPlan;
  byId: Map<
    string,
    {
      id: string;
      zone: ZoneObject;
      itemCount: number;
      entitiesById: Map<string, BoardEntityObject>;
      canvasById: Map<string, BoardObject>;
    }
  >;
}

/**
 * Lay a board's zones out in justified rows.
 *
 * Shared by `agor_boards_arrange_zones` and by the `reflow_board` overflow
 * strategy, so a zone that grows into its neighbours is repaired by exactly
 * the layout the explicit tool would have produced. Returns null when the
 * board has no eligible roots. Container, child, and loose-object geometry are planned
 * together and committed through one atomic board-layout mutation.
 */
async function arrangeBoardZones(
  ctx: McpContext,
  boardId: string,
  options: ArrangeBoardZonesOptions = {}
): Promise<ArrangedBoardZones | null> {
  const board = (await ctx.app.service('boards').get(boardId, ctx.baseServiceParams)) as Board;
  const allZoneEntries = Object.entries(board.objects ?? {}).filter(
    ([, object]) => object.type === 'zone'
  ) as [string, ZoneObject][];
  const entityResult = (await ctx.app.service('board-objects').find({
    query: { board_id: boardId },
    ...ctx.baseServiceParams,
  })) as { data: Array<BoardEntityObject> };
  const visible = await filterVisibleBoardEntities(ctx, entityResult.data, false);
  const zoneForCanvasId = new Map<string, string>();
  const membershipZones = allZoneEntries.map(([id, zone]) => ({ id, ...zone }));
  const blockedZoneIds = new Set<string>();
  for (const [objectId, object] of Object.entries(board.objects ?? {})) {
    if (object.type === 'zone') continue;
    const size = getCanvasObjectDimensions(object);
    const zoneId = containingBoardZoneId({ x: object.x, y: object.y, ...size }, membershipZones);
    if (!zoneId) continue;
    zoneForCanvasId.set(objectId, zoneId);
    if (object.type === 'artifact' && object.locked === true) blockedZoneIds.add(zoneId);
  }
  const zoneEntries = allZoneEntries.filter(
    ([zoneId, zone]) => zone.locked !== true && !blockedZoneIds.has(zoneId)
  );
  // Size each zone's contents exactly the way the zone arrange will, because a
  // shape is only useful if the zone can genuinely hold its contents at it.
  //
  // "Exactly" includes the item *order*. The packer fills row-major, so order
  // decides which items share a row and therefore how tall the zone must be:
  // three short cards followed by two worktrees packs 136px shorter than the
  // same five sorted by position, which interleaves them. Computing shapes in
  // arbitrary order sizes the zone too short, the zone is written at that
  // height, and the follow-up arrange then refuses to place anything into it.
  const zones = await Promise.all(
    zoneEntries.map(async ([zoneId, zone]) => {
      const zonePolicy = normalizeZoneLayoutPolicy(zone.layout);
      const contents = visible.filter((entity) => entity.zone_id === zoneId);
      // Sorting by anything other than position needs the card/branch records;
      // an unmeasured card needs them too, to estimate its rendered height.
      const metadata = await loadEntityLayoutMetadata(
        ctx,
        contents.filter(
          (entity) =>
            zonePolicy.sortBy !== 'position' ||
            (entity.card_id !== undefined &&
              ((options.density ?? zonePolicy.density) !== 'preserve' ||
                entity.compact === true ||
                !measuredSize(entity)))
        )
      );
      const ordered =
        zonePolicy.preset === 'grid' &&
        zonePolicy.columns === undefined &&
        zonePolicy.sortBy === 'position'
          ? contents
          : sortZoneLayoutItems(
              contents.map((entity) => ({
                entity,
                ...(metadata.get(entity.object_id) ?? {
                  id: entity.object_id,
                  position: entity.position,
                }),
              })),
              zonePolicy
            ).map(({ entity }) => entity);

      const items = ordered.map((entity) => {
        const measured = measuredSize(entity);
        const densityExpandable = isBoardEntityDensityExpandable(
          entity.entity_type,
          metadata.get(entity.object_id)?.card
        );
        const expandedSize =
          entity.entity_type === 'card'
            ? {
                width: ARRANGE_DIMENSIONS.card.width,
                height: estimateExpandedGenericCardHeight(metadata.get(entity.object_id)?.card),
              }
            : ARRANGE_DIMENSIONS.branch;
        // The authoritative planner applies explicit density after it has all
        // measured/fallback widths. Pre-sizing against the previous zone frame
        // here would reintroduce a UI/MCP divergence and a widening loop.
        if (entity.compact === true && densityExpandable) {
          return {
            id: entity.object_id,
            entityType: entity.entity_type,
            position: entity.position,
            compact: true,
            densityExpandable,
            expandedSize,
            ...compactZoneItemSize(
              entity.entity_type,
              ARRANGE_DIMENSIONS[entity.entity_type].width
            ),
          };
        }
        if (measured)
          return {
            id: entity.object_id,
            entityType: entity.entity_type,
            position: entity.position,
            compact: entity.compact,
            densityExpandable,
            expandedSize,
            ...measured,
          };
        if (entity.entity_type === 'card' && entity.card_id) {
          return {
            id: entity.object_id,
            entityType: entity.entity_type,
            position: entity.position,
            compact: entity.compact,
            densityExpandable,
            expandedSize,
            width: ARRANGE_DIMENSIONS.card.width,
            height: estimateExpandedGenericCardHeight(metadata.get(entity.object_id)?.card),
          };
        }
        return {
          id: entity.object_id,
          entityType: entity.entity_type,
          position: entity.position,
          compact: entity.compact,
          densityExpandable,
          expandedSize,
          ...ARRANGE_DIMENSIONS[entity.entity_type],
        };
      });
      const canvasById = new Map(
        Object.entries(board.objects ?? {}).filter(
          ([objectId]) => zoneForCanvasId.get(objectId) === zoneId
        )
      );
      const canvasItems = [...canvasById]
        .map(([id, object]) => ({
          id,
          position: { x: object.x - zone.x, y: object.y - zone.y },
          ...getCanvasObjectDimensions(object),
        }))
        .sort(
          (a, b) =>
            a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id)
        );

      return {
        id: zoneId,
        zone,
        itemCount: items.length + canvasItems.length,
        entitiesById: new Map(ordered.map((entity) => [entity.object_id, entity])),
        canvasById,
        x: zone.x,
        y: zone.y,
        width: zone.width,
        height: zone.height,
        fontSize: zone.fontSize,
        status: zone.status,
        layout: zonePolicy,
        items: [...items, ...canvasItems],
      };
    })
  );

  const looseEntities =
    options.includeLooseItems === false ? [] : visible.filter((entity) => !entity.zone_id);
  const looseMetadata = await loadEntityLayoutMetadata(
    ctx,
    looseEntities.filter(
      (entity) =>
        entity.entity_type === 'card' &&
        (!measuredSize(entity) || (options.density ?? 'preserve') !== 'preserve')
    )
  );
  const looseEntitiesById = new Map(looseEntities.map((entity) => [entity.object_id, entity]));
  const looseCanvasById = new Map(
    options.includeLooseItems === false
      ? []
      : Object.entries(board.objects ?? {}).filter(
          ([objectId, object]) =>
            object.type !== 'zone' &&
            !(object.type === 'artifact' && object.locked) &&
            !zoneForCanvasId.has(objectId)
        )
  );
  const looseItems = [
    ...looseEntities.map((entity) => {
      const measured = measuredSize(entity);
      const densityExpandable = isBoardEntityDensityExpandable(
        entity.entity_type,
        looseMetadata.get(entity.object_id)?.card
      );
      const expandedSize =
        entity.entity_type === 'card'
          ? {
              width: ARRANGE_DIMENSIONS.card.width,
              height: estimateExpandedGenericCardHeight(looseMetadata.get(entity.object_id)?.card),
            }
          : ARRANGE_DIMENSIONS.branch;
      if (measured)
        return {
          id: entity.object_id,
          ...entity.position,
          ...measured,
          entityType: entity.entity_type,
          compact: entity.compact,
          densityExpandable,
          expandedSize,
        };
      if (entity.entity_type === 'card') {
        return {
          id: entity.object_id,
          ...entity.position,
          width: ARRANGE_DIMENSIONS.card.width,
          height: estimateExpandedGenericCardHeight(looseMetadata.get(entity.object_id)?.card),
          entityType: entity.entity_type,
          compact: entity.compact,
          densityExpandable,
          expandedSize,
        };
      }
      return {
        id: entity.object_id,
        ...entity.position,
        ...ARRANGE_DIMENSIONS.branch,
        entityType: entity.entity_type,
        compact: entity.compact,
        densityExpandable,
        expandedSize,
      };
    }),
    ...[...looseCanvasById].map(([id, object]) => ({
      id,
      x: object.x,
      y: object.y,
      ...getCanvasObjectDimensions(object),
    })),
  ];
  if (zones.length === 0 && looseItems.length === 0) return null;
  const eligibleZoneIds = new Set(zones.map((zone) => zone.id));
  const fixedObstacles = [
    ...allZoneEntries.flatMap(([id, zone]) =>
      eligibleZoneIds.has(id)
        ? []
        : [{ id, x: zone.x, y: zone.y, width: zone.width, height: zone.height }]
    ),
    ...Object.entries(board.objects ?? {}).flatMap(([id, object]) =>
      object.type === 'artifact' && object.locked === true
        ? [{ id, x: object.x, y: object.y, ...getCanvasObjectDimensions(object) }]
        : []
    ),
  ];

  const plan = planBoardZoneArrangement(zones, {
    mode: options.mode,
    density: options.density,
    targetWidth: options.targetWidth,
    targetRowHeight: options.targetRowHeight,
    gap: options.gap,
    startX: options.startX,
    startY: options.startY,
    maxPerRow: options.maxPerRow,
    justifyLastRow: options.justifyLastRow,
    justifyRows: options.justifyRows,
    resizeZoneFrames: options.resizeZoneFrames,
    lastRowAlignment: options.lastRowAlignment,
    packZoneContents: options.packZoneContents,
    looseItems,
    fixedObstacles,
  });

  const byId = new Map(zones.map((entry) => [entry.id, entry]));
  if (options.dryRun !== true) {
    const plannedObjects = Object.fromEntries([
      ...plan.zones.map((arranged) => {
        const entry = byId.get(arranged.id);
        if (!entry) throw new Error(`Missing board zone '${arranged.id}'.`);
        return [
          arranged.id,
          {
            ...entry.zone,
            x: arranged.position.x,
            y: arranged.position.y,
            width: arranged.width,
            height: arranged.height,
          },
        ];
      }),
      ...plan.looseItems.flatMap((item) => {
        const object = looseCanvasById.get(item.id);
        if (!object) return [];
        return [
          [
            item.id,
            {
              ...object,
              x: item.x,
              y: item.y,
              ...('width' in object ? { width: item.width } : {}),
              ...('height' in object ? { height: item.height } : {}),
            },
          ] as const,
        ];
      }),
      ...plan.zones.flatMap((arranged) => {
        const entry = byId.get(arranged.id);
        if (!entry) throw new Error(`Missing board zone '${arranged.id}'.`);
        return arranged.items.flatMap((item) => {
          const object = entry.canvasById.get(item.id);
          if (!object) return [];
          return [
            [
              item.id,
              {
                ...object,
                x: arranged.position.x + item.x,
                y: arranged.position.y + item.y,
                ...('width' in object ? { width: item.width } : {}),
                ...('height' in object ? { height: item.height } : {}),
              },
            ] as const,
          ];
        });
      }),
    ]);
    const objects = plannedObjects;
    const canvasGeometryChanged = Object.entries(plannedObjects).some(([objectId, next]) => {
      const current = board.objects?.[objectId];
      return current === undefined || JSON.stringify(current) !== JSON.stringify(next);
    });
    const plannedPlacements = [
      ...plan.zones.flatMap((arranged) => {
        const entry = byId.get(arranged.id);
        if (!entry) throw new Error(`Missing board zone '${arranged.id}'.`);
        return arranged.items.flatMap((item) =>
          entry.entitiesById.has(item.id) ? [{ item, entry }] : []
        );
      }),
      ...plan.looseItems.flatMap((item) => {
        const entity = looseEntitiesById.get(item.id);
        return entity ? [{ item, entity }] : [];
      }),
    ];
    const placements = Object.fromEntries(
      plannedPlacements.map((planned) => {
        if ('entity' in planned) {
          const update = {
            position: { x: planned.item.x, y: planned.item.y },
            size: { width: planned.item.width, height: planned.item.height },
            ...(planned.item.compact !== undefined &&
            (planned.entity.compact === true) !== planned.item.compact
              ? { compact: planned.item.compact }
              : {}),
          };
          return [planned.entity.object_id, update] as const;
        }
        const { item, entry } = planned;
        const entity = entry.entitiesById.get(item.id);
        if (!entity) throw new Error(`Missing board entity '${item.id}'.`);
        const update = {
          position: { x: item.x, y: item.y },
          size: { width: item.width, height: item.height },
          ...(item.compact !== undefined && (entity.compact === true) !== item.compact
            ? { compact: item.compact }
            : {}),
        };
        return [entity.object_id, update] as const;
      })
    );
    const placementGeometryChanged = plannedPlacements.some((planned) => {
      if ('entity' in planned) {
        return (
          planned.entity.position.x !== planned.item.x ||
          planned.entity.position.y !== planned.item.y ||
          planned.entity.size?.width !== planned.item.width ||
          planned.entity.size?.height !== planned.item.height
        );
      }
      const entity = planned.entry.entitiesById.get(planned.item.id);
      if (!entity) throw new Error(`Missing board entity '${planned.item.id}'.`);
      const densityChanged =
        planned.item.compact !== undefined && (entity.compact === true) !== planned.item.compact;
      return (
        entity.position.x !== planned.item.x ||
        entity.position.y !== planned.item.y ||
        entity.size?.width !== planned.item.width ||
        entity.size?.height !== planned.item.height ||
        densityChanged
      );
    });
    if (canvasGeometryChanged || placementGeometryChanged) {
      const sourcePlacementById = new Map(
        entityResult.data.map((entity) => [entity.object_id, entity])
      );
      const expected = {
        objects: Object.fromEntries(
          Object.entries(board.objects ?? {}).map(([objectId, object]) => {
            return [
              objectId,
              {
                x: object.x,
                y: object.y,
                ...('width' in object ? { width: object.width } : {}),
                ...('height' in object ? { height: object.height } : {}),
              },
            ];
          })
        ),
        placements: Object.fromEntries(
          [...sourcePlacementById].map(([objectId, entity]) => {
            return [
              objectId,
              {
                position: entity.position,
                ...(entity.size ? { size: entity.size } : {}),
                ...(entity.compact === undefined ? {} : { compact: entity.compact }),
              },
            ];
          })
        ),
      };
      await ctx.app
        .service('boards')
        .patch(
          boardId,
          { _action: 'applyLayout', objects, placements, expected } as unknown as Partial<Board>,
          ctx.baseServiceParams
        );
    }
  }

  return { plan, byId };
}

export function registerBoardTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_boards_get
  server.registerTool(
    'agor_boards_get',
    {
      description:
        'Get information about a board, including zones, canvas objects, and optionally positioned entities (branches, cards). ' +
        'The response includes a `url` field with a clickable link to view the board in the UI. ' +
        'By default, returns board metadata and canvas objects only (no positioned branch/card entities). ' +
        'Use objectTypes=["zone"] for a lean board definition with just zones. ' +
        'Set includeEntities=true to include positioned branch/card entities, optionally filtered by entityZoneId/entityType and paginated with entitiesLimit/entitiesSkip.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        objectTypes: z
          .array(z.enum(BOARD_OBJECT_TYPES))
          .optional()
          .describe(
            'Filter board.objects canvas annotations by type. Use ["zone"] to retrieve zone definitions without heavier text/markdown/app/artifact objects. Omit for backward-compatible behavior returning all board.objects.'
          ),
        includeEntities: z
          .boolean()
          .optional()
          .describe(
            'Include positioned entities (branches, cards) with their x/y coordinates and zone assignments (default: false). Enable when you need to know where branches are placed on the canvas.'
          ),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'When includeEntities=true, include archived branch entities. Default false excludes archived branches while preserving card entities.'
          ),
        entityZoneId: mcpOptionalString(
          'entityZoneId',
          'When includeEntities=true, only return positioned entities pinned to this board zone ID.'
        ),
        entityType: z
          .enum(BOARD_ENTITY_TYPES)
          .optional()
          .describe(
            'When includeEntities=true, only return positioned entities of this type ("branch" or "card").'
          ),
        entitiesLimit: mcpOptionalPositiveInt(
          'entitiesLimit',
          'When includeEntities=true, maximum number of positioned entities to return. Omit to preserve legacy behavior returning all matched entities.'
        )
          .refine(
            (value) => value === undefined || value <= 10000,
            'entitiesLimit must be less than or equal to 10000.'
          )
          .describe(
            'When includeEntities=true, maximum number of positioned entities to return. Omit to preserve legacy behavior returning all matched entities.'
          ),
        entitiesSkip: mcpOptionalNonNegativeInt(
          'entitiesSkip',
          'When includeEntities=true, number of matched positioned entities to skip for pagination (default: 0).'
        )
          .refine(
            (value) => value === undefined || value <= 10000,
            'entitiesSkip must be less than or equal to 10000.'
          )
          .describe(
            'When includeEntities=true, number of matched positioned entities to skip for pagination (default: 0).'
          ),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const board = filterBoardCanvasObjects(
        await ctx.app.service('boards').get(boardId, ctx.baseServiceParams),
        args.objectTypes as BoardObjectType[] | undefined
      );
      const permissions = await ctx.app
        .service('boards/:id/permissions')
        .find({ ...ctx.baseServiceParams, route: { id: board.board_id } });

      const includeEntities = args.includeEntities === true; // default false, opt-in
      if (includeEntities) {
        const entityQuery: Record<string, unknown> = { board_id: board.board_id };
        const entityZoneId = coerceString(args.entityZoneId);
        if (entityZoneId) entityQuery.zone_id = entityZoneId;
        if (args.entityType) entityQuery.entity_type = args.entityType as BoardEntityType;

        const boardObjectsResult = await ctx.app
          .service('board-objects')
          .find({ query: entityQuery, ...ctx.baseServiceParams });
        const matchedEntities = (
          boardObjectsResult as { data: import('@agor/core/types').BoardEntityObject[] }
        ).data;
        let visibleEntities = matchedEntities;

        if (args.includeArchived !== true) {
          const branchIds = matchedEntities
            .map((entity) => entity.branch_id)
            .filter((branchId): branchId is BranchID => typeof branchId === 'string');

          if (branchIds.length > 0) {
            const activeBranchesResult = await ctx.app.service('branches').find({
              query: {
                branch_id: { $in: Array.from(new Set(branchIds)) },
                archived: false,
              },
              paginate: false,
              ...ctx.baseServiceParams,
            });
            const activeBranches = Array.isArray(activeBranchesResult)
              ? activeBranchesResult
              : (activeBranchesResult as { data: Array<{ branch_id: string }> }).data;
            const activeBranchIds = new Set(activeBranches.map((branch) => branch.branch_id));

            visibleEntities = matchedEntities.filter(
              (entity) => !entity.branch_id || activeBranchIds.has(entity.branch_id)
            );
          }
        }

        const total = visibleEntities.length;
        const skip = args.entitiesSkip ?? 0;
        const limit = args.entitiesLimit ?? null;
        const entities =
          args.entitiesLimit !== undefined || args.entitiesSkip !== undefined
            ? visibleEntities.slice(
                skip,
                args.entitiesLimit === undefined ? undefined : skip + args.entitiesLimit
              )
            : visibleEntities;

        return textResult({
          ...board,
          permissions,
          entities,
          entities_pagination: { total, limit, skip },
        });
      }

      return textResult({ ...board, permissions });
    }
  );

  // Tool 2: agor_boards_list
  server.registerTool(
    'agor_boards_list',
    {
      description:
        'List a lean page of boards accessible to the current user (heavy canvas objects and custom CSS are omitted; use agor_boards_get for details). By default archived boards are excluded. Advance with offset=nextOffset while hasMore is true.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        limit: mcpListLimit(),
        offset: mcpOffset(),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'Include archived boards in results (default: false). By default, archived boards are excluded.'
          ),
        archived: z
          .boolean()
          .optional()
          .describe(
            'Filter to show ONLY archived boards. When true, returns only archived boards. Overrides includeArchived.'
          ),
      }),
    },
    async (args) => {
      const limit = args.limit ?? 25;
      const offset = args.offset ?? 0;
      const query: Record<string, unknown> = {
        $limit: limit,
        $skip: offset,
        lean: true,
        $sort: { created_at: -1, board_id: 1 },
      };
      if (args.archived === true) {
        query.archived = true;
      } else if (!args.includeArchived) {
        query.archived = false;
      }
      const boards = await ctx.app.service('boards').find({ query, ...ctx.baseServiceParams });
      return textResult(mcpPageResult(boards, limit, offset));
    }
  );

  // Tool 3: agor_boards_update
  server.registerTool(
    'agor_boards_update',
    {
      description:
        'Update board metadata and manage zones/objects. Can update name, icon, background, and create/update zones for organizing branches. Unicode emoji is preferred for icons; common exact shortcodes like ":compass:" are accepted and normalized. Zone objects have: type="zone", x, y, width, height, label, borderColor, backgroundColor, borderStyle (optional), trigger (optional: "always_new" auto-creates sessions, "show_picker" shows agent selection). Text objects have: type="text", x, y, text, fontSize, color. Markdown objects have: type="markdown", x, y, width, height, content.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        name: mcpOptionalString('name', 'Board name (optional)'),
        description: mcpOptionalString('description', 'Board description (optional)'),
        icon: mcpOptionalString(
          'icon',
          'Board icon/emoji (optional). Unicode emoji is preferred; common exact shortcodes like ":compass:" are accepted and normalized.'
        ),
        color: mcpOptionalString('color', 'Board color (hex format, optional)'),
        backgroundColor: mcpOptionalString(
          'backgroundColor',
          'Board background color (hex format, optional)'
        ),
        customCss: mcpOptionalString(
          'customCss',
          'Custom CSS for board canvas animations (@keyframes, animation, background-size, etc.). Rendered in a scoped <style> tag. Dangerous patterns like url(), expression(), @import are blocked.'
        ),
        slug: mcpOptionalString('slug', 'URL-friendly slug (optional)'),
        customContext: z
          .object({})
          .passthrough()
          .optional()
          .describe('Custom context for templates (optional)'),
        upsertObjects: z
          .object({})
          .passthrough()
          .optional()
          .describe(
            'Board objects to upsert (zones, text, markdown). Keys are object IDs, values are object data.'
          ),
        removeObjects: z
          .array(mcpRequiredString('removeObjects[]', 'Board object ID to remove'))
          .optional()
          .describe('Array of object IDs to remove from the board'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const boardsService = ctx.app.service('boards') as unknown as BoardsServiceImpl;

      const metadataUpdates: Record<string, unknown> = {};
      if (args.name !== undefined) metadataUpdates.name = args.name;
      if (args.description !== undefined) metadataUpdates.description = args.description;
      if (args.icon !== undefined) metadataUpdates.icon = args.icon;
      if (args.color !== undefined) metadataUpdates.color = args.color;
      if (args.backgroundColor !== undefined)
        metadataUpdates.background_color = args.backgroundColor;
      if (args.customCss !== undefined) metadataUpdates.custom_css = args.customCss;
      if (args.slug !== undefined) metadataUpdates.slug = args.slug;
      if (args.customContext !== undefined) metadataUpdates.custom_context = args.customContext;

      if (Object.keys(metadataUpdates).length > 0) {
        await ctx.app.service('boards').patch(boardId, metadataUpdates, ctx.baseServiceParams);
      }

      if (
        args.upsertObjects &&
        typeof args.upsertObjects === 'object' &&
        !Array.isArray(args.upsertObjects)
      ) {
        const updatedBoard = await runWithMcpTenantDatabaseScope(ctx, () =>
          boardsService.batchUpsertBoardObjects(
            boardId,
            args.upsertObjects as unknown as unknown[],
            ctx.baseServiceParams
          )
        );
        emitServiceEvent(ctx.app, {
          path: 'boards',
          event: 'patched',
          data: updatedBoard,
          id: boardId,
        });
      }

      if (args.removeObjects && Array.isArray(args.removeObjects)) {
        let finalBoard: Board | undefined;
        for (const objectId of args.removeObjects) {
          finalBoard = await runWithMcpTenantDatabaseScope(ctx, () =>
            boardsService.removeBoardObject(boardId, objectId, ctx.baseServiceParams)
          );
        }
        if (finalBoard)
          emitServiceEvent(ctx.app, {
            path: 'boards',
            event: 'patched',
            data: finalBoard,
            id: boardId,
          });
      }

      const board = await ctx.app.service('boards').get(boardId, ctx.baseServiceParams);
      return textResult({ board, note: 'Board updated successfully.' });
    }
  );

  server.registerTool(
    'agor_boards_permissions_update',
    {
      description:
        'Replace a board permission policy and its complete default branch configuration. ' +
        'Read the current revision with agor_boards_get first. Primary ownership is immutable.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        permissions: boardCapabilityPoliciesSchema,
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId)!;
      const permissions = await ctx.app
        .service('boards/:id/permissions')
        .patch(null, args.permissions, { ...ctx.baseServiceParams, route: { id: boardId } });
      return textResult(permissions);
    }
  );

  // Tool 4: agor_boards_auto_arrange
  server.registerTool(
    'agor_boards_auto_arrange',
    {
      description:
        'Arrange a filtered legacy subset of worktrees/branches, cards, and artifacts using the authoritative board planner. Use agor_boards_arrange_zones for the atomic whole-board operation. ' +
        'By default, only free-floating entities are moved; zone-pinned entities stay in their zones. ' +
        'Artifacts are always included; set includeCanvasObjects=true to also include text, markdown, and apps, and includeZones=true to arrange zones as movable containers. ' +
        'Unless startY is given explicitly, the cluster is placed clear of every existing zone rectangle instead of on top of one. ' +
        'Pass columns to request an explicit row-major grid instead. ' +
        'Use this after creating or moving many board items so the canvas is tidy and collision-free.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        entityType: z
          .enum(BOARD_ENTITY_TYPES)
          .optional()
          .describe('Arrange only branch or card entities (default: both).'),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'Include archived branches and cards. Defaults to false so layout matches the visible board.'
          ),
        includePinned: z
          .boolean()
          .optional()
          .describe('Also move entities currently pinned to zones (default: false).'),
        includeCanvasObjects: z
          .boolean()
          .optional()
          .describe('Also arrange text, markdown, and app canvas objects (default: false).'),
        includeZones: z
          .boolean()
          .optional()
          .describe(
            'Also arrange zone containers. Their pinned children move with their parent zone.'
          ),
        columns: mcpOptionalPositiveInt(
          'columns',
          'Use an explicit row-major grid with exactly this many columns (default: compact cluster).'
        ),
        startX: mcpOptionalNumber('startX', 'Canvas X origin (default: 80).'),
        startY: mcpOptionalNumber(
          'startY',
          'Canvas Y origin. When omitted, the grid starts at 80 unless that would place it over an existing zone, in which case it drops below every zone and reports avoidedZoneIds. Pass a value to place the grid exactly, including over a zone.'
        ),
        gapX: mcpOptionalNumber('gapX', 'Horizontal gap between cards (default: 40).'),
        gapY: mcpOptionalNumber('gapY', 'Vertical gap between cards (default: 40).'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const boardObjectsService = ctx.app.service('board-objects');
      const result = (await boardObjectsService.find({
        query: {
          board_id: boardId,
          ...(args.entityType ? { entity_type: args.entityType } : {}),
        },
        ...ctx.baseServiceParams,
      })) as { data: Array<BoardEntityObject> };
      const visibleEntities = await filterVisibleBoardEntities(
        ctx,
        result.data,
        args.includeArchived === true
      );
      const entities = visibleEntities
        .filter((entity) => args.includePinned === true || !entity.zone_id)
        .sort(
          (a, b) =>
            a.created_at.localeCompare(b.created_at) || a.object_id.localeCompare(b.object_id)
        );
      const requestedStartX = snapBoardGridValue(args.startX ?? DEFAULT_ARRANGE_START_X);
      const requestedStartY = snapBoardGridValue(args.startY ?? DEFAULT_ARRANGE_START_Y);
      const gapX = boardGridSpacing(args.gapX ?? 40);
      const gapY = boardGridSpacing(args.gapY ?? 40);
      const items: Array<{
        id: string;
        kind: 'entity' | 'canvas';
        entity?: BoardEntityObject;
        object?: BoardObject;
        x: number;
        y: number;
        width: number;
        height: number;
      }> = [];
      const unusableSizeObjectIds: string[] = [];
      for (const entity of entities) {
        if (hasUnusableSize(entity)) unusableSizeObjectIds.push(entity.object_id);
        let entityDimensions: { width: number; height: number };
        const measured = measuredSize(entity);
        if (measured) {
          entityDimensions = measured;
        } else if (entity.entity_type === 'card' && entity.card_id) {
          const card = (await ctx.app
            .service('cards')
            .get(entity.card_id, ctx.baseServiceParams)) as {
            title?: string;
            description?: string;
            note?: string;
          };
          entityDimensions = {
            width: ARRANGE_DIMENSIONS.card.width,
            height: estimateExpandedGenericCardHeight(card),
          };
        } else {
          entityDimensions = ARRANGE_DIMENSIONS[entity.entity_type];
        }
        items.push({
          id: entity.object_id,
          kind: 'entity',
          entity,
          ...entity.position,
          ...entityDimensions,
        });
      }
      // The board is read even when no canvas object is being arranged: its
      // zone rectangles are what the free-floating grid has to stay clear of.
      const boardsService = ctx.app.service('boards');
      const board = (await boardsService.get(boardId, ctx.baseServiceParams)) as Board;
      for (const [objectId, object] of Object.entries(board.objects ?? {})) {
        if (object.type === 'zone' && args.includeZones !== true) continue;
        if (
          object.type !== 'zone' &&
          object.type !== 'artifact' &&
          args.includeCanvasObjects !== true
        )
          continue;
        items.push({
          id: objectId,
          kind: 'canvas',
          object,
          x: object.x,
          y: object.y,
          ...getCanvasObjectDimensions(object),
        });
      }
      const layoutItems = items.map(({ id, x, y, width, height }) => ({
        id,
        ...ceilBoardGridSize({ width, height }),
        x,
        y,
      }));
      // This legacy subset tool now delegates geometry to the same planner as
      // Arrange Board. Its filtering surface remains backward compatible, but
      // there is no second grid/compact algorithm with subtly different gaps,
      // ordering, or collision semantics.
      const fixedZones = zoneObstacles(board, args.includeZones === true);
      const plan = planBoardZoneArrangement([], {
        looseItems: layoutItems,
        mode: args.columns ? 'grid' : 'compact',
        fixedItemsPerRow: args.columns,
        compactFixedGrid: args.columns !== undefined,
        justifyRows: args.columns === undefined,
        resizeZoneFrames: false,
        packZoneContents: false,
        gap: Math.max(gapX, gapY),
        startX: requestedStartX,
        startY: requestedStartY,
        fixedObstacles: [],
      });
      const { startX, startY, avoidedZoneIds } = resolveArrangeOrigin({
        startX: requestedStartX,
        startY: requestedStartY,
        explicitStartY: args.startY !== undefined,
        layout: plan.layout,
        gapY: Math.max(gapX, gapY),
        obstacles: fixedZones,
      });
      const placementById = new Map(
        plan.looseItems.map((placement) => [
          placement.id,
          {
            ...placement,
            x: placement.x + startX - requestedStartX,
            y: placement.y + startY - requestedStartY,
          },
        ])
      );
      const updates: Array<{
        objectId: string;
        objectType: string;
        entityType?: string;
        position: { x: number; y: number };
      }> = [];
      const canvasObjectUpdates: Record<string, BoardObject> = {};

      for (const item of items) {
        const placement = placementById.get(item.id);
        if (!placement) throw new Error(`Layout did not place board object '${item.id}'.`);
        const position = {
          x: placement.x,
          y: placement.y,
        };
        if (item.kind === 'entity' && item.entity) {
          await boardObjectsService.patch(
            item.id,
            { position, size: { width: placement.width, height: placement.height } },
            ctx.baseServiceParams
          );
          updates.push({
            objectId: item.id,
            objectType: item.entity.entity_type,
            entityType: item.entity.entity_type,
            position,
          });
        } else if (item.object) {
          canvasObjectUpdates[item.id] = {
            ...item.object,
            ...position,
            ...('width' in item.object ? { width: placement.width } : {}),
            ...('height' in item.object ? { height: placement.height } : {}),
          } as BoardObject;
          updates.push({ objectId: item.id, objectType: item.object.type, position });
        }
      }
      if (Object.keys(canvasObjectUpdates).length > 0) {
        await boardsService.patch(
          boardId,
          { _action: 'batchUpsertObjects', objects: canvasObjectUpdates },
          ctx.baseServiceParams
        );
      }

      return textResult({
        boardId,
        arranged: updates.length,
        arrangedEntities: updates.filter((update) =>
          BOARD_ENTITY_TYPES.includes(update.objectType as BoardEntityType)
        ).length,
        arrangedCanvasObjects: updates.filter(
          (update) => !BOARD_ENTITY_TYPES.includes(update.objectType as BoardEntityType)
        ).length,
        skippedPinned: visibleEntities.length - entities.length,
        skippedArchived: result.data.length - visibleEntities.length,
        columns: Math.max(0, ...plan.layout.placements.map((placement) => placement.column + 1)),
        rows: plan.layout.rows,
        layoutMode: args.columns ? 'grid' : (plan.boardLayout?.mode ?? 'cluster'),
        fitsWithoutOverlap: true,
        width: plan.layout.width,
        height: plan.layout.height,
        appliedGapX: Math.max(gapX, gapY),
        appliedGapY: Math.max(gapX, gapY),
        appliedStartX: startX,
        appliedStartY: startY,
        avoidedZoneIds,
        unusableSizeObjectIds,
        warning:
          [
            avoidedZoneIds.length > 0
              ? `The default layout origin would have covered ${avoidedZoneIds.length} existing zone(s); the layout was placed below every zone at y=${startY}. Pass startY to override.`
              : null,
            unusableSizeObjectIds.length > 0
              ? `Ignored an unusable persisted size on ${unusableSizeObjectIds.join(', ')} and laid them out at the nominal size for their kind.`
              : null,
          ]
            .filter(Boolean)
            .join(' ') || null,
        updates,
      });
    }
  );

  // agor_boards_auto_arrange_zone
  server.registerTool(
    'agor_boards_auto_arrange_zone',
    {
      description:
        'Arrange every positionable item inside one board zone: pinned worktrees/branches and cards plus geometrically contained artifacts, notes, apps, and other canvas objects. Measured heterogeneous rectangles use a deterministic compact cluster by default; persisted sizes and documented per-kind fallbacks are used when browser measurements are unavailable. Pass columns for an explicit grid. If no collision-free contained layout fits, no positions change unless the caller explicitly requests overflowStrategy:"deck" for branch/worktree-only contents.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        zoneId: mcpRequiredString('zoneId', 'Zone object ID'),
        entityType: z
          .enum(BOARD_ENTITY_TYPES)
          .optional()
          .describe('Arrange only branch or card entities (default: both).'),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'Include archived branches and cards. Defaults to false so layout matches the visible board.'
          ),
        columns: mcpOptionalPositiveInt(
          'columns',
          'Target number of occupied columns (capped by the number of entities). When omitted, the solver chooses automatically. If this target cannot fit without overlap, the nearest contained grid is used unless strictColumns is true.'
        ),
        strictColumns: z
          .boolean()
          .optional()
          .describe(
            'Require columns exactly as requested. Defaults to false, which allows a reported non-overlapping grid fallback.'
          ),
        overflowStrategy: z
          .enum(['fail', 'deck'])
          .optional()
          .describe(
            'Behavior only when no non-overlapping grid fits. Defaults to fail (no board changes). Use deck only for branch/worktree-only contents when deliberate visible-header overlap is acceptable.'
          ),
        preset: z
          .enum(ZONE_LAYOUT_PRESETS)
          .optional()
          .describe(
            'Layout presentation only. compact_list uses one column; neither preset changes content expansion.'
          ),
        density: z
          .enum(['preserve', 'expand', 'collapse'])
          .optional()
          .describe(
            'Content expansion policy. Defaults to the zone policy, then preserve. Only body-capable worktrees/cards are eligible.'
          ),
        sortBy: z
          .enum(ZONE_LAYOUT_SORT_FIELDS)
          .optional()
          .describe(
            'Order items by current position, priority/rank, workflow status, updated time, created time, or title. Defaults to the zone policy, then position.'
          ),
        sortDirection: z
          .enum(ZONE_LAYOUT_SORT_DIRECTIONS)
          .optional()
          .describe('Ascending or descending sort order. Defaults to the zone policy, then asc.'),
        autoResizeHeight: z
          .boolean()
          .optional()
          .describe(
            'Deprecated alias for resize:"height". Resize the zone vertically to contain the layout. Defaults to the zone policy, then false.'
          ),
        resize: z
          .enum(ZONE_RESIZE_MODES)
          .optional()
          .describe(
            'How far the zone may resize to fit its contents: "fixed" never resizes, "height" grows vertically, "both" also widens. Height alone cannot rescue a zone narrower than its widest item. Defaults to the zone policy.'
          ),
        onOverflow: z
          .enum(ZONE_OVERFLOW_STRATEGIES)
          .optional()
          .describe(
            'What to do when a resize covers neighbouring zones: "report" names them, "reflow_board" re-justifies the board zones into rows so they move out of the way. Defaults to the zone policy, then report.'
          ),
        padding: mcpOptionalNumber('padding', 'Padding from the zone edges (default: 24).'),
        gapX: mcpOptionalNumber('gapX', 'Horizontal gap between items (default: 24).'),
        gapY: mcpOptionalNumber('gapY', 'Vertical gap between items (default: 24).'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      const zoneId = coerceString(args.zoneId);
      if (!boardId || !zoneId) throw new Error('boardId and zoneId are required');
      const board = (await ctx.app.service('boards').get(boardId, ctx.baseServiceParams)) as Board;
      const zone = board.objects?.[zoneId] as
        | (BoardObject & { type: 'zone'; width: number; height: number })
        | undefined;
      if (zone?.type !== 'zone') {
        throw new Error(`Zone '${zoneId}' was not found on board '${boardId}'.`);
      }

      const zonePolicy = normalizeZoneLayoutPolicy({
        ...zone.layout,
        ...(args.preset === undefined ? {} : { preset: args.preset }),
        ...(args.density === undefined ? {} : { density: args.density }),
        ...(args.sortBy === undefined ? {} : { sortBy: args.sortBy }),
        ...(args.sortDirection === undefined ? {} : { sortDirection: args.sortDirection }),
        ...(args.columns === undefined ? {} : { columns: args.columns }),
        ...(args.autoResizeHeight === undefined ? {} : { autoResizeHeight: args.autoResizeHeight }),
        ...(args.resize === undefined ? {} : { resize: args.resize }),
        ...(args.onOverflow === undefined ? {} : { onOverflow: args.onOverflow }),
      });

      const boardObjectsService = ctx.app.service('board-objects');
      const result = (await boardObjectsService.find({
        query: {
          board_id: boardId,
          zone_id: zoneId,
          ...(args.entityType ? { entity_type: args.entityType } : {}),
        },
        ...ctx.baseServiceParams,
      })) as { data: Array<BoardEntityObject> };
      let entities = await filterVisibleBoardEntities(
        ctx,
        result.data,
        args.includeArchived === true
      );
      const metadataEntities = entities.filter(
        (entity) =>
          zonePolicy.sortBy !== 'position' ||
          (entity.card_id !== undefined &&
            (zonePolicy.density !== 'preserve' ||
              entity.compact === true ||
              measuredSize(entity) === undefined))
      );
      const metadata = await loadEntityLayoutMetadata(ctx, metadataEntities);
      const densityExpandableIds = new Set(
        entities
          .filter((entity) =>
            isBoardEntityDensityExpandable(entity.entity_type, metadata.get(entity.object_id)?.card)
          )
          .map((entity) => entity.object_id)
      );
      if (
        !(
          zonePolicy.preset === 'grid' &&
          zonePolicy.columns === undefined &&
          zonePolicy.sortBy === 'position' &&
          args.columns === undefined
        )
      ) {
        entities = sortZoneLayoutItems(
          entities.map((entity) => ({
            entity,
            ...(metadata.get(entity.object_id) ?? {
              id: entity.object_id,
              position: entity.position,
            }),
          })),
          zonePolicy
        ).map(({ entity }) => entity);
      }
      const naturalDimensions = new Map<string, { width: number; height: number }>();
      const expandedDimensions = new Map<string, { width: number; height: number }>();
      const unusableSizeObjectIds: string[] = [];
      for (const entity of entities) {
        if (hasUnusableSize(entity)) unusableSizeObjectIds.push(entity.object_id);
        const measured = measuredSize(entity);
        expandedDimensions.set(
          entity.object_id,
          entity.entity_type === 'card'
            ? {
                width: ARRANGE_DIMENSIONS.card.width,
                height: estimateExpandedGenericCardHeight(metadata.get(entity.object_id)?.card),
              }
            : ARRANGE_DIMENSIONS.branch
        );
        if (entity.compact === true && densityExpandableIds.has(entity.object_id)) {
          naturalDimensions.set(
            entity.object_id,
            compactZoneItemSize(entity.entity_type, ARRANGE_DIMENSIONS[entity.entity_type].width)
          );
        } else if (measured) {
          naturalDimensions.set(entity.object_id, measured);
        } else if (entity.entity_type === 'card' && entity.card_id) {
          const card = metadata.get(entity.object_id)?.card;
          naturalDimensions.set(entity.object_id, {
            width: ARRANGE_DIMENSIONS.card.width,
            height: estimateExpandedGenericCardHeight(card),
          });
        } else {
          naturalDimensions.set(entity.object_id, ARRANGE_DIMENSIONS[entity.entity_type]);
        }
      }
      const requestedPadding = boardGridSpacing(Math.max(0, args.padding ?? BOARD_GRID_SIZE));
      const gapX = exactSpacing(Math.max(0, args.gapX ?? zonePolicy.gap ?? 24));
      const gapY = exactSpacing(Math.max(0, args.gapY ?? zonePolicy.gap ?? 24));
      const resizeMode = zonePolicy.resize ?? 'fixed';
      const autoResizeHeight = resizeMode !== 'fixed';
      // `both` also lets the zone widen. Height alone cannot rescue a zone that
      // is too narrow — an item wider than the zone overflows at any height —
      // so a width-constrained arrange could previously only refuse. Laying out
      // against an unbounded width lets the packer report the width the
      // contents actually need, which the zone then adopts.
      const layoutWidth =
        resizeMode === 'both'
          ? Math.max(
              ceilBoardGridValue(zone.width),
              ...entities.map(
                (entity) =>
                  (naturalDimensions.get(entity.object_id)?.width ?? 0) + requestedPadding * 2
              )
            )
          : ceilBoardGridValue(zone.width);
      const frame = getZoneLayoutFrame(
        { ...zone, width: layoutWidth },
        { padding: requestedPadding }
      );
      const dimensions = new Map(
        entities.map((entity) => {
          const compact = layoutCompactTarget(
            zonePolicy.density,
            entity.compact,
            densityExpandableIds.has(entity.object_id)
          );
          return [
            entity.object_id,
            compact === true
              ? compactZoneItemSize(entity.entity_type, frame.usableWidth)
              : compact === false && entity.compact === true
                ? (expandedDimensions.get(entity.object_id) ??
                  ARRANGE_DIMENSIONS[entity.entity_type])
                : (naturalDimensions.get(entity.object_id) ??
                  ARRANGE_DIMENSIONS[entity.entity_type]),
          ] as const;
        })
      );
      const padding = frame.padding;
      const titleInset = frame.headerInset;
      const canvasItems = Object.entries(board.objects ?? {})
        .flatMap(([objectId, object]) => {
          if (object.type === 'zone' || (object.type === 'artifact' && object.locked === true))
            return [];
          const size = getCanvasObjectDimensions(object);
          const centerX = object.x + size.width / 2;
          const centerY = object.y + size.height / 2;
          if (
            centerX < zone.x ||
            centerX > zone.x + zone.width ||
            centerY < zone.y ||
            centerY > zone.y + zone.height
          )
            return [];
          return [
            {
              id: objectId,
              object,
              position: { x: object.x - zone.x, y: object.y - zone.y },
              ...size,
            },
          ];
        })
        .sort(
          (a, b) =>
            a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id)
        );
      const layoutSources = [
        ...entities.map((entity) => {
          const size = dimensions.get(entity.object_id);
          if (!size) throw new Error(`Missing dimensions for board object '${entity.object_id}'.`);
          return {
            id: entity.object_id,
            kind: 'entity' as const,
            entity,
            position: entity.position,
            ...size,
          };
        }),
        ...canvasItems.map((item) => ({ ...item, kind: 'canvas' as const })),
      ];
      if (layoutSources.length === 0) {
        return textResult({
          boardId,
          zoneId,
          arranged: 0,
          columns: 0,
          rows: 0,
          fitsWithoutOverlap: true,
          layoutMode: 'grid',
          updates: [],
        });
      }
      const useExplicitGrid =
        args.columns !== undefined ||
        zonePolicy.columns !== undefined ||
        zonePolicy.preset === 'compact_list' ||
        args.overflowStrategy === 'deck';
      const commonLayoutOptions = {
        // The title/status sits inside the zone, above child nodes. Layout
        // against the remaining rectangle, then translate placements below
        // that reserved header so cards can never cover the title.
        bounds: {
          width: layoutWidth,
          height: autoResizeHeight
            ? Number.MAX_SAFE_INTEGER
            : Math.max(0, zone.height - titleInset),
        },
        padding,
        minPadding: padding,
        gapX,
        gapY,
        minGapX: gapX,
        minGapY: gapY,
        gridSize: BOARD_GRID_SIZE,
      };
      const layout = useExplicitGrid
        ? layoutRectangles(
            layoutSources.map(({ id, width, height }) => ({ id, width, height })),
            {
              ...commonLayoutOptions,
              ...(zonePolicy.preset === 'compact_list'
                ? { exactColumns: 1 }
                : args.strictColumns === true
                  ? { exactColumns: args.columns ?? zonePolicy.columns }
                  : { preferredColumns: args.columns ?? zonePolicy.columns }),
              allowDeck:
                args.overflowStrategy === 'deck' &&
                canvasItems.length === 0 &&
                entities.every((entity) => entity.entity_type === 'branch'),
              deckOffsetX: DECK_OFFSET_X,
              deckOffsetY: DECK_OFFSET_Y,
            }
          )
        : layoutCompactRectangles(
            layoutSources.map(({ id, width, height, position }) => ({
              id,
              width,
              height,
              sourceX: position.x,
              sourceY: position.y - titleInset,
            })),
            {
              bounds:
                resizeMode === 'both'
                  ? undefined
                  : {
                      width: layoutWidth,
                      height: autoResizeHeight
                        ? Number.MAX_SAFE_INTEGER
                        : Math.max(0, zone.height - titleInset),
                    },
              padding,
              gapX,
              gapY,
              gridSize: BOARD_GRID_SIZE,
            }
          );
      const requestedColumns =
        args.columns === undefined ? null : Math.min(args.columns, layoutSources.length);
      if (layout.overflowingItemIds.length > 0) {
        return textResult({
          boardId,
          zoneId,
          applied: false,
          arranged: 0,
          requestedColumns,
          columns: layout.columns,
          rows: layout.rows,
          fitsWithoutOverlap: layout.fitsWithoutOverlap,
          layoutMode: layout.mode,
          requiredWidth: layout.width,
          requiredHeight: layout.height + titleInset,
          reservedTitleHeight: titleInset,
          availableContentHeight: Math.max(0, zone.height - titleInset),
          appliedGapX: layout.gapX,
          appliedGapY: layout.gapY,
          appliedPadding: layout.padding,
          overflowingObjectIds: layout.overflowingItemIds,
          unusableSizeObjectIds,
          warning:
            `One or more rendered objects are larger than the available zone rectangle, or no non-overlapping ${requestedColumns === null ? 'automatic' : `${requestedColumns}-column`} layout can fit every rendered object inside ` +
            `the ${zone.width}×${zone.height} zone. No positions were changed. Increase the zone size, ` +
            'reduce the requested columns, allow a non-strict grid fallback, or explicitly choose overflowStrategy:"deck".',
          zone: { width: zone.width, height: zone.height },
          updates: [],
        });
      }
      const placementById = new Map(
        layout.placements.map((placement) => [placement.id, placement])
      );
      const updates: Array<{
        objectId: string;
        entityType: string;
        position: { x: number; y: number };
        row: number;
        column: number;
        stackIndex: number;
        deckDepth: number;
      }> = [];
      const canvasObjectUpdates: Record<string, BoardObject> = {};
      const entityPlacementUpdates: Record<string, BoardLayoutPlacementUpdate> = {};

      for (const source of layoutSources) {
        const placement = placementById.get(source.id);
        if (!placement) throw new Error(`Layout did not place board object '${source.id}'.`);
        const relativePosition = { x: placement.x, y: placement.y + titleInset };
        const position =
          source.kind === 'canvas'
            ? { x: zone.x + relativePosition.x, y: zone.y + relativePosition.y }
            : relativePosition;
        if (source.kind === 'entity') {
          const targetCompact = layoutCompactTarget(
            zonePolicy.density,
            source.entity.compact,
            densityExpandableIds.has(source.entity.object_id)
          );
          entityPlacementUpdates[source.entity.object_id] = {
            position,
            size: { width: placement.width, height: placement.height },
            ...(targetCompact !== undefined && (source.entity.compact === true) !== targetCompact
              ? { compact: targetCompact }
              : {}),
          };
        } else {
          canvasObjectUpdates[source.id] = {
            ...source.object,
            x: position.x,
            y: position.y,
            ...('width' in source.object ? { width: placement.width } : {}),
            ...('height' in source.object ? { height: placement.height } : {}),
          } as BoardObject;
        }
        updates.push({
          objectId: source.id,
          entityType: source.kind === 'entity' ? source.entity.entity_type : source.object.type,
          position,
          row: placement.row,
          column: placement.column,
          stackIndex: placement.stackIndex,
          deckDepth: placement.deckDepth,
        });
      }

      const appliedZoneHeight = autoResizeHeight
        ? growZoneLayoutHeight(zone.height, layout.height + titleInset)
        : ceilBoardGridValue(zone.height);
      const appliedZoneWidth =
        resizeMode === 'both'
          ? Math.max(frame.width, ceilBoardGridValue(layout.width))
          : frame.width;
      // A grow moves an edge onto whatever shares the canvas beside or below
      // it. Only a grow can newly cover a neighbour; a shrink or a no-op cannot.
      const resizedOverZoneIds =
        appliedZoneHeight > zone.height || appliedZoneWidth > zone.width
          ? zonesOverlappedBy(board, zoneId, {
              x: zone.x,
              y: zone.y,
              width: appliedZoneWidth,
              height: appliedZoneHeight,
            })
          : [];
      const reflowPlan =
        zonePolicy.onOverflow === 'reflow_board' && resizedOverZoneIds.length > 0
          ? planZoneGrowthReflow(
              Object.entries(board.objects ?? {}).flatMap(([id, object]) =>
                object.type === 'zone' ? [{ id, ...object }] : []
              ),
              zoneId,
              {
                id: zoneId,
                x: zone.x,
                y: zone.y,
                width: appliedZoneWidth,
                height: appliedZoneHeight,
              },
              { gap: zonePolicy.gap }
            )
          : null;
      const movedZoneIds = reflowPlan?.movedZoneIds ?? [];
      const reflowedZoneUpdates = Object.fromEntries(
        movedZoneIds.flatMap((movedZoneId) => {
          const source = board.objects?.[movedZoneId];
          const placement = reflowPlan?.placements.find((item) => item.id === movedZoneId);
          return source?.type === 'zone' && placement
            ? [[movedZoneId, { ...source, x: placement.x, y: placement.y }] as const]
            : [];
        })
      );
      const translatedCanvasUpdates = Object.fromEntries(
        Object.entries(board.objects ?? {}).flatMap(([objectId, object]) => {
          if (object.type === 'zone' || (object.type === 'artifact' && object.locked === true)) {
            return [];
          }
          const size = getCanvasObjectDimensions(object);
          const center = { x: object.x + size.width / 2, y: object.y + size.height / 2 };
          const sourceZone = movedZoneIds
            .flatMap((movedZoneId) => {
              const candidate = board.objects?.[movedZoneId];
              return candidate?.type === 'zone' ? [[movedZoneId, candidate] as const] : [];
            })
            .filter(
              ([, candidate]) =>
                center.x >= candidate.x &&
                center.x <= candidate.x + candidate.width &&
                center.y >= candidate.y &&
                center.y <= candidate.y + candidate.height
            )
            .sort(
              ([leftId, left], [rightId, right]) =>
                left.width * left.height - right.width * right.height ||
                leftId.localeCompare(rightId)
            )[0];
          if (!sourceZone) return [];
          const placement = reflowPlan?.placements.find((item) => item.id === sourceZone[0]);
          if (!placement) return [];
          const deltaX = placement.x - sourceZone[1].x;
          const deltaY = placement.y - sourceZone[1].y;
          return [[objectId, { ...object, x: object.x + deltaX, y: object.y + deltaY }] as const];
        })
      );
      const objects = {
        [zoneId]: { ...zone, width: appliedZoneWidth, height: appliedZoneHeight },
        ...reflowedZoneUpdates,
        ...translatedCanvasUpdates,
        ...canvasObjectUpdates,
      };
      const objectChanged = Object.entries(objects).some(
        ([objectId, object]) => JSON.stringify(board.objects?.[objectId]) !== JSON.stringify(object)
      );
      const placementChanged = Object.entries(entityPlacementUpdates).some(([objectId, update]) => {
        const entity = entities.find((candidate) => candidate.object_id === objectId);
        return (
          !entity ||
          entity.position.x !== update.position.x ||
          entity.position.y !== update.position.y ||
          entity.size?.width !== update.size.width ||
          entity.size?.height !== update.size.height ||
          (update.compact !== undefined && entity.compact !== update.compact)
        );
      });
      if (objectChanged || placementChanged) {
        await ctx.app.service('boards').patch(
          boardId,
          {
            _action: 'applyLayout',
            objects,
            placements: entityPlacementUpdates,
            expected: {
              objects: Object.fromEntries(
                Object.entries(board.objects ?? {}).map(([objectId, object]) => [
                  objectId,
                  {
                    x: object.x,
                    y: object.y,
                    ...('width' in object ? { width: object.width } : {}),
                    ...('height' in object ? { height: object.height } : {}),
                  },
                ])
              ),
              placements: Object.fromEntries(
                entities.map((entity) => [
                  entity.object_id,
                  {
                    position: entity.position,
                    ...(entity.size ? { size: entity.size } : {}),
                    ...(entity.compact === undefined ? {} : { compact: entity.compact }),
                  },
                ])
              ),
            },
          } as unknown as Partial<Board>,
          ctx.baseServiceParams
        );
      }

      const reflowedBoard = movedZoneIds.length > 0;

      return textResult({
        boardId,
        zoneId,
        applied: true,
        arranged: updates.length,
        requestedColumns,
        strictColumns: args.strictColumns === true,
        usedColumnFallback: requestedColumns !== null && layout.columns !== requestedColumns,
        columns: layout.columns,
        rows: layout.rows,
        fitsWithoutOverlap: layout.fitsWithoutOverlap,
        layoutMode: layout.mode,
        preset: zonePolicy.preset,
        density: zonePolicy.density,
        sortBy: zonePolicy.sortBy,
        sortDirection: zonePolicy.sortDirection,
        autoResizeHeight,
        deckOffsetX: layout.mode === 'deck' ? layout.deckOffsetX : null,
        deckOffsetY: layout.mode === 'deck' ? layout.deckOffsetY : null,
        stackCount: layout.mode === 'deck' ? layout.stackCount : null,
        maxDeckDepth: layout.maxDeckDepth,
        requiredWidth: layout.width,
        requiredHeight: layout.height + titleInset,
        reservedTitleHeight: titleInset,
        availableContentHeight: Math.max(0, zone.height - titleInset),
        appliedGapX: layout.gapX,
        appliedGapY: layout.gapY,
        appliedPadding: layout.padding,
        overflowingObjectIds: layout.overflowingItemIds,
        unusableSizeObjectIds,
        resize: resizeMode,
        onOverflow: zonePolicy.onOverflow,
        resizedOverZoneIds,
        movedZoneIds,
        reflowedBoard,
        warning:
          [
            resizedOverZoneIds.length > 0
              ? reflowedBoard
                ? `Growing this zone covered ${resizedOverZoneIds.join(', ')}; moved ${movedZoneIds.join(', ')} by the minimum collision-free shift.`
                : `Growing this zone to ${appliedZoneWidth}x${appliedZoneHeight} now covers ${resizedOverZoneIds.join(', ')}. Run agor_boards_arrange_zones to separate them, or set the zone's onOverflow to "reflow_board" to have it done automatically.`
              : null,
            layout.overflowingItemIds.length > 0
              ? `One or more rendered objects are larger than the available zone rectangle: ${layout.overflowingItemIds.join(', ')}.`
              : layout.mode === 'deck'
                ? `The zone cannot fit every rendered object without overlap; a contained cascade deck was used with ${layout.deckOffsetX}px left-edge and ${layout.deckOffsetY}px header reveals.`
                : requestedColumns !== null && layout.columns !== requestedColumns
                  ? `The requested ${requestedColumns}-column target could not fit without overlap; a contained ${layout.columns}-column grid was used.`
                  : null,
            unusableSizeObjectIds.length > 0
              ? `Ignored an unusable persisted size on ${unusableSizeObjectIds.join(', ')} and laid them out at the nominal size for their kind.`
              : null,
          ]
            .filter(Boolean)
            .join(' ') || null,
        zone: { width: appliedZoneWidth, height: appliedZoneHeight },
        updates,
      });
    }
  );

  server.registerTool(
    'agor_boards_set_zone_layout',
    {
      description:
        'Configure a zone layout policy. Manual mode preserves spatial memory until Arrange contents is requested. Auto Zone mode maintains the selected ordering, geometry preset, and explicit density policy as items or measured sizes change. List is one column and never implies collapse.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        zoneId: mcpRequiredString('zoneId', 'Zone object ID'),
        mode: z.enum(ZONE_LAYOUT_MODES).optional(),
        useBoardDefaults: z
          .boolean()
          .optional()
          .describe(
            'True resets this zone to the board defaults and follows future changes. False/omitted saves an explicit per-zone override.'
          ),
        preset: z.enum(ZONE_LAYOUT_PRESETS).optional(),
        density: z.enum(['preserve', 'expand', 'collapse']).optional(),
        sortBy: z.enum(ZONE_LAYOUT_SORT_FIELDS).optional(),
        sortDirection: z.enum(ZONE_LAYOUT_SORT_DIRECTIONS).optional(),
        resize: z
          .enum(ZONE_RESIZE_MODES)
          .optional()
          .describe(
            'How far the zone may resize to fit its contents: "fixed" never resizes, "height" grows vertically, "both" also widens. Height alone cannot rescue a zone narrower than its widest item. Defaults to the zone policy.'
          ),
        onOverflow: z
          .enum(ZONE_OVERFLOW_STRATEGIES)
          .optional()
          .describe(
            'What to do when a resize covers neighbouring zones: "report" names them, "reflow_board" re-justifies the board zones into rows so they move out of the way. Defaults to the zone policy, then report.'
          ),
        columns: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('Preferred grid columns. Use null to return to automatic column selection.'),
        gap: z
          .number()
          .int()
          .min(0)
          .max(96)
          .optional()
          .describe('Spacing between arranged items in board pixels.'),
        autoResizeHeight: z
          .boolean()
          .optional()
          .describe('Grow or shrink the zone vertically to contain arranged items.'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      const zoneId = coerceString(args.zoneId);
      if (!boardId || !zoneId) throw new Error('boardId and zoneId are required');
      const boardsService = ctx.app.service('boards');
      const board = (await boardsService.get(boardId, ctx.baseServiceParams)) as Board;
      const zone = board.objects?.[zoneId];
      if (zone?.type !== 'zone') {
        throw new Error(`Zone '${zoneId}' was not found on board '${boardId}'.`);
      }
      if (args.mode === undefined && args.useBoardDefaults !== true) {
        throw new Error('mode is required when useBoardDefaults is not true');
      }
      const modeTransition = setZoneLayoutMode(zone.layout, args.mode ?? 'manual');
      const layout =
        args.useBoardDefaults === true
          ? normalizeZoneLayoutPolicy(board.zone_layout_defaults)
          : normalizeZoneLayoutPolicy({
              ...modeTransition,
              // The legacy boolean remains a supported public input. A normalized
              // transition contains `resize`, whose precedence would otherwise make
              // the explicit boolean inert; remove it only when no modern resize was
              // supplied so both spellings retain their documented behavior.
              ...(args.autoResizeHeight !== undefined && args.resize === undefined
                ? { resize: undefined }
                : {}),
              ...(args.preset === undefined ? {} : { preset: args.preset }),
              ...(args.density === undefined ? {} : { density: args.density }),
              ...(args.sortBy === undefined ? {} : { sortBy: args.sortBy }),
              ...(args.sortDirection === undefined ? {} : { sortDirection: args.sortDirection }),
              ...(args.columns === undefined ? {} : { columns: args.columns ?? undefined }),
              ...(args.gap === undefined ? {} : { gap: args.gap }),
              ...(args.autoResizeHeight === undefined
                ? {}
                : { autoResizeHeight: args.autoResizeHeight }),
              ...(args.resize === undefined ? {} : { resize: args.resize }),
              ...(args.onOverflow === undefined ? {} : { onOverflow: args.onOverflow }),
            } satisfies Partial<ZoneLayoutPolicy>);
      const layoutBinding = args.useBoardDefaults === true ? 'inherit' : 'override';
      const updatedZone = { ...zone, layout, layout_binding: layoutBinding };
      const changed =
        layoutBinding !== zoneLayoutBinding(zone) ||
        JSON.stringify(layout) !== JSON.stringify(normalizeZoneLayoutPolicy(zone.layout));
      if (changed) {
        await boardsService.patch(
          boardId,
          {
            _action: 'upsertObject',
            objectId: zoneId,
            objectData: updatedZone,
          } as unknown as Partial<Board>,
          ctx.baseServiceParams
        );
      }
      return textResult({
        boardId,
        zoneId,
        layout,
        layoutBinding,
        note: changed ? 'Zone layout policy updated.' : 'Zone layout policy already matched.',
      });
    }
  );

  server.registerTool(
    'agor_boards_set_zone_defaults',
    {
      description:
        'Set the authoritative layout policy inherited by new/reset zones. Existing overrides are preserved unless applyToExisting is true; current inherited zones always continue following the policy.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        mode: z.enum(ZONE_LAYOUT_MODES).optional(),
        preset: z.enum(ZONE_LAYOUT_PRESETS).optional(),
        density: z.enum(['preserve', 'expand', 'collapse']).optional(),
        sortBy: z.enum(ZONE_LAYOUT_SORT_FIELDS).optional(),
        sortDirection: z.enum(ZONE_LAYOUT_SORT_DIRECTIONS).optional(),
        resize: z.enum(ZONE_RESIZE_MODES).optional(),
        onOverflow: z.enum(ZONE_OVERFLOW_STRATEGIES).optional(),
        columns: z.number().int().positive().nullable().optional(),
        gap: z.number().int().min(0).max(96).optional(),
        applyToExisting: z
          .boolean()
          .optional()
          .describe('Reset every existing zone to this policy and make it inherit.'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const boardsService = ctx.app.service('boards');
      const board = (await boardsService.get(boardId, ctx.baseServiceParams)) as Board;
      const current = normalizeZoneLayoutPolicy(board.zone_layout_defaults);
      const defaults = normalizeZoneLayoutPolicy({
        ...current,
        ...(args.mode === undefined ? {} : { mode: args.mode }),
        ...(args.preset === undefined ? {} : { preset: args.preset }),
        ...(args.density === undefined ? {} : { density: args.density }),
        ...(args.sortBy === undefined ? {} : { sortBy: args.sortBy }),
        ...(args.sortDirection === undefined ? {} : { sortDirection: args.sortDirection }),
        ...(args.resize === undefined ? {} : { resize: args.resize }),
        ...(args.onOverflow === undefined ? {} : { onOverflow: args.onOverflow }),
        ...(args.columns === undefined ? {} : { columns: args.columns ?? undefined }),
        ...(args.gap === undefined ? {} : { gap: args.gap }),
      });
      const expected = {
        defaults: current,
        zones: Object.fromEntries(
          Object.entries(board.objects ?? {}).flatMap(([objectId, object]) =>
            object.type === 'zone'
              ? [
                  [
                    objectId,
                    {
                      binding: zoneLayoutBinding(object),
                      layout: normalizeZoneLayoutPolicy(object.layout),
                    },
                  ] as const,
                ]
              : []
          )
        ),
      };
      const result = (await boardsService.patch(
        boardId,
        {
          _action: 'setZoneLayoutDefaults',
          defaults,
          applyToExisting: args.applyToExisting === true,
          expected,
        } as unknown as Partial<Board>,
        ctx.baseServiceParams
      )) as unknown as {
        board: Board;
        changed: boolean;
        changed_zone_ids: string[];
      };
      return textResult({
        boardId,
        defaults,
        changed: result.changed,
        changedZoneIds: result.changed_zone_ids,
        note: result.changed
          ? 'Board zone defaults updated.'
          : 'Board zone defaults already matched.',
      });
    }
  );

  // agor_boards_set_compact
  server.registerTool(
    'agor_boards_set_compact',
    {
      description:
        'Collapse or expand worktrees and generic cards with description/note body content in the shared board presentation. Header-only cards, artifacts, notes, and apps are never targeted. Target explicit placement IDs, a zone, or the entire board.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        compact: z.boolean().describe('true hides capable card body content; false restores it.'),
        objectIds: z
          .array(mcpRequiredString('objectId', 'Board object ID'))
          .min(1)
          .optional()
          .describe('Specific board placement IDs to update.'),
        zoneId: mcpOptionalString('zoneId', 'Zone object ID'),
        entityType: z
          .enum(BOARD_DENSITY_EXPANDABLE_ENTITY_TYPES)
          .optional()
          .describe('Limit targets to worktree or generic-card placements.'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const boardObjectsService = ctx.app.service('board-objects');
      const requestedIds = new Set(args.objectIds ?? []);
      const found = (await boardObjectsService.find({
        query: {
          board_id: boardId,
          ...(args.zoneId ? { zone_id: args.zoneId } : {}),
          ...(args.entityType ? { entity_type: args.entityType } : {}),
        },
        ...ctx.baseServiceParams,
      })) as { data: Array<BoardEntityObject> };
      const selected = requestedIds.size
        ? found.data.filter((object) => requestedIds.has(object.object_id))
        : found.data;
      if (requestedIds.size && selected.length !== requestedIds.size) {
        throw new Error('One or more board object IDs do not belong to this accessible board.');
      }
      const metadata = await loadEntityLayoutMetadata(
        ctx,
        selected.filter((object) => object.entity_type === 'card')
      );
      const capable = selected.filter((object) =>
        isBoardEntityDensityExpandable(object.entity_type, metadata.get(object.object_id)?.card)
      );
      if (requestedIds.size && capable.length !== selected.length) {
        throw new Error(
          'Compact presentation is supported only for worktrees and generic cards with body content.'
        );
      }
      const targets = capable.filter((object) => (object.compact === true) !== args.compact);
      if (targets.length === 0) {
        return textResult({ boardId, compact: args.compact, updated: 0, updates: [] });
      }
      const updates = await Promise.all(
        targets.map(async (object) => {
          const updated = (await boardObjectsService.patch(
            object.object_id,
            { compact: args.compact },
            ctx.baseServiceParams
          )) as BoardEntityObject;
          return {
            objectId: updated.object_id,
            entityType: updated.entity_type,
            compact: updated.compact === true,
          };
        })
      );
      return textResult({ boardId, compact: args.compact, updated: updates.length, updates });
    }
  );

  // agor_boards_create
  server.registerTool(
    'agor_boards_create',
    {
      description: 'Create a new board. Returns the created board object with its ID and URL.',
      inputSchema: z.object({
        name: mcpRequiredString('name', 'Board name (required)'),
        slug: mcpOptionalString(
          'slug',
          'URL-friendly slug (optional, auto-derived from name if not provided)'
        ),
        description: mcpOptionalString('description', 'Board description (optional)'),
        icon: mcpOptionalString(
          'icon',
          'Board icon/emoji (optional, e.g. "📋"). Unicode emoji is preferred; common exact shortcodes like ":compass:" are accepted and normalized.'
        ),
        color: mcpOptionalString('color', 'Board color in hex format (optional)'),
        backgroundColor: mcpOptionalString(
          'backgroundColor',
          'Board background color in hex format (optional)'
        ),
        customCss: mcpOptionalString(
          'customCss',
          'Custom CSS for board canvas animations (@keyframes, animation, etc.). Optional.'
        ),
        defaultOthersCan: z.enum(BRANCH_PERMISSION_LEVELS).optional(),
        defaultOthersFsAccess: z.enum(['none', 'read', 'write']).optional(),
      }),
    },
    async (args) => {
      const boardName = coerceString(args.name);
      if (!boardName) throw new Error('name is required');

      const boardData: Record<string, unknown> = {
        name: boardName,
        created_by: ctx.userId,
      };
      if (args.slug !== undefined) boardData.slug = coerceString(args.slug);
      if (args.description !== undefined) boardData.description = coerceString(args.description);
      if (args.icon !== undefined) boardData.icon = coerceString(args.icon);
      if (args.color !== undefined) boardData.color = coerceString(args.color);
      if (args.backgroundColor !== undefined)
        boardData.background_color = coerceString(args.backgroundColor);
      if (args.customCss !== undefined) boardData.custom_css = coerceString(args.customCss);
      if (args.defaultOthersCan !== undefined) boardData.default_others_can = args.defaultOthersCan;
      if (args.defaultOthersFsAccess !== undefined)
        boardData.default_others_fs_access = args.defaultOthersFsAccess;

      const board = await ctx.app.service('boards').create(boardData, ctx.baseServiceParams);
      return textResult(board);
    }
  );

  // agor_boards_archive
  server.registerTool(
    'agor_boards_archive',
    {
      description:
        'Archive a board (soft delete). Archived boards are hidden from listings by default. Use agor_boards_unarchive to restore.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board', 'Board ID to archive (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId)!;
      const boardsService = ctx.app.service('boards') as unknown as BoardsServiceImpl;
      // archive() is a custom (non-transport) method that reads/patches over
      // `this.db` without an internal scope helper, so re-enter the tenant DB
      // scope here (the HTTP archive route enters it via its around hook).
      const result = await runWithMcpTenantDatabaseWrite(ctx, () =>
        boardsService.archive(boardId, ctx.baseServiceParams)
      );
      return textResult({
        success: true,
        board: result,
        message: 'Board archived successfully.',
      });
    }
  );

  // agor_boards_unarchive
  server.registerTool(
    'agor_boards_unarchive',
    {
      description: 'Restore a previously archived board. The board will appear in listings again.',
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board', 'Board ID to unarchive (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId)!;
      const boardsService = ctx.app.service('boards') as unknown as BoardsServiceImpl;
      // Custom (non-transport) method — enter the tenant DB scope like the HTTP
      // unarchive route's around hook would.
      const result = await runWithMcpTenantDatabaseWrite(ctx, () =>
        boardsService.unarchive(boardId, ctx.baseServiceParams)
      );
      return textResult({
        success: true,
        board: result,
        message: 'Board unarchived successfully.',
      });
    }
  );

  // agor_boards_arrange_zones
  server.registerTool(
    'agor_boards_arrange_zones',
    {
      description:
        "Arrange a board's zones, free worktrees/cards, and canvas objects through the authoritative board planner. Grid (default) builds justified photo-style rows; Compact minimizes cluster diameter. Each eligible zone is packed inside-out before its final frame joins visible free items. Disable packZoneContents to preserve zone frames and child-relative geometry. The complete plan is committed atomically.",
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        mode: z
          .enum(['grid', 'compact'])
          .optional()
          .describe('Outer board presentation (default: grid).'),
        density: z
          .enum(['preserve', 'expand', 'collapse'])
          .optional()
          .describe(
            'Content expansion policy (default: preserve). Geometry presets never imply a density change. packZoneContents=false forces preserve because children are not changed.'
          ),
        targetWidth: mcpOptionalPositiveInt(
          'targetWidth',
          'Width each full row is stretched to (default: 1600).'
        ),
        targetRowHeight: mcpOptionalPositiveInt(
          'targetRowHeight',
          'Preferred row height (default: 600).'
        ),
        gap: mcpOptionalNonNegativeInt('gap', 'Space between zones (default: 40).'),
        startX: mcpOptionalNumber('startX', 'Canvas X origin (default: 80).'),
        startY: mcpOptionalNumber('startY', 'Canvas Y origin (default: 80).'),
        maxPerRow: mcpOptionalPositiveInt('maxPerRow', 'Upper bound on zones per row.'),
        justifyLastRow: z
          .boolean()
          .optional()
          .describe(
            'Stretch the final row even when it is underfull (default: false, matching a photo grid).'
          ),
        justifyRows: z
          .boolean()
          .optional()
          .describe('Stretch complete Grid rows toward targetWidth (default: true).'),
        resizeZoneFrames: z
          .boolean()
          .optional()
          .describe(
            'Allow packed zone frames to match row tracks (default: true). False preserves safe frames; undersized frames still grow.'
          ),
        lastRowAlignment: z
          .enum(['start', 'center', 'end'])
          .optional()
          .describe('Alignment for an underfull final Grid row (default: start).'),
        packZoneContents: z
          .boolean()
          .optional()
          .describe(
            'Pack each eligible zone inside-out and replace its manual size floor before arranging the final frames (default: true). False preserves zone frames and child-relative geometry.'
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe('Compute and return the layout without writing any zone.'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const density = args.packZoneContents === false ? 'preserve' : (args.density ?? 'preserve');

      const arranged = await arrangeBoardZones(ctx, boardId, {
        mode: args.mode,
        density,
        targetWidth: args.targetWidth,
        targetRowHeight: args.targetRowHeight,
        gap: args.gap,
        startX: args.startX,
        startY: args.startY,
        maxPerRow: args.maxPerRow,
        justifyLastRow: args.justifyLastRow === true,
        justifyRows: args.justifyRows !== false,
        resizeZoneFrames: args.resizeZoneFrames !== false,
        lastRowAlignment: args.lastRowAlignment,
        packZoneContents: args.packZoneContents !== false,
        dryRun: args.dryRun === true,
      });

      if (!arranged) {
        return textResult({
          boardId,
          arranged: 0,
          rows: 0,
          updates: [],
          note: 'No eligible visible board roots.',
        });
      }
      const { plan, byId } = arranged;
      const { layout } = plan;

      return textResult({
        boardId,
        arranged: layout.placements.length,
        rows: layout.rows,
        width: layout.width,
        height: layout.height,
        gap: layout.gap,
        rowHeights: layout.rowHeights,
        dryRun: args.dryRun === true,
        packZoneContents: args.packZoneContents !== false,
        density,
        overflowingRows: layout.overflowingRows,
        warning:
          layout.overflowingRows.length > 0
            ? `Row(s) ${layout.overflowingRows.join(', ')} hold a zone wider than targetWidth even at its narrowest shape; they were left at their natural width. Raise targetWidth or move a zone.`
            : null,
        note: 'Eligible roots, zone frames, and child placements were planned together.',
        arrangedLooseItems: plan.looseItems.length,
        looseUpdates: plan.looseItems.map((item) => ({
          objectId: item.id,
          position: { x: item.x, y: item.y },
          size: { width: item.width, height: item.height },
        })),
        updates: plan.zones.map((zone) => ({
          objectId: zone.id,
          label: byId.get(zone.id)?.zone.label ?? null,
          itemCount: byId.get(zone.id)?.itemCount ?? 0,
          arrangedItems: zone.items.length,
          position: zone.position,
          size: { width: zone.width, height: zone.height },
          row: zone.row,
          column: zone.column,
          contentColumns: zone.contentColumns,
          slackY: zone.slackY,
        })),
      });
    }
  );
}
