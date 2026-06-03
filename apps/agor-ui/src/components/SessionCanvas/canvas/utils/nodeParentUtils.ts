import type { BoardObject } from '@agor-live/client';
import type { Node } from 'reactflow';

/**
 * React Flow throws during setNodes/render if a node references a parentId
 * that is not present in the same node list. Keep this validation close to
 * node construction so stale zone references degrade to unparented nodes
 * instead of crashing the entire board.
 */
export function sanitizeOrphanedNodeParents(
  nodes: Node[],
  options?: {
    onOrphan?: (node: Node, missingParentId: string) => void;
  }
): Node[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  let changed = false;

  const sanitized = nodes.map((node) => {
    if (node.parentId && !nodeIds.has(node.parentId)) {
      changed = true;
      options?.onOrphan?.(node, node.parentId);
      return { ...node, parentId: undefined };
    }
    return node;
  });

  return changed ? sanitized : nodes;
}

export function isRenderableZoneObject(object: BoardObject | undefined): boolean {
  return (
    object?.type === 'zone' &&
    Number.isFinite(object.x) &&
    Number.isFinite(object.y) &&
    Number.isFinite(object.width) &&
    Number.isFinite(object.height)
  );
}

/**
 * Zone IDs stored on board entity rows are trusted only if the corresponding
 * board.objects entry still exists and is a renderable zone. A stale zone_id
 * can otherwise become a React Flow parentId with no parent node.
 */
export function getValidZoneParentId(
  zoneId: string | null | undefined,
  boardObjects: Record<string, BoardObject> | undefined,
  options?: {
    entityId?: string;
    onInvalid?: (entityId: string | undefined, zoneId: string, reason: string) => void;
  }
): string | undefined {
  if (!zoneId) return undefined;

  const zone = boardObjects?.[zoneId];
  if (!zone) {
    options?.onInvalid?.(options.entityId, zoneId, 'missing zone object');
    return undefined;
  }

  if (!isRenderableZoneObject(zone)) {
    options?.onInvalid?.(options.entityId, zoneId, 'zone object is not renderable');
    return undefined;
  }

  return zoneId;
}
