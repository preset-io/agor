import { describe, expect, it, vi } from 'vitest';
import { ZONE_PLACEMENT_ANCHORS } from '../types/board.js';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  computeZoneRelativePosition,
  resolveZoneRelativePosition,
} from './board-placement.js';

const zone = { width: 1000, height: 800 };

describe('resolveZoneRelativePosition', () => {
  it.each(
    ZONE_PLACEMENT_ANCHORS.map((anchor, index) => ({
      anchor,
      x: [80, 250, 420][index % 3],
      y: [80, 300, 520][Math.floor(index / 3)],
    }))
  )('resolves $anchor using branch dimensions and padding', ({ anchor, x, y }) => {
    expect(resolveZoneRelativePosition(zone, anchor)).toEqual({ x, y });
  });

  it('uses card dimensions and padding', () => {
    expect(
      resolveZoneRelativePosition(zone, 'bottom-right', {
        entityWidth: CARD_WIDTH,
        entityHeight: CARD_HEIGHT,
        desiredPadding: 60,
      })
    ).toEqual({ x: 540, y: 590 });
  });

  it('honors exact fractional coordinates inside padding without mutating inputs', () => {
    const spec = Object.freeze({ x: 10, y: 10.5 });
    expect(resolveZoneRelativePosition(Object.freeze(zone), spec)).toEqual(spec);
  });

  it('clamps coordinates to bounds accounting for entity size, not padding', () => {
    expect(resolveZoneRelativePosition(zone, { x: -10, y: 9999 })).toEqual({ x: 0, y: 600 });
    expect(resolveZoneRelativePosition(zone, { x: 9999, y: -10 })).toEqual({ x: 500, y: 0 });
  });

  it.each(ZONE_PLACEMENT_ANCHORS)('adapts padding for a tight zone (%s)', (anchor) => {
    expect(resolveZoneRelativePosition({ width: 520, height: 220 }, anchor)).toEqual({
      x: 10,
      y: 10,
    });
    expect(resolveZoneRelativePosition({ width: 500, height: 200 }, anchor)).toEqual({
      x: 0,
      y: 0,
    });
    expect(resolveZoneRelativePosition({ width: 1, height: 0 }, anchor)).toEqual({ x: 0, y: 0 });
  });

  it('handles one overflowing axis without suppressing the other', () => {
    expect(resolveZoneRelativePosition({ width: 100, height: 800 }, 'bottom-right')).toEqual({
      x: 0,
      y: 520,
    });
    expect(resolveZoneRelativePosition({ width: 100, height: 800 }, { x: 20, y: 10 })).toEqual({
      x: 0,
      y: 10,
    });
  });

  it('preserves random defaults and supports deterministic sampling', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    try {
      expect(computeZoneRelativePosition(zone)).toEqual({ x: 165, y: 190 });
      expect(resolveZoneRelativePosition(zone)).toEqual({ x: 165, y: 190 });
      expect(resolveZoneRelativePosition(zone, undefined, { random: () => 1 })).toEqual({
        x: 420,
        y: 520,
      });
      random.mockClear();
      resolveZoneRelativePosition(zone, 'center');
      resolveZoneRelativePosition(zone, { x: 10, y: 10 });
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });
});
