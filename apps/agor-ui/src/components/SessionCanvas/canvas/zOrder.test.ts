import { describe, expect, it } from 'vitest';
import {
  BOARD_OBJECT_Z_MAX,
  BOARD_OBJECT_Z_MIN,
  computeLayerChanges,
  DEFAULT_BOARD_OBJECT_Z_INDEX,
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

  describe('boundary handling at the band edges [1, 499]', () => {
    it('"front" pins the target at the ceiling and pushes the occupant down (never reaches 500)', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 200 },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MAX },
      ];
      // maxOther + 1 would be 500 (the card layer); instead pin target at the
      // ceiling and drop the occupant so the target leads, staying in-band.
      expect(computeLayerChanges('front', 'a', peers)).toEqual([
        { id: 'a', zIndex: BOARD_OBJECT_Z_MAX },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MAX - 1 },
      ]);
    });

    it('"front" when target already ties at the ceiling drops the peer so the target leads (no wedge)', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: BOARD_OBJECT_Z_MAX },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MAX },
      ];
      // Previously a no-op (wedge); now the tied peer is lowered so "a" leads.
      expect(computeLayerChanges('front', 'a', peers)).toEqual([
        { id: 'b', zIndex: BOARD_OBJECT_Z_MAX - 1 },
      ]);
    });

    it('"back" pins the target at the floor and pushes the occupant up (never reaches 0)', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: 50 },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MIN },
      ];
      expect(computeLayerChanges('back', 'a', peers)).toEqual([
        { id: 'a', zIndex: BOARD_OBJECT_Z_MIN },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MIN + 1 },
      ]);
    });

    it('"back" when target already ties at the floor raises the peer so the target trails (no wedge)', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: BOARD_OBJECT_Z_MIN },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MIN },
      ];
      expect(computeLayerChanges('back', 'a', peers)).toEqual([
        { id: 'b', zIndex: BOARD_OBJECT_Z_MIN + 1 },
      ]);
    });

    it('"forward" at the ceiling tie lowers the tied peer instead of wedging', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: BOARD_OBJECT_Z_MAX },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MAX },
      ];
      // Tie-break can't step the target to MAX+1, so the tied peer drops one.
      expect(computeLayerChanges('forward', 'a', peers)).toEqual([
        { id: 'b', zIndex: BOARD_OBJECT_Z_MAX - 1 },
      ]);
    });

    it('"backward" at the floor tie raises the tied peer instead of wedging', () => {
      const peers: ZPeer[] = [
        { id: 'a', zIndex: BOARD_OBJECT_Z_MIN },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MIN },
      ];
      expect(computeLayerChanges('backward', 'a', peers)).toEqual([
        { id: 'b', zIndex: BOARD_OBJECT_Z_MIN + 1 },
      ]);
    });

    it('no boundary path ever emits a zIndex outside [1, 499]', () => {
      const atCeiling: ZPeer[] = [
        { id: 'a', zIndex: BOARD_OBJECT_Z_MAX },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MAX },
      ];
      const atFloor: ZPeer[] = [
        { id: 'a', zIndex: BOARD_OBJECT_Z_MIN },
        { id: 'b', zIndex: BOARD_OBJECT_Z_MIN },
      ];
      for (const [op, peers] of [
        ['front', atCeiling],
        ['forward', atCeiling],
        ['back', atFloor],
        ['backward', atFloor],
      ] as const) {
        for (const change of computeLayerChanges(op, 'a', peers)) {
          expect(change.zIndex).toBeGreaterThanOrEqual(BOARD_OBJECT_Z_MIN);
          expect(change.zIndex).toBeLessThanOrEqual(BOARD_OBJECT_Z_MAX);
        }
      }
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
  it('bumps a NON-default base by exactly one (guards against a hardcoded 101/100)', () => {
    // A buggy `selected ? 101 : 100` would still pass the base-100 cases above;
    // a non-default base catches it.
    expect(selectedZIndex(103, true)).toBe(104);
    expect(selectedZIndex(103, false)).toBe(103);
  });
  it('clamps the selection bump so a base-499 zone never reaches the card layer (500)', () => {
    // The +1 bump must stay below BOARD_OBJECT_Z_MAX; otherwise a selected
    // front-most zone renders at 500 and can mask cards.
    expect(selectedZIndex(BOARD_OBJECT_Z_MAX, true)).toBe(BOARD_OBJECT_Z_MAX);
    expect(selectedZIndex(BOARD_OBJECT_Z_MAX, false)).toBe(BOARD_OBJECT_Z_MAX);
    expect(selectedZIndex(498, true)).toBe(BOARD_OBJECT_Z_MAX);
  });
});

describe('zone selection round-trip (SessionCanvas zone-merge path)', () => {
  // Mirrors the exact expression used at both SessionCanvas call sites
  // (SessionCanvas.tsx ~L1271 board-sync and ~L1424 onNodesChange):
  //   const base = (newZone.zIndex as number) ?? DEFAULT_BOARD_OBJECT_Z_INDEX.zone;
  //   node.zIndex = selectedZIndex(base, selected);
  // The base MUST come from the object's own persisted zIndex, not the per-type
  // default — otherwise a custom-layered zone snaps back to 100 on deselect.
  // Regression note: keep this in lockstep with those two call sites; the merge
  // path itself isn't unit-rendered (SessionCanvas needs heavy setup).
  const resolveZoneZIndex = (persisted: number | undefined, selected: boolean) =>
    selectedZIndex(persisted ?? DEFAULT_BOARD_OBJECT_Z_INDEX.zone, selected);

  it('a zone persisted at 103 renders at 104 selected and restores to 103 on deselect', () => {
    expect(resolveZoneZIndex(103, true)).toBe(104);
    expect(resolveZoneZIndex(103, false)).toBe(103);
    // Crucially NOT the per-type default (100) on deselect.
    expect(resolveZoneZIndex(103, false)).not.toBe(DEFAULT_BOARD_OBJECT_Z_INDEX.zone);
  });

  it('falls back to the per-type default only when the base is unset', () => {
    expect(resolveZoneZIndex(undefined, false)).toBe(DEFAULT_BOARD_OBJECT_Z_INDEX.zone);
    expect(resolveZoneZIndex(undefined, true)).toBe(DEFAULT_BOARD_OBJECT_Z_INDEX.zone + 1);
  });
});

describe('sanitizeZIndex', () => {
  it('passes through in-band finite numbers', () => {
    expect(sanitizeZIndex(123, 100)).toBe(123);
    expect(sanitizeZIndex(BOARD_OBJECT_Z_MIN, 100)).toBe(BOARD_OBJECT_Z_MIN);
    expect(sanitizeZIndex(BOARD_OBJECT_Z_MAX, 100)).toBe(BOARD_OBJECT_Z_MAX);
  });
  it('clamps a finite but out-of-band value into [MIN, MAX]', () => {
    // An out-of-band value persisted via MCP/import must never be read back as
    // the card (500) / comment (1000) layer.
    expect(sanitizeZIndex(600, 100)).toBe(BOARD_OBJECT_Z_MAX);
    expect(sanitizeZIndex(0, 100)).toBe(BOARD_OBJECT_Z_MIN);
    expect(sanitizeZIndex(-5, 100)).toBe(BOARD_OBJECT_Z_MIN);
  });
  it('falls back for non-finite or non-numeric values', () => {
    expect(sanitizeZIndex(Number.NaN, 100)).toBe(100);
    expect(sanitizeZIndex(Number.POSITIVE_INFINITY, 100)).toBe(100);
    expect(sanitizeZIndex(undefined, 300)).toBe(300);
    expect(sanitizeZIndex('500' as unknown, 400)).toBe(400);
    expect(sanitizeZIndex(null, 100)).toBe(100);
  });
});
