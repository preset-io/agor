import {
  type AutoZoneLayout,
  isAutoZoneLayout,
  planZoneGrid,
  readZoneGridOrder,
  ZONE_GRID_COLUMN_WIDTH,
  zoneLayoutOf,
} from '@agor/core/utils/zone-layout';
import type { BoardPosition } from '@agor-live/client';
import type { Node } from 'reactflow';

export interface MeasuredNodeSize {
  width: number;
  height: number;
}

export interface ZoneGridLayoutInputs {
  /** Rendered sizes reported by React Flow's own measurement. */
  measuredSizes: ReadonlyMap<string, MeasuredNodeSize>;
  /** Stored zone-relative position of a pinned node: its order key in an auto zone. */
  storedPositionOf: (nodeId: string) => BoardPosition | undefined;
  /** An order held while a layout switch saves its positions one by one. */
  heldOrderOf?: (zoneId: string) => readonly string[] | undefined;
}

/** The order a zone shows its pinned nodes in. */
export function zoneGridOrder(
  zone: Node,
  children: readonly Node[],
  inputs: Pick<ZoneGridLayoutInputs, 'storedPositionOf' | 'heldOrderOf'>
): Node[] {
  const read = readZoneGridOrder(
    zoneWidthOf(zone),
    children.map((child) => ({
      id: child.id,
      position: inputs.storedPositionOf(child.id) ?? child.position,
      child,
    }))
  ).map((item) => item.child);
  const held = inputs.heldOrderOf?.(zone.id);
  if (!held) return read;
  const rank = new Map(held.map((id, index) => [id, index]));
  return read
    .map((child, index) => ({ child, key: rank.get(child.id) ?? held.length + index }))
    .sort((a, b) => a.key - b.key)
    .map(({ child }) => child);
}

/** The width people set; a grid may show wider to fit its columns. */
function zoneWidthOf(zone: Node) {
  return Number(zone.data?.width) || 0;
}

const PINNED_ENTITY_TYPES = new Set(['branchNode', 'cardNode']);
/** Fallback heights until React Flow reports a measurement. */
const FALLBACK_HEIGHT: Record<string, number> = { branchNode: 200, cardNode: 120 };
const BASE_ENTITY_Z_INDEX = 500;
/** Marks nodes the grid places, so the canvas stylesheet can glide them between slots. */
export const ZONE_GRID_CHILD_CLASS = 'zone-grid-child';

function withChildClass(className: string | undefined) {
  if (className?.split(' ').includes(ZONE_GRID_CHILD_CLASS)) return className;
  return className ? `${className} ${ZONE_GRID_CHILD_CLASS}` : ZONE_GRID_CHILD_CLASS;
}

/** The auto layout of a zone node, or undefined when the zone is free. */
export function autoLayoutOfZoneNode(node: Node | undefined): AutoZoneLayout | undefined {
  if (node?.type !== 'zone') return undefined;
  const layout = zoneLayoutOf(node.data);
  return isAutoZoneLayout(layout) ? layout : undefined;
}

function sameNumber(a: unknown, b: number) {
  return typeof a === 'number' && Math.abs(a - b) < 0.5;
}

/**
 * Place every branch and card pinned to a grid or list zone. Those zones fit
 * their height to their cards and widen if a grid's columns need it. Display-only: nothing here is persisted. Returns the same
 * array when nothing moved, so callers can feed it straight into setNodes
 * without a render loop.
 */
export function applyZoneGridLayouts(nodes: Node[], inputs: ZoneGridLayoutInputs): Node[] {
  const autoZones = new Map<string, { node: Node; layout: AutoZoneLayout }>();
  for (const node of nodes) {
    const layout = autoLayoutOfZoneNode(node);
    if (layout) autoZones.set(node.id, { node, layout });
  }
  if (autoZones.size === 0) return nodes;

  const childrenByZone = new Map<string, Node[]>();
  for (const node of nodes) {
    if (!node.parentId || !PINNED_ENTITY_TYPES.has(node.type ?? '')) continue;
    if (!autoZones.has(node.parentId)) continue;
    const siblings = childrenByZone.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByZone.set(node.parentId, siblings);
  }

  const childUpdates = new Map<string, { position: BoardPosition; zIndex: number }>();
  const zoneSizes = new Map<string, { width: number; height: number }>();
  for (const [zoneId, { node: zone, layout }] of autoZones) {
    const ordered = zoneGridOrder(zone, childrenByZone.get(zoneId) ?? [], inputs);
    const plan = planZoneGrid(
      layout,
      zoneWidthOf(zone),
      ordered.map((child) => ({
        id: child.id,
        height:
          inputs.measuredSizes.get(child.id)?.height ?? FALLBACK_HEIGHT[child.type ?? ''] ?? 200,
      }))
    );
    for (const item of ordered) {
      const position = plan.positions.get(item.id);
      if (!position) continue;
      // A card widened for a session peek floats over its right-hand neighbor.
      const wide = (inputs.measuredSizes.get(item.id)?.width ?? 0) > ZONE_GRID_COLUMN_WIDTH + 1;
      childUpdates.set(item.id, {
        position,
        zIndex: wide ? BASE_ENTITY_Z_INDEX + 1 : BASE_ENTITY_Z_INDEX,
      });
    }
    zoneSizes.set(zoneId, {
      width: Math.max(zoneWidthOf(zone), plan.contentWidth),
      height: plan.contentHeight,
    });
  }

  let changed = false;
  const next = nodes.map((node) => {
    const childUpdate = childUpdates.get(node.id);
    if (childUpdate) {
      const { position, zIndex } = childUpdate;
      const className = withChildClass(node.className);
      if (
        sameNumber(node.position.x, position.x) &&
        sameNumber(node.position.y, position.y) &&
        node.zIndex === zIndex &&
        node.className === className
      ) {
        return node;
      }
      changed = true;
      return { ...node, position, zIndex, className };
    }
    const size = zoneSizes.get(node.id);
    if (size) {
      const { width, height } = size;
      if (
        sameNumber(node.style?.width, width) &&
        sameNumber(node.width, width) &&
        sameNumber(node.style?.height, height) &&
        sameNumber(node.height, height)
      ) {
        return node;
      }
      changed = true;
      return { ...node, width, height, style: { ...node.style, width, height } };
    }
    return node;
  });
  return changed ? next : nodes;
}
