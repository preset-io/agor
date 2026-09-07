import { describe, expect, it } from 'vitest';
import type { ZoneBoardObject } from '../types/board.js';
import { findFreeZoneSlot, type ZoneOccupantRectangle } from './board-placement';

const zone = (width: number, height: number) =>
  ({ width, height }) as Pick<ZoneBoardObject, 'width' | 'height'>;

const branch = { entityWidth: 500, entityHeight: 200 };

function overlaps(a: ZoneOccupantRectangle, b: ZoneOccupantRectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('findFreeZoneSlot', () => {
  it('uses the padded top-left corner when the zone is empty', () => {
    expect(findFreeZoneSlot(zone(1200, 900), [], { ...branch, padding: 24 })).toEqual({
      x: 24,
      y: 24,
    });
  });

  it('steps past occupants instead of landing on them', () => {
    const occupants: ZoneOccupantRectangle[] = [
      { x: 0, y: 0, width: 400, height: 150 },
      { x: 420, y: 0, width: 400, height: 150 },
    ];

    const slot = findFreeZoneSlot(zone(1400, 1200), occupants, { ...branch, padding: 24, gap: 24 });

    const placed = { ...slot, width: 500, height: 200 };
    for (const occupant of occupants) expect(overlaps(placed, occupant)).toBe(false);
  });

  it('is deterministic for the same inputs', () => {
    const occupants: ZoneOccupantRectangle[] = [{ x: 0, y: 0, width: 400, height: 150 }];
    const slots = Array.from({ length: 5 }, () =>
      JSON.stringify(findFreeZoneSlot(zone(1400, 1200), occupants, branch))
    );

    expect(new Set(slots).size).toBe(1);
  });

  it('scans row-major, filling across before dropping down', () => {
    // One narrow occupant at the left: the next free slot is to its right on
    // the same row, not underneath it.
    const slot = findFreeZoneSlot(zone(2000, 1200), [{ x: 0, y: 0, width: 400, height: 150 }], {
      ...branch,
      padding: 24,
      gap: 24,
    });

    expect(slot.y).toBe(24);
    expect(slot.x).toBeGreaterThan(400);
  });

  it('parks below the lowest occupant when no cell inside the zone is free', () => {
    const occupants: ZoneOccupantRectangle[] = [{ x: 0, y: 0, width: 500, height: 180 }];

    const slot = findFreeZoneSlot(zone(520, 200), occupants, { ...branch, padding: 24, gap: 24 });

    const placed = { ...slot, width: 500, height: 200 };
    expect(overlaps(placed, occupants[0])).toBe(false);
    expect(slot.y).toBe(204);
  });

  it('reserves the zone title band when a title inset is given', () => {
    const slot = findFreeZoneSlot(zone(1200, 900), [], { ...branch, padding: 24, titleInset: 64 });

    expect(slot).toEqual({ x: 24, y: 88 });
  });
});
