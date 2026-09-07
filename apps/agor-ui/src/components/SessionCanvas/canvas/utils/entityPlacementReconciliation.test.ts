import type { BoardEntityObject } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  sameBoardEntityPlacement,
  snapshotBoardEntityPlacement,
} from './entityPlacementReconciliation';

function placement(overrides: Partial<BoardEntityObject> = {}): BoardEntityObject {
  return {
    object_id: 'object-1',
    board_id: 'board-1',
    branch_id: 'branch-1',
    entity_type: 'branch',
    position: { x: 20, y: 100 },
    zone_id: 'zone-reviewing',
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as BoardEntityObject;
}

describe('board entity placement reconciliation', () => {
  it('ignores non-placement updates while detecting every placement authority field', () => {
    const baseline = snapshotBoardEntityPlacement(placement());

    expect(
      sameBoardEntityPlacement(
        baseline,
        snapshotBoardEntityPlacement(placement({ created_at: '2026-09-01T00:05:00.000Z' }))
      )
    ).toBe(true);

    expect(
      sameBoardEntityPlacement(
        baseline,
        snapshotBoardEntityPlacement(placement({ object_id: 'replacement-object' }))
      )
    ).toBe(false);
    expect(
      sameBoardEntityPlacement(
        baseline,
        snapshotBoardEntityPlacement(placement({ board_id: 'replacement-board' }))
      )
    ).toBe(false);
    expect(
      sameBoardEntityPlacement(
        baseline,
        snapshotBoardEntityPlacement(placement({ zone_id: 'zone-implementing' }))
      )
    ).toBe(false);
    expect(
      sameBoardEntityPlacement(
        baseline,
        snapshotBoardEntityPlacement(placement({ position: { x: 40, y: 100 } }))
      )
    ).toBe(false);
    expect(
      sameBoardEntityPlacement(
        baseline,
        snapshotBoardEntityPlacement(placement({ position: { x: 20, y: 120 } }))
      )
    ).toBe(false);
  });

  it('treats creation and removal as authority changes and normalizes an unpinned zone', () => {
    const unpinned = snapshotBoardEntityPlacement(placement({ zone_id: undefined }));
    const explicitlyUnpinned = snapshotBoardEntityPlacement(
      placement({ zone_id: null as unknown as undefined })
    );

    expect(sameBoardEntityPlacement(unpinned, explicitlyUnpinned)).toBe(true);
    expect(sameBoardEntityPlacement(null, unpinned)).toBe(false);
    expect(sameBoardEntityPlacement(unpinned, null)).toBe(false);
    expect(sameBoardEntityPlacement(null, null)).toBe(true);
  });
});
