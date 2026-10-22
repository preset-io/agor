import { describe, expect, it } from 'vitest';
import { anchoredZoneRect, isZoneDrag, zoneDrawingPreviewRect } from './zoneDrawing';

describe('anchoredZoneRect', () => {
  const start = { x: 1000, y: 1000 };

  it('keeps a drag larger than the minimum as drawn, in every direction', () => {
    expect(anchoredZoneRect(start, { x: 1600, y: 1400 }, 540, 300)).toEqual({
      x: 1000,
      y: 1000,
      width: 600,
      height: 400,
    });
    expect(anchoredZoneRect(start, { x: 400, y: 600 }, 540, 300)).toEqual({
      x: 400,
      y: 600,
      width: 600,
      height: 400,
    });
  });

  it('grows a small drag to the minimum from the corner where it started', () => {
    // Down and right: grows down and right.
    expect(anchoredZoneRect(start, { x: 1100, y: 1100 }, 540, 300)).toEqual({
      x: 1000,
      y: 1000,
      width: 540,
      height: 300,
    });
    // Up and left: grows up and left, ending at the start corner.
    expect(anchoredZoneRect(start, { x: 900, y: 900 }, 540, 300)).toEqual({
      x: 460,
      y: 700,
      width: 540,
      height: 300,
    });
    // Up and right, then down and left.
    expect(anchoredZoneRect(start, { x: 1100, y: 900 }, 540, 300)).toMatchObject({
      x: 1000,
      y: 700,
    });
    expect(anchoredZoneRect(start, { x: 900, y: 1100 }, 540, 300)).toMatchObject({
      x: 460,
      y: 1000,
    });
  });

  it('applies the minimum per axis', () => {
    expect(anchoredZoneRect(start, { x: 400, y: 1100 }, 540, 300)).toEqual({
      x: 400,
      y: 1000,
      width: 600,
      height: 300,
    });
  });
});

describe('zoneDrawingPreviewRect', () => {
  const start = { x: 1000, y: 1000 };

  it('previews just the dragged box until the drag counts', () => {
    expect(isZoneDrag(start, { x: 1040, y: 1100 })).toBe(false);
    expect(zoneDrawingPreviewRect(start, { x: 960, y: 960 }, 1, 540, 300)).toEqual({
      x: 960,
      y: 960,
      width: 40,
      height: 40,
    });
  });

  it('previews the minimum zone scaled to the zoom, pinned to the start', () => {
    expect(isZoneDrag(start, { x: 900, y: 900 })).toBe(true);
    // At half zoom the 540x300 minimum covers 270x150 screen pixels.
    expect(zoneDrawingPreviewRect(start, { x: 900, y: 900 }, 0.5, 540, 300)).toEqual({
      x: 730,
      y: 850,
      width: 270,
      height: 150,
    });
    expect(zoneDrawingPreviewRect(start, { x: 1100, y: 1100 }, 2, 540, 300)).toEqual({
      x: 1000,
      y: 1000,
      width: 1080,
      height: 600,
    });
  });
});
