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
        snapshotBoardEntityPlacement(
          placement({ board_id: 'replacement-board' as BoardEntityObject['board_id'] })
        )
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

  it('invalidates absolute drag geometry after a parent frame moves or resizes', () => {
    const zone = {
      type: 'zone' as const,
      label: 'Example',
      x: 1000,
      y: 500,
      width: 800,
      height: 600,
    };
    const snapshot = (frame: typeof zone) =>
      snapshotBoardEntityPlacement(placement(), { objects: { 'zone-reviewing': frame } });
    for (const change of [{ x: 1100 }, { y: 600 }, { width: 900 }, { height: 700 }]) {
      expect(sameBoardEntityPlacement(snapshot(zone), snapshot({ ...zone, ...change }))).toBe(
        false
      );
    }
    expect(sameBoardEntityPlacement(snapshot(zone), snapshot({ ...zone }))).toBe(true);
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
