import type { BoardObject } from '@agor-live/client';
import type { Node } from 'reactflow';
import { describe, expect, it, vi } from 'vitest';
import {
  getValidZoneParentId,
  isRenderableZoneObject,
  sanitizeOrphanedNodeParents,
} from './nodeParentUtils';

describe('nodeParentUtils', () => {
  it('clears orphaned React Flow parentIds', () => {
    const onOrphan = vi.fn();
    const nodes = [
      {
        id: 'branch-1',
        type: 'branchNode',
        position: { x: 10, y: 20 },
        parentId: 'zone-missing',
        data: {},
      },
      { id: 'zone-existing', type: 'zone', position: { x: 0, y: 0 }, data: {} },
    ] satisfies Node[];

    const result = sanitizeOrphanedNodeParents(nodes, { onOrphan });

    expect(result[0].parentId).toBeUndefined();
    expect(result[1].parentId).toBeUndefined();
    expect(onOrphan).toHaveBeenCalledWith(nodes[0], 'zone-missing');
  });

  it('preserves valid React Flow parentIds', () => {
    const nodes = [
      { id: 'zone-existing', type: 'zone', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'branch-1',
        type: 'branchNode',
        position: { x: 10, y: 20 },
        parentId: 'zone-existing',
        data: {},
      },
    ] satisfies Node[];

    const result = sanitizeOrphanedNodeParents(nodes);

    expect(result).toBe(nodes);
    expect(result[1].parentId).toBe('zone-existing');
  });

  it('validates zone parent ids against renderable board zone objects', () => {
    const objects: Record<string, BoardObject> = {
      'zone-good': { type: 'zone', x: 0, y: 0, width: 400, height: 300, label: 'Good' },
      'zone-bad': { type: 'zone', x: 0, y: Number.NaN, width: 400, height: 300, label: 'Bad' },
      'markdown-1': { type: 'markdown', x: 0, y: 0, width: 400, content: 'not a zone' },
    };
    const onInvalid = vi.fn();

    expect(getValidZoneParentId('zone-good', objects, { onInvalid })).toBe('zone-good');
    expect(
      getValidZoneParentId('zone-missing', objects, { entityId: 'branch-1', onInvalid })
    ).toBeUndefined();
    expect(
      getValidZoneParentId('zone-bad', objects, { entityId: 'branch-2', onInvalid })
    ).toBeUndefined();
    expect(
      getValidZoneParentId('markdown-1', objects, { entityId: 'branch-3', onInvalid })
    ).toBeUndefined();
    expect(isRenderableZoneObject(objects['zone-good'])).toBe(true);
    expect(isRenderableZoneObject(objects['zone-bad'])).toBe(false);
    expect(onInvalid).toHaveBeenCalledTimes(3);
  });
});
