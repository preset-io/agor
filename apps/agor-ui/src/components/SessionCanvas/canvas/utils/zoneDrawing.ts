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

/**
 * The rectangle between two points, at least `minWidth` by `minHeight`. It stays
 * pinned to `start` and grows toward `end`, so a small drag up or left never
 * spreads past its start.
 */
export function anchoredZoneRect(
  start: Position,
  end: Position,
  minWidth: number,
  minHeight: number
): DrawnRect {
  const width = Math.max(minWidth, Math.abs(end.x - start.x));
  const height = Math.max(minHeight, Math.abs(end.y - start.y));
  return {
    x: end.x < start.x ? start.x - width : start.x,
    y: end.y < start.y ? start.y - height : start.y,
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
  const anchor = flow.screenToFlowPosition(start);
  const corner = flow.screenToFlowPosition(end);
  const width = Math.max(minWidth, Math.abs(corner.x - anchor.x));
  const height = Math.max(minHeight, Math.abs(corner.y - anchor.y));
  return {
    x: end.x < start.x ? anchor.x - width : anchor.x,
    y: end.y < start.y ? anchor.y - height : anchor.y,
    width,
    height,
  };
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
