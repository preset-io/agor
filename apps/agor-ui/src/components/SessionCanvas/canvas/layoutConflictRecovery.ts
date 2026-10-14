import type { AgorClient, Board, BoardEntityObject, BoardObject } from '@agor-live/client';
import type { Node } from 'reactflow';

export const MAX_LAYOUT_STALE_REPLANS = 1;

const STALE_LAYOUT_MESSAGE = 'Board layout source snapshot is stale';
const SUPPORTED_CANVAS_NODE_TYPES = new Set(['zone', 'markdown', 'appNode', 'artifactNode']);
const MATERIAL_NODE_TYPES = new Set([...SUPPORTED_CANVAS_NODE_TYPES, 'branchNode', 'cardNode']);

const placementNodeId = (placement: BoardEntityObject): string | undefined =>
  placement.branch_id ?? (placement.card_id ? `card-${placement.card_id}` : undefined);

const boardObjectNodeType = (object: BoardObject): string | undefined => {
  switch (object.type) {
    case 'zone':
      return 'zone';
    case 'markdown':
      return 'markdown';
    case 'app':
      return 'appNode';
    case 'artifact':
      return 'artifactNode';
    default:
      return undefined;
  }
};

const finitePoint = (point: { x: number; y: number } | undefined): boolean =>
  Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));

const finiteSize = (size: { width: number; height: number } | undefined): boolean =>
  Boolean(
    size &&
      Number.isFinite(size.width) &&
      size.width > 0 &&
      Number.isFinite(size.height) &&
      size.height > 0
  );

/** Narrowly identify the repository's optimistic-layout conflict. */
export function isBoardLayoutSnapshotStale(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === 'string' && current.includes(STALE_LAYOUT_MESSAGE)) return true;
    if (typeof current !== 'object') return false;
    const record = current as { message?: unknown; cause?: unknown };
    if (typeof record.message === 'string' && record.message.includes(STALE_LAYOUT_MESSAGE)) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

export interface AuthoritativeLayoutSource {
  board: Board;
  placements: BoardEntityObject[];
  nodes: Node[];
}

/**
 * Rebuild the rendered graph's durable geometry from a fresh server read.
 *
 * Layout still needs local DOM measurements and entity metadata, so this does
 * not replace nodes wholesale. It requires the material id set to match first:
 * a just-created/deleted object that has not reached the renderer makes a safe
 * replan impossible and is cancelled rather than planned around incomplete
 * obstacles. Repository validation remains the final authority if the two
 * read requests themselves race another mutation.
 */
export function rebaseNodesOnAuthoritativeLayout(
  board: Board,
  placements: readonly BoardEntityObject[],
  renderedNodes: readonly Node[]
): Node[] | null {
  const objectById = new Map(
    Object.entries(board.objects ?? {}).flatMap(([id, object]) =>
      boardObjectNodeType(object) ? ([[id, object]] as const) : []
    )
  );
  const placementByNodeId = new Map(
    placements.flatMap((placement) => {
      const nodeId = placementNodeId(placement);
      return nodeId ? ([[nodeId, placement]] as const) : [];
    })
  );
  const authoritativeIds = new Set([...objectById.keys(), ...placementByNodeId.keys()]);
  const renderedIds = new Set(
    renderedNodes.flatMap((node) => (MATERIAL_NODE_TYPES.has(node.type ?? '') ? [node.id] : []))
  );
  if (
    authoritativeIds.size !== renderedIds.size ||
    [...authoritativeIds].some((id) => !renderedIds.has(id))
  ) {
    return null;
  }

  const zoneIds = new Set(
    [...objectById].flatMap(([id, object]) => (object.type === 'zone' ? [id] : []))
  );
  const rebased: Node[] = [];
  for (const node of renderedNodes) {
    const object = objectById.get(node.id);
    if (object) {
      if (!finitePoint(object)) return null;
      const width = 'width' in object ? object.width : undefined;
      const height = 'height' in object ? object.height : undefined;
      const widthRequired =
        object.type === 'zone' ||
        object.type === 'markdown' ||
        object.type === 'app' ||
        object.type === 'artifact';
      const heightRequired =
        object.type === 'zone' || object.type === 'app' || object.type === 'artifact';
      if (
        (widthRequired && (width === undefined || !Number.isFinite(width) || width <= 0)) ||
        (heightRequired && (height === undefined || !Number.isFinite(height) || height <= 0))
      ) {
        return null;
      }
      rebased.push({
        ...node,
        position: { x: object.x, y: object.y },
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        style: {
          ...node.style,
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
        },
      });
      continue;
    }

    const placement = placementByNodeId.get(node.id);
    if (!placement) {
      rebased.push(node);
      continue;
    }
    if (!finitePoint(placement.position) || (placement.size && !finiteSize(placement.size))) {
      return null;
    }
    const { parentId: _parentId, extent: _extent, ...unparented } = node;
    const parentId = placement.zone_id && zoneIds.has(placement.zone_id) ? placement.zone_id : null;
    rebased.push({
      ...unparented,
      ...(parentId ? { parentId, extent: 'parent' as const } : {}),
      position: { ...placement.position },
      ...(placement.size ? { width: placement.size.width, height: placement.size.height } : {}),
      style: {
        ...node.style,
        ...(placement.size ? { width: placement.size.width, height: placement.size.height } : {}),
      },
      data: { ...node.data, compact: placement.compact === true },
    });
  }
  return rebased;
}

/** Fetch both tenant/RBAC-scoped persistence surfaces before one bounded replan. */
export async function fetchAuthoritativeLayoutSource(
  client: AgorClient,
  boardId: string,
  renderedNodes: readonly Node[]
): Promise<AuthoritativeLayoutSource | null> {
  const [board, placements] = await Promise.all([
    client.service('boards').get(boardId) as Promise<Board>,
    client.service('board-objects').findAll({
      query: { board_id: boardId },
    }) as Promise<BoardEntityObject[]>,
  ]);
  const nodes = rebaseNodesOnAuthoritativeLayout(board, placements, renderedNodes);
  return nodes ? { board, placements, nodes } : null;
}
