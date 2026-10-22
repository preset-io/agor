import { describe, expect, it } from 'vitest';
import {
  anchoredZoneRect,
  drawnZoneFlowRect,
  isZoneDrag,
  type ZoneDrawingFlow,
  zoneDrawingPreviewRect,
} from './zoneDrawing';

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

// A canvas like React Flow's: pane offset, pan, zoom, and snapping to a 20px grid on the way in.
function fakeFlow(zoom: number, pan = { x: 0, y: 0 }, pane = { x: 0, y: 0 }): ZoneDrawingFlow {
  const snap = (value: number) => 20 * Math.round(value / 20);
  return {
    screenToFlowPosition: (p) => ({
      x: snap((p.x - pane.x - pan.x) / zoom),
      y: snap((p.y - pane.y - pan.y) / zoom),
    }),
    flowToScreenPosition: (p) => ({
      x: p.x * zoom + pan.x + pane.x,
      y: p.y * zoom + pan.y + pane.y,
    }),
  };
}

describe('drawnZoneFlowRect and zoneDrawingPreviewRect', () => {
  const start = { x: 1000, y: 1000 };

  it('previews just the dragged box until the drag counts', () => {
    expect(isZoneDrag(start, { x: 1040, y: 1100 })).toBe(false);
    expect(zoneDrawingPreviewRect(fakeFlow(1), start, { x: 960, y: 960 }, 540, 300)).toEqual({
      x: 960,
      y: 960,
      width: 40,
      height: 40,
    });
  });

  it('previews exactly the snapped zone that releasing creates', () => {
    const flow = fakeFlow(1);
    const end = { x: 1611, y: 1411 };
    expect(drawnZoneFlowRect(flow, start, end, 540, 300)).toEqual({
      x: 1000,
      y: 1000,
      width: 620,
      height: 420,
    });
    expect(zoneDrawingPreviewRect(flow, start, end, 540, 300)).toEqual({
      x: 1000,
      y: 1000,
      width: 620,
      height: 420,
    });
  });

  it('pins the minimum zone to the start at any zoom, pan and pane offset', () => {
    const flow = fakeFlow(0.5, { x: 40, y: -60 }, { x: 300, y: 64 });
    const end = { x: 900, y: 900 };
    const zone = drawnZoneFlowRect(flow, start, end, 540, 300);
    expect(zone).toMatchObject({ width: 540, height: 300 });
    const preview = zoneDrawingPreviewRect(flow, start, end, 540, 300);
    expect(preview).toEqual({ x: 730, y: 854, width: 270, height: 150 });
    // The preview's bottom-right corner is the start, snapped to the grid.
    const snappedStart = flow.flowToScreenPosition(flow.screenToFlowPosition(start));
    expect({ x: preview.x + preview.width, y: preview.y + preview.height }).toEqual(snappedStart);
  });

  it('grows the way the pointer moved even when both ends snap to the same point', () => {
    const flow = fakeFlow(8);
    const zone = drawnZoneFlowRect(flow, start, { x: 940, y: 940 }, 540, 300);
    expect(zone).toEqual({ x: 120 - 540, y: 120 - 300, width: 540, height: 300 });
  });
});
