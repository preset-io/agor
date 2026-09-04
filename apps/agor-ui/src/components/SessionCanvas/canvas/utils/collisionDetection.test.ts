import type { BoardObject } from '@agor-live/client';
import type { Node } from 'reactflow';
import { describe, expect, it } from 'vitest';
import { findIntersectingObjects, findZoneAtPosition, findZoneForNode } from './collisionDetection';

function zone(label: string, zIndex?: number): Extract<BoardObject, { type: 'zone' }> {
  return {
    type: 'zone',
    x: 0,
    y: 0,
    width: 300,
    height: 300,
    label,
    zIndex,
  };
}

describe('zone collision layering', () => {
  it('targets the visually topmost overlapping zone', () => {
    const objects: Record<string, BoardObject> = {
      'zone-front': zone('Front', 120),
      'zone-back': zone('Back', 80),
    };

    expect(findZoneAtPosition({ x: 100, y: 100 }, objects)?.zoneId).toBe('zone-front');
  });

  it('uses later paint order as the deterministic equal-z tie breaker', () => {
    const objects: Record<string, BoardObject> = {
      'zone-first': zone('First', 100),
      'zone-later': zone('Later', 100),
    };

    expect(findZoneAtPosition({ x: 100, y: 100 }, objects)?.zoneId).toBe('zone-later');
  });

  it('uses the same topmost rule for a dragged node center', () => {
    const dragged: Node = { id: 'card', position: { x: 50, y: 50 }, data: {} };
    const objects: Record<string, BoardObject> = {
      'zone-back': zone('Back', 99),
      'zone-front': zone('Front', 101),
    };

    expect(findZoneForNode(dragged, [dragged], objects, 100, 100)?.zoneId).toBe('zone-front');
  });

  it('chooses the topmost intersecting node while preserving branch priority', () => {
    const nodes: Node[] = [
      {
        id: 'zone-back',
        type: 'zone',
        position: { x: 0, y: 0 },
        width: 300,
        height: 300,
        zIndex: 80,
        data: {},
      },
      {
        id: 'zone-front',
        type: 'zone',
        position: { x: 0, y: 0 },
        width: 300,
        height: 300,
        zIndex: 120,
        data: {},
      },
      {
        id: 'branch',
        type: 'branchNode',
        position: { x: 0, y: 0 },
        width: 300,
        height: 300,
        zIndex: 500,
        data: {},
      },
    ];

    const result = findIntersectingObjects({ x: 100, y: 100 }, nodes);
    expect(result.branchNode?.id).toBe('branch');
    expect(result.zoneNode?.id).toBe('zone-front');
  });
});
