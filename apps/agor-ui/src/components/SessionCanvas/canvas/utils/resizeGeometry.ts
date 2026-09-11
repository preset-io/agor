export interface ResizeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * React Flow has already done the edge arithmetic when it emits resize
 * changes: left/top handles include a paired position change, while
 * right/bottom handles emit dimensions only. Preserve that new origin instead
 * of persisting just the dimensions and snapping the node back to its old x/y.
 */
export function persistedResizeRect(
  current: ResizeRect,
  position: { x: number; y: number } | undefined,
  dimensions: { width: number; height: number }
): ResizeRect {
  return {
    x: position?.x ?? current.x,
    y: position?.y ?? current.y,
    width: dimensions.width,
    height: dimensions.height,
  };
}
