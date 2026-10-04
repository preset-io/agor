import { planZoneGrowthReflow } from '@agor/core/layout/zone-growth-reflow';
import {
  getZoneLayoutFrame,
  type NormalizedZoneLayoutPolicy,
  resolveZoneLayoutPolicy,
} from '@agor/core/layout/zone-layout';
import type {
  Board,
  BoardEntityObject,
  BoardID,
  BoardLayoutObjectUpdate,
  BoardObject,
  ZoneBoardObject,
} from '@agor/core/types';
import {
  BRANCH_CARD_HEIGHT,
  BRANCH_CARD_WIDTH,
  CARD_HEIGHT,
  CARD_WIDTH,
  planZoneSlot,
  type ZoneOccupantRectangle,
  type ZoneSlotPlan,
} from '@agor/core/utils/board-placement';

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Minimal service surface the zone-placement helpers need. Both the MCP tools
 * and daemon services hand in their Feathers app plus the caller's params, so
 * reads and the board write run under the caller's authorization and tenant.
 */
export interface ZonePlacementApp {
  service(name: 'board-objects' | 'boards'): unknown;
}

export function rectanglesOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function usableCanvasDimension(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

export function getCanvasObjectDimensions(object: BoardObject): { width: number; height: number } {
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
export function zonesOverlappedBy(board: Board, zoneId: string, rect: Rect): string[] {
  return Object.entries(board.objects ?? {}).flatMap(([objectId, object]) => {
    if (objectId === zoneId || object.type !== 'zone') return [];
    const { x, y, width, height } = object;
    return rectanglesOverlap(rect, { x, y, width, height }) ? [objectId] : [];
  });
}

export interface ZoneGrowthObjects {
  /** Canvas objects to write: the resized zone, reflowed neighbours, and their loose contents. */
  objects: Record<string, BoardObject>;
  resizedOverZoneIds: string[];
  movedZoneIds: string[];
}

/**
 * Plan the canvas writes for resizing one zone.
 *
 * Only a grow can newly cover a neighbour. When the zone policy says
 * `reflow_board`, newly covered zones move by the minimum collision-free shift
 * and loose canvas objects inside a moved zone travel with it; zone-pinned
 * entities are zone-relative and follow their parent without a write.
 */
export function planZoneGrowthObjects(
  board: Board,
  zoneId: string,
  size: { width: number; height: number },
  policy: Pick<NormalizedZoneLayoutPolicy, 'onOverflow' | 'columnGap' | 'rowGap'>
): ZoneGrowthObjects {
  const zone = board.objects?.[zoneId];
  if (zone?.type !== 'zone') throw new Error(`Zone ${zoneId} not found on board`);
  const resizedOverZoneIds =
    size.height > zone.height || size.width > zone.width
      ? zonesOverlappedBy(board, zoneId, { x: zone.x, y: zone.y, ...size })
      : [];
  const reflowPlan =
    policy.onOverflow === 'reflow_board' && resizedOverZoneIds.length > 0
      ? planZoneGrowthReflow(
          Object.entries(board.objects ?? {}).flatMap(([id, object]) =>
            object.type === 'zone' ? [{ id, ...object }] : []
          ),
          zoneId,
          { id: zoneId, x: zone.x, y: zone.y, ...size },
          { gapX: policy.columnGap, gapY: policy.rowGap }
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
      const dimensions = getCanvasObjectDimensions(object);
      const center = {
        x: object.x + dimensions.width / 2,
        y: object.y + dimensions.height / 2,
      };
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
            left.width * left.height - right.width * right.height || leftId.localeCompare(rightId)
        )[0];
      if (!sourceZone) return [];
      const placement = reflowPlan?.placements.find((item) => item.id === sourceZone[0]);
      if (!placement) return [];
      const deltaX = placement.x - sourceZone[1].x;
      const deltaY = placement.y - sourceZone[1].y;
      return [[objectId, { ...object, x: object.x + deltaX, y: object.y + deltaY }] as const];
    })
  );
  return {
    objects: {
      [zoneId]: { ...zone, ...size },
      ...reflowedZoneUpdates,
      ...translatedCanvasUpdates,
    },
    resizedOverZoneIds,
    movedZoneIds,
  };
}

/** Geometry snapshot for every canvas object, for an atomic layout commit. */
export function expectedCanvasGeometry(board: Board): Record<string, BoardLayoutObjectUpdate> {
  return Object.fromEntries(
    Object.entries(board.objects ?? {}).map(([objectId, object]) => [
      objectId,
      {
        x: object.x,
        y: object.y,
        ...('width' in object ? { width: object.width } : {}),
        ...('height' in object ? { height: object.height } : {}),
      },
    ])
  );
}

/**
 * Rectangles currently occupying a zone, in zone-relative coordinates.
 *
 * Sizes come from the entity's measured `size` when the browser has recorded
 * one, and otherwise from the nominal size for its kind — the same two-tier
 * sizing the board arrange tools use, because a worktree renders far taller
 * than a card and treating them alike is what makes a mixed zone collide.
 * Archived branches are not occupants: they are not rendered.
 */
export async function collectZoneOccupantRectangles(
  app: ZonePlacementApp,
  params: object,
  options: { boardId: BoardID; zoneId: string; excludeObjectId?: string }
): Promise<ZoneOccupantRectangle[]> {
  const boardObjects = app.service('board-objects') as {
    find(params: object): Promise<{ data: BoardEntityObject[] }>;
  };
  const result = await boardObjects.find({
    query: {
      board_id: options.boardId,
      zone_id: options.zoneId,
      exclude_archived_branches: true,
    },
    ...params,
  });

  return result.data.flatMap((entity) => {
    if (entity.object_id === options.excludeObjectId) return [];
    const size = entity.size;
    const usable =
      size !== undefined &&
      Number.isFinite(size.width) &&
      Number.isFinite(size.height) &&
      size.width > 0 &&
      size.height > 0;
    const nominal =
      entity.entity_type === 'branch'
        ? { width: BRANCH_CARD_WIDTH, height: BRANCH_CARD_HEIGHT }
        : { width: CARD_WIDTH, height: CARD_HEIGHT };
    const { width, height } = usable ? size : nominal;
    return [{ x: entity.position.x, y: entity.position.y, width, height }];
  });
}

export interface ZoneEntityPlacementPlan extends ZoneSlotPlan {
  boardId: BoardID;
  zoneId: string;
  growth: ZoneGrowthObjects | null;
}

/**
 * Plan a contained, collision-free zone slot for an entity using the zone's
 * own layout frame — the padding, row/column gaps, and title reserve the zone
 * arrange uses — so a pin lands where an arrange of that zone would put it.
 *
 * A zone whose resize policy allows growth grows to fit (see
 * {@link planZoneSlot}); a fixed zone with no room throws rather than leaving
 * the caller to fall back to an unpinned placement. No writes happen here.
 */
export async function planZoneEntityPlacement(
  app: ZonePlacementApp,
  params: object,
  options: {
    board: Board;
    zoneId: string;
    entityWidth?: number;
    entityHeight?: number;
    excludeObjectId?: string;
  }
): Promise<ZoneEntityPlacementPlan> {
  const { board, zoneId } = options;
  const zone = board.objects?.[zoneId];
  if (zone?.type !== 'zone') throw new Error(`Zone ${zoneId} not found on board ${board.board_id}`);
  const policy = resolveZoneLayoutPolicy(zone, board.zone_layout_defaults);
  const frame = getZoneLayoutFrame(zone as ZoneBoardObject, { padding: policy.padding });
  const occupants = await collectZoneOccupantRectangles(app, params, {
    boardId: board.board_id as BoardID,
    zoneId,
    excludeObjectId: options.excludeObjectId,
  });
  const slot = planZoneSlot(zone, occupants, {
    entityWidth: options.entityWidth ?? BRANCH_CARD_WIDTH,
    entityHeight: options.entityHeight ?? BRANCH_CARD_HEIGHT,
    padding: frame.padding,
    titleInset: frame.headerInset,
    gapX: policy.columnGap,
    gapY: policy.rowGap,
    resize: policy.resize ?? (policy.autoResizeHeight ? 'height' : 'fixed'),
  });
  return {
    ...slot,
    boardId: board.board_id as BoardID,
    zoneId,
    growth: slot.grew
      ? planZoneGrowthObjects(board, zoneId, { width: slot.width, height: slot.height }, policy)
      : null,
  };
}

/**
 * Persist the zone growth a placement plan needs, through the same atomic
 * `applyLayout` board write the zone arrange uses (so a concurrent geometry
 * change rejects instead of being overwritten). A no-op for a plan that fit.
 */
export async function commitZoneEntityPlacementGrowth(
  app: ZonePlacementApp,
  params: object,
  board: Board,
  plan: ZoneEntityPlacementPlan
): Promise<void> {
  if (!plan.growth) return;
  const boards = app.service('boards') as {
    patch(id: string, data: unknown, params?: object): Promise<unknown>;
  };
  await boards.patch(
    plan.boardId,
    {
      _action: 'applyLayout',
      objects: plan.growth.objects,
      placements: {},
      expected: { objects: expectedCanvasGeometry(board), placements: {} },
    },
    params
  );
}
