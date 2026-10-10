import { describe, expect, it } from 'vitest';
import type { ZoneBoardObject } from '../types/board.js';
import { findFreeZoneSlot, planZoneSlot, type ZoneOccupantRectangle } from './board-placement';

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

  it.each([
    { width: 400, height: 500, occupants: [] },
    { width: 650, height: 180, occupants: [] },
    { width: 650, height: 500, occupants: [{ x: 0, y: 0, width: 650, height: 500 }] },
  ])('rejects a non-contained pin in a $width by $height frame', ({ width, height, occupants }) => {
    expect(() =>
      findFreeZoneSlot(zone(width, height), occupants, {
        ...branch,
        overflow: 'reject',
      })
    ).toThrow(/zone/i);
  });

  it('finds the free band directly below an occupant that is off the item-sized lattice', () => {
    // A branch arranged at (20,100) blocks every lattice row anchored at the
    // top inset (24, 268), yet a 500x220 slot clearly fits below it.
    const occupant = { x: 20, y: 100, width: 500, height: 200 };
    const slot = findFreeZoneSlot(zone(812, 600), [occupant], {
      entityWidth: 500,
      entityHeight: 220,
      overflow: 'reject',
    });

    expect(slot).toEqual({ x: 24, y: 324 });
    expect(overlaps({ ...slot, width: 500, height: 220 }, occupant)).toBe(false);
  });

  it('honors independent column and row gaps', () => {
    const slot = findFreeZoneSlot(zone(812, 600), [{ x: 20, y: 100, width: 500, height: 200 }], {
      entityWidth: 500,
      entityHeight: 220,
      padding: 20,
      titleInset: 80,
      gapX: 40,
      gapY: 8,
      overflow: 'reject',
    });

    expect(slot).toEqual({ x: 20, y: 308 });
  });

  it('reserves the zone title band when a title inset is given', () => {
    const slot = findFreeZoneSlot(zone(1200, 900), [], { ...branch, padding: 24, titleInset: 64 });

    expect(slot).toEqual({ x: 24, y: 88 });
  });
});

describe('planZoneSlot', () => {
  const frame = { padding: 20, titleInset: 80, gapX: 40, gapY: 8 };
  const pinned = [{ x: 20, y: 100, width: 500, height: 200 }];

  it('keeps the zone size when a contained slot exists', () => {
    expect(
      planZoneSlot(zone(812, 600), pinned, { ...frame, ...branch, entityHeight: 220 })
    ).toEqual({ position: { x: 20, y: 308 }, width: 812, height: 600, grew: false });
  });

  it('grows a height-resizable zone instead of rejecting the pin', () => {
    expect(
      planZoneSlot(zone(812, 340), pinned, {
        ...frame,
        ...branch,
        entityHeight: 220,
        resize: 'height',
      })
    ).toEqual({ position: { x: 20, y: 308 }, width: 812, height: 560, grew: true });
  });

  it('widens only when the policy allows width growth', () => {
    expect(() =>
      planZoneSlot(zone(400, 340), [], { ...frame, ...branch, resize: 'height' })
    ).toThrow(/too narrow/);
    expect(planZoneSlot(zone(400, 340), [], { ...frame, ...branch, resize: 'both' })).toEqual({
      position: { x: 20, y: 100 },
      width: 540,
      height: 340,
      grew: true,
    });
  });

  it('still rejects a full fixed-size zone', () => {
    expect(() =>
      planZoneSlot(zone(812, 340), pinned, { ...frame, ...branch, entityHeight: 220 })
    ).toThrow(/No free slot/);
  });
});
