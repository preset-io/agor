import { describe, expect, it } from 'vitest';
import { computeLayerChanges, type ZPeer } from './zOrder';

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

    it('is a no-op when nothing is strictly above (ties do not count)', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 100 },
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

    it('is a no-op when nothing is strictly below', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 100 },
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
});
