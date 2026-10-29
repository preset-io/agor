import type { Position } from './coordinateTransforms';

export interface DrawnRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Screen pixels a drag must cover on both axes to draw a zone rather than count as a click. */
const ZONE_DRAG_THRESHOLD = 50;

export function isZoneDrag(start: Position, end: Position): boolean {
  return (
    Math.abs(end.x - start.x) > ZONE_DRAG_THRESHOLD &&
    Math.abs(end.y - start.y) > ZONE_DRAG_THRESHOLD
  );
}

/** Which way a drag went from its start; true grows the rectangle left or up. */
export interface DragDirection {
  left: boolean;
  up: boolean;
}

function dragDirection(start: Position, end: Position): DragDirection {
  return { left: end.x < start.x, up: end.y < start.y };
}

/**
 * The rectangle between two points, at least `minWidth` by `minHeight`. It stays
 * pinned to `start` and grows toward `end` (or `direction`, when given), so a
 * small drag up or left never spreads past its start.
 */
export function anchoredZoneRect(
  start: Position,
  end: Position,
  minWidth: number,
  minHeight: number,
  direction: DragDirection = dragDirection(start, end)
): DrawnRect {
  const width = Math.max(minWidth, Math.abs(end.x - start.x));
  const height = Math.max(minHeight, Math.abs(end.y - start.y));
  return {
    x: direction.left ? start.x - width : start.x,
    y: direction.up ? start.y - height : start.y,
    width,
    height,
  };
}

/** The two React Flow conversions drawing needs; both use client (screen) coordinates. */
export interface ZoneDrawingFlow {
  screenToFlowPosition(position: Position): Position;
  flowToScreenPosition(position: Position): Position;
}

/**
 * The zone a drag from `start` to `end` (screen points) creates, in flow space:
 * zoom and grid snap applied, never smaller than the minimum, pinned to the
 * start corner and grown in the direction the pointer moved on screen.
 */
export function drawnZoneFlowRect(
  flow: ZoneDrawingFlow,
  start: Position,
  end: Position,
  minWidth: number,
  minHeight: number
): DrawnRect {
  // Direction comes from the screen drag: grid snap can collapse the flow points onto one axis.
  return anchoredZoneRect(
    flow.screenToFlowPosition(start),
    flow.screenToFlowPosition(end),
    minWidth,
    minHeight,
    dragDirection(start, end)
  );
}

/**
 * Screen rectangle to preview while drawing: exactly the zone releasing here
 * creates, or just the dragged box while the drag is too small to count.
 */
export function zoneDrawingPreviewRect(
  flow: ZoneDrawingFlow,
  start: Position,
  end: Position,
  minWidth: number,
  minHeight: number
): DrawnRect {
  if (!isZoneDrag(start, end)) return anchoredZoneRect(start, end, 0, 0);
  const rect = drawnZoneFlowRect(flow, start, end, minWidth, minHeight);
  const topLeft = flow.flowToScreenPosition({ x: rect.x, y: rect.y });
  const bottomRight = flow.flowToScreenPosition({
    x: rect.x + rect.width,
    y: rect.y + rect.height,
  });
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}
