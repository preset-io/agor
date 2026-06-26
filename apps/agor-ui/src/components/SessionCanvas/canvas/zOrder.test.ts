import { describe, expect, it } from 'vitest';
import {
  BOARD_OBJECT_Z_MAX,
  BOARD_OBJECT_Z_MIN,
  computeLayerChanges,
  sanitizeZIndex,
  selectedZIndex,
  type ZPeer,
} from './zOrder';

describe('computeLayerChanges', () => {
  it('returns no changes when the target is not in the peer set', () => {
    const peers: ZPeer[] = [{ id: 'a', zIndex: 100 }];
    expect(computeLayerChanges('front', 'missing', peers)).toEqual([]);
  });

  it('returns no changes when the target is the only peer', () => {
    const peers: ZPeer[] = [{ id: 'a', zIndex: 100 }];
    for (const op of ['front', 'forward', 'backward', 'back'] as const) {
      expect(computeLayerChanges(op, 'a', peers)).toEqual([]);
    }
  });

  describe('front', () => {
    it('moves the target above the highest peer', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 100 },
        { id: 'b', zIndex: 105 },
        { id: 'c', zIndex: 102 },
      ];
      expect(computeLayerChanges('front', 'a', peers)).toEqual([{ id: 'a', zIndex: 106 }]);
    });

    it('breaks ties when all peers share the default zIndex', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 100 },
        { id: 'b', zIndex: 100 },
      ];
      expect(computeLayerChanges('front', 'a', peers)).toEqual([{ id: 'a', zIndex: 101 }]);
    });

    it('is a no-op when the target is already strictly in front', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 110 },
        { id: 'b', zIndex: 100 },
      ];
      expect(computeLayerChanges('front', 'a', peers)).toEqual([]);
    });
  });

  describe('back', () => {
    it('moves the target below the lowest peer', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 105 },
        { id: 'b', zIndex: 100 },
        { id: 'c', zIndex: 102 },
      ];
      expect(computeLayerChanges('back', 'a', peers)).toEqual([{ id: 'a', zIndex: 99 }]);
    });

    it('is a no-op when the target is already strictly at the back', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 90 },
        { id: 'b', zIndex: 100 },
      ];
      expect(computeLayerChanges('back', 'a', peers)).toEqual([]);
    });
  });

  describe('forward', () => {
    it('swaps with the nearest peer above', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 100 },
        { id: 'b', zIndex: 105 },
        { id: 'c', zIndex: 110 },
      ];
      // a should swap with b (nearest above), not c.
      expect(computeLayerChanges('forward', 'a', peers)).toEqual([
        { id: 'a', zIndex: 105 },
        { id: 'b', zIndex: 100 },
      ]);
    });

    it('breaks a tie by stepping up one when no peer is strictly above', () => {
      // Headline case: two zones both at the default 100. The button must do
      // something rather than silently no-op.
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 100 },
        { id: 'b', zIndex: 100 },
      ];
      expect(computeLayerChanges('forward', 'a', peers)).toEqual([{ id: 'a', zIndex: 101 }]);
    });

    it('is a no-op when the target is strictly above all peers', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 110 },
        { id: 'b', zIndex: 100 },
      ];
      expect(computeLayerChanges('forward', 'a', peers)).toEqual([]);
    });
  });

  describe('backward', () => {
    it('swaps with the nearest peer below', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 110 },
        { id: 'b', zIndex: 105 },
        { id: 'c', zIndex: 100 },
      ];
      // a should swap with b (nearest below), not c.
      expect(computeLayerChanges('backward', 'a', peers)).toEqual([
        { id: 'a', zIndex: 105 },
        { id: 'b', zIndex: 110 },
      ]);
    });

    it('breaks a tie by stepping down one when no peer is strictly below', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 100 },
        { id: 'b', zIndex: 100 },
      ];
      expect(computeLayerChanges('backward', 'a', peers)).toEqual([{ id: 'a', zIndex: 99 }]);
    });

    it('is a no-op when the target is strictly below all peers', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 90 },
        { id: 'b', zIndex: 100 },
      ];
      expect(computeLayerChanges('backward', 'a', peers)).toEqual([]);
    });
  });

  it('forward then backward returns to the original ordering', () => {
    const peers: ZPeer[] = [
      { id: 'a', zIndex: 100 },
      { id: 'b', zIndex: 105 },
    ];
    const forward = computeLayerChanges('forward', 'a', peers);
    expect(forward).toEqual([
      { id: 'a', zIndex: 105 },
      { id: 'b', zIndex: 100 },
    ]);
    // Apply the swap, then send 'a' backward again.
    const swapped: ZPeer[] = [
      { id: 'a', zIndex: 105 },
      { id: 'b', zIndex: 100 },
    ];
    expect(computeLayerChanges('backward', 'a', swapped)).toEqual([
      { id: 'a', zIndex: 100 },
      { id: 'b', zIndex: 105 },
    ]);
  });

  describe('clamping to the board-object band', () => {
    it('never sends "front" up to or past the card layer (clamps at the ceiling)', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 200 },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MAX },
      ];
      // maxOther + 1 would be 500 (the card layer); clamp to the ceiling.
      expect(computeLayerChanges('front', 'a', peers)).toEqual([
        { id: 'a', zIndex: BOARD_OBJECT_Z_MAX },
      ]);
    });

    it('is a no-op for "front" when the target is already at the ceiling alongside a peer', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: BOARD_OBJECT_Z_MAX },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MAX },
      ];
      expect(computeLayerChanges('front', 'a', peers)).toEqual([]);
    });

    it('never sends "back" below the floor (clamps at 1)', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 50 },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MIN },
      ];
      // minOther - 1 would be 0; clamp to the floor.
      expect(computeLayerChanges('back', 'a', peers)).toEqual([
        { id: 'a', zIndex: BOARD_OBJECT_Z_MIN },
      ]);
    });

    it('is a no-op for "back" when the target is already at the floor alongside a peer', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: BOARD_OBJECT_Z_MIN },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MIN },
      ];
      expect(computeLayerChanges('back', 'a', peers)).toEqual([]);
    });
  });
});

describe('selectedZIndex', () => {
  it('bumps one above the base when selected', () => {
    expect(selectedZIndex(100, true)).toBe(101);
  });
  it('returns the base when not selected', () => {
    expect(selectedZIndex(100, false)).toBe(100);
  });
});

describe('sanitizeZIndex', () => {
  it('passes through finite numbers (including the band extremes)', () => {
    expect(sanitizeZIndex(123, 100)).toBe(123);
    expect(sanitizeZIndex(0, 100)).toBe(0);
    expect(sanitizeZIndex(-5, 100)).toBe(-5);
  });
  it('falls back for non-finite or non-numeric values', () => {
    expect(sanitizeZIndex(Number.NaN, 100)).toBe(100);
    expect(sanitizeZIndex(Number.POSITIVE_INFINITY, 100)).toBe(100);
    expect(sanitizeZIndex(undefined, 300)).toBe(300);
    expect(sanitizeZIndex('500' as unknown, 400)).toBe(400);
    expect(sanitizeZIndex(null, 100)).toBe(100);
  });
});
