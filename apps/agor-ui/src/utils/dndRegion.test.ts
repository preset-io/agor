import type { CollisionDetection } from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';
import { closestCenterWithin } from './dndRegion';

const region = {
  current: { getBoundingClientRect: () => ({ left: 0, right: 200, top: 0, bottom: 36 }) },
} as unknown as React.RefObject<HTMLElement>;

const args = (x: number, y: number) =>
  ({
    pointerCoordinates: { x, y },
    collisionRect: { left: x, top: y, width: 10, height: 10, right: x + 10, bottom: y + 10 },
    droppableRects: new Map([
      ['chat', { left: 0, top: 0, width: 60, height: 36, right: 60, bottom: 36 }],
      ['board', { left: 60, top: 0, width: 60, height: 36, right: 120, bottom: 36 }],
    ]),
    droppableContainers: [
      { id: 'chat', data: { current: undefined } },
      { id: 'board', data: { current: undefined } },
    ],
    active: { id: 'chat' },
  }) as unknown as Parameters<CollisionDetection>[0];

describe('closestCenterWithin', () => {
  it('finds the closest tab while the pointer is in the row', () => {
    expect(closestCenterWithin(region)(args(100, 10))[0]?.id).toBe('board');
  });

  it('has no target once the pointer leaves the row, so the drop cancels', () => {
    expect(closestCenterWithin(region)(args(100, 300))).toEqual([]);
    expect(closestCenterWithin(region)(args(400, 10))).toEqual([]);
  });
});
