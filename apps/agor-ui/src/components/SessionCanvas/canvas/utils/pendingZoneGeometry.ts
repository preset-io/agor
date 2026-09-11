import type { Node } from 'reactflow';

export interface ZoneGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

const withinOnePixel = (left: number, right: number): boolean => Math.abs(left - right) <= 1;

/**
 * Hold a locally-authored complete zone rectangle until realtime confirms all
 * four fields. Full-board board snapshots may arrive between writes; accepting
 * only the x/y portion (or only width/height) is what causes visible snapback.
 */
export function mergePendingZoneGeometry(
  incoming: Node,
  pending: ZoneGeometry
): { node: Node; confirmed: boolean } {
  const incomingWidth = Number(incoming.width ?? incoming.style?.width ?? 0);
  const incomingHeight = Number(incoming.height ?? incoming.style?.height ?? 0);
  const confirmed =
    withinOnePixel(incoming.position.x, pending.x) &&
    withinOnePixel(incoming.position.y, pending.y) &&
    withinOnePixel(incomingWidth, pending.width) &&
    withinOnePixel(incomingHeight, pending.height);
  if (confirmed) return { node: incoming, confirmed: true };

  return {
    confirmed: false,
    node: {
      ...incoming,
      position: { x: pending.x, y: pending.y },
      width: pending.width,
      height: pending.height,
      style: { ...incoming.style, width: pending.width, height: pending.height },
      data: { ...incoming.data, width: pending.width, height: pending.height },
    },
  };
}
