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
 * The rectangle a zone drag draws, at least `minWidth` by `minHeight`. It stays
 * pinned to the corner where the drag started and grows in the drag's
 * direction, so a small drag up or left never spreads past its start.
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

/**
 * Screen rectangle to preview while drawing: the zone that releasing here
 * creates, its flow-space minimum scaled by `zoom`; just the dragged box while
 * the drag is still too small to count.
 */
export function zoneDrawingPreviewRect(
  start: Position,
  end: Position,
  zoom: number,
  minWidth: number,
  minHeight: number
): DrawnRect {
  return isZoneDrag(start, end)
    ? anchoredZoneRect(start, end, minWidth * zoom, minHeight * zoom)
    : anchoredZoneRect(start, end, 0, 0);
}
