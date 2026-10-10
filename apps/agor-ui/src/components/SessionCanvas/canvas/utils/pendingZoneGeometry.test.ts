import type { Node } from 'reactflow';
import { describe, expect, it } from 'vitest';
import { mergePendingZoneGeometry } from './pendingZoneGeometry';

const node = (x: number, y: number, width: number, height: number): Node => ({
  id: 'zone-a',
  type: 'zone',
  position: { x, y },
  width,
  height,
  style: { width, height },
  data: {},
});

describe('mergePendingZoneGeometry', () => {
  it('keeps the complete optimistic rectangle across stale and partial realtime snapshots', () => {
    const pending = { x: 400, y: 300, width: 800, height: 500 };
    const stale = mergePendingZoneGeometry(node(40, 60, 600, 400), pending);
    const partial = mergePendingZoneGeometry(node(400, 300, 600, 400), pending);
    expect(stale.confirmed).toBe(false);
    expect(stale.node).toMatchObject({ position: { x: 400, y: 300 }, width: 800, height: 500 });
    expect(partial.confirmed).toBe(false);
    expect(partial.node).toMatchObject({ width: 800, height: 500 });
  });

  it('releases the override only when position and size are acknowledged together', () => {
    const pending = { x: 400, y: 300, width: 800, height: 500 };
    const result = mergePendingZoneGeometry(node(400.5, 299.5, 800.5, 499.5), pending);
    expect(result.confirmed).toBe(true);
    expect(result.node.position).toEqual({ x: 400.5, y: 299.5 });
  });
});
