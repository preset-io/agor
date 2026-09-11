import { describe, expect, it } from 'vitest';
import {
  expectedAutoLayoutState,
  layoutResultCoversBatch,
  zonesNeedingAutoArrange,
} from './autoArrangeGuard';

describe('zonesNeedingAutoArrange', () => {
  it('consumes only the self-induced pass and leaves genuine changes scheduled', () => {
    const skipOnce = new Set(['self-arranged']);
    const pending = zonesNeedingAutoArrange(
      [
        ['self-arranged', {}],
        ['content-changed', {}],
      ] as const,
      skipOnce
    );

    expect(pending.map(([zoneId]) => zoneId)).toEqual(['content-changed']);
    expect(skipOnce.size).toBe(0);
  });

  it('suppresses staged explicit echoes until the acknowledged target arrives', () => {
    expect(expectedAutoLayoutState('intermediate', undefined)).toEqual({
      suppress: false,
      settled: false,
      needsFallback: false,
    });
    expect(
      expectedAutoLayoutState('intermediate', {
        signature: 'final',
        acknowledged: false,
      })
    ).toEqual({ suppress: true, settled: false, needsFallback: false });
    expect(
      expectedAutoLayoutState('intermediate', {
        signature: 'final',
        acknowledged: true,
      })
    ).toEqual({ suppress: true, settled: false, needsFallback: false });
    expect(expectedAutoLayoutState('final', { signature: 'final', acknowledged: true })).toEqual({
      suppress: true,
      settled: true,
      needsFallback: false,
    });
  });
});

describe('layoutResultCoversBatch', () => {
  const batch = {
    objects: { note: { x: 1240, y: 760, width: 320 } },
    placements: {
      worktree: { position: { x: 20, y: 100 }, size: { width: 500, height: 240 } },
      card: { position: { x: 20, y: 680 }, size: { width: 380, height: 100 } },
    },
  };
  const result = {
    board: {
      board_id: 'board-1',
      objects: { note: { type: 'markdown', x: 1240, y: 760, width: 320, content: 'note' } },
    },
    placements: [
      {
        object_id: 'worktree',
        position: { x: 20, y: 100 },
        size: { width: 500, height: 240 },
      },
      {
        object_id: 'card',
        position: { x: 20, y: 680 },
        size: { width: 380, height: 100 },
      },
    ],
    changed: true,
    changed_object_ids: ['note'],
    changed_placement_ids: [],
  } as never;

  it('requires the exact full canvas and placement snapshot', () => {
    expect(layoutResultCoversBatch(result, batch)).toBe(true);
    expect(
      layoutResultCoversBatch({ ...result, placements: result.placements.slice(0, 1) }, batch)
    ).toBe(false);
    expect(
      layoutResultCoversBatch(
        {
          ...result,
          board: {
            ...result.board,
            objects: { ...result.board.objects, note: { ...result.board.objects.note, y: 840 } },
          },
        },
        batch
      )
    ).toBe(false);
  });
});
