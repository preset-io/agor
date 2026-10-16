import {
  type AutoZoneLayout,
  isAutoZoneLayout,
  orderZoneEntities,
  planZoneGrid,
  sanitizeZoneOrder,
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
  /** Stored zone-relative position: orders pinned nodes the zone hasn't listed yet. */
  storedPositionOf: (nodeId: string) => BoardPosition | undefined;
  /** An order shown while its save is on the way. */
  heldOrderOf?: (zoneId: string) => readonly string[] | undefined;
  /** Hide cards not measured yet, so they never show in a guessed slot. */
  hideUnmeasured?: boolean;
  /** A card moving out (its drop not yet saved) is left where it was dropped. */
  isMoving?: (nodeId: string) => boolean;
}

/** The order a zone shows its pinned nodes in. */
export function zoneGridOrder(
  zone: Node,
  children: readonly Node[],
  inputs: Pick<ZoneGridLayoutInputs, 'storedPositionOf' | 'heldOrderOf'>
): Node[] {
  const read = orderZoneEntities(
    sanitizeZoneOrder(zone.data?.order),
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
/** Marks nodes the grid places, so the canvas stylesheet can glide them between slots. */
export const ZONE_GRID_CHILD_CLASS = 'zone-grid-child';
/** Stacking order for a card wider than its slot, just above the other cards (500). */
const WIDE_Z_INDEX = 501;

function withChildClasses(className: string | undefined) {
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
 * Place every branch and card pinned to an arranged zone (row, column or
 * grid), stretched to columns that fill the zone's width. Those zones fit
 * their height to their cards, and their width to the columns. Display-only: nothing here is persisted. Returns the same
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
    if (!autoZones.has(node.parentId) || inputs.isMoving?.(node.id)) continue;
    const siblings = childrenByZone.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByZone.set(node.parentId, siblings);
  }

  const childUpdates = new Map<
    string,
    { position: BoardPosition; wide: boolean; slotWidth: number; hidden: boolean }
  >();
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
      const wide = (inputs.measuredSizes.get(item.id)?.width ?? 0) > plan.columnWidth + 1;
      childUpdates.set(item.id, {
        position,
        wide,
        slotWidth: plan.columnWidth,
        hidden: !!inputs.hideUnmeasured && !inputs.measuredSizes.has(item.id),
      });
    }
    zoneSizes.set(zoneId, { width: plan.contentWidth, height: plan.contentHeight });
  }

  let changed = false;
  const next = nodes.map((node) => {
    const childUpdate = childUpdates.get(node.id);
    if (childUpdate) {
      const { position, wide, slotWidth, hidden } = childUpdate;
      const className = withChildClasses(node.className);
      if (
        sameNumber(node.position.x, position.x) &&
        sameNumber(node.position.y, position.y) &&
        node.className === className &&
        node.data?.slotWidth === slotWidth &&
        (node.style?.visibility === 'hidden') === hidden &&
        (node.style?.zIndex === WIDE_Z_INDEX) === wide
      ) {
        return node;
      }
      changed = true;
      // Only set visibility to hide: React Flow keeps its own hidden-until-measured otherwise.
      const { visibility: _visibility, zIndex: _zIndex, ...style } = node.style ?? {};
      // Cards stretch to their slot, so a zone's columns fill its width.
      return {
        ...node,
        position,
        className,
        style: {
          ...style,
          ...(hidden ? { visibility: 'hidden' as const } : {}),
          // A card widened for a session peek floats over its neighbour in the next column.
          ...(wide ? { zIndex: WIDE_Z_INDEX } : {}),
        },
        data: { ...node.data, slotWidth },
      };
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
