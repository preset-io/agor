import { describe, expect, it } from 'vitest';
import {
  type JustifiedZonePlacement,
  layoutJustifiedZones,
  zoneShapesForItems,
} from './justified-zones';
import { BOARD_GRID_SIZE } from './rectangle-packing';

const shape = (columns: number, width: number, height: number) => ({ columns, width, height });

/** Every assertion here is about geometry. Flags cannot tell you a row overlaps. */
function overlaps(a: JustifiedZonePlacement, b: JustifiedZonePlacement): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function expectNoOverlaps(placements: JustifiedZonePlacement[]) {
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      expect(
        overlaps(placements[i], placements[j]),
        `${placements[i].id} overlaps ${placements[j].id}`
      ).toBe(false);
    }
  }
}

it('quantizes frames and the cluster origin while preserving the exact requested gap', () => {
  const result = layoutJustifiedZones(
    [
      { id: 'zone-a', shapes: [shape(1, 413, 307)] },
      { id: 'zone-b', shapes: [shape(1, 517, 283)] },
    ],
    { targetWidth: 1003, startX: 73, startY: 87, gap: 33, gridSize: BOARD_GRID_SIZE }
  );

  for (const placement of result.placements) {
    for (const value of [placement.y, placement.width, placement.height]) {
      expect(value % BOARD_GRID_SIZE).toBe(0);
    }
  }
  expect(result.placements[0].x % BOARD_GRID_SIZE).toBe(0);
  expect(result.placements[1].x - (result.placements[0].x + result.placements[0].width)).toBe(33);
  expect(result.gap).toBe(33);
  expectNoOverlaps(result.placements);
});

describe('layoutJustifiedZones', () => {
  it('fills a row flush to the target width', () => {
    const result = layoutJustifiedZones(
      [
        { id: 'a', shapes: [shape(1, 400, 300)] },
        { id: 'b', shapes: [shape(1, 400, 300)] },
      ],
      { targetWidth: 1000, gap: 40, startX: 0, startY: 0, justifyLastRow: true }
    );

    const [a, b] = result.placements;
    expect(a.x).toBe(0);
    // Flush: last zone's right edge lands exactly on the target width.
    expect(b.x + b.width).toBe(1000);
    expect(b.x).toBe(a.width + 40);
    expectNoOverlaps(result.placements);
  });

  it('gives every zone in a row the same height and reports the blank space', () => {
    const result = layoutJustifiedZones(
      [
        { id: 'tall', shapes: [shape(1, 400, 600)] },
        { id: 'short', shapes: [shape(1, 400, 200)] },
      ],
      { targetWidth: 1000, gap: 40, startX: 0, startY: 0 }
    );

    const [tall, short] = result.placements;
    expect(tall.height).toBe(600);
    expect(short.height).toBe(600);
    expect(tall.slackY).toBe(0);
    // The short zone is padded, and says so rather than pretending it grew.
    expect(short.slackY).toBe(400);
  });

  it('mixes a portrait and a landscape shape when that wastes less canvas', () => {
    // Same zone offered as 1x tall or 3x wide. Beside a fixed short zone, the
    // landscape form is the one that keeps the row from being 900 tall.
    const result = layoutJustifiedZones(
      [
        { id: 'flexible', shapes: [shape(1, 300, 900), shape(3, 900, 300)] },
        { id: 'fixed', shapes: [shape(1, 300, 300)] },
      ],
      { targetWidth: 1240, gap: 40, startX: 0, startY: 0 }
    );

    const flexible = result.placements.find((p) => p.id === 'flexible');
    expect(flexible?.columns).toBe(3);
    expect(result.rowHeights[0]).toBe(300);
  });

  it('wraps to a new row and stacks rows without overlap', () => {
    const result = layoutJustifiedZones(
      [
        { id: 'a', shapes: [shape(1, 600, 200)] },
        { id: 'b', shapes: [shape(1, 600, 200)] },
        { id: 'c', shapes: [shape(1, 600, 400)] },
      ],
      { targetWidth: 1240, gap: 40, startX: 0, startY: 0 }
    );

    expect(result.rows).toBe(2);
    const c = result.placements.find((p) => p.id === 'c');
    expect(c?.row).toBe(1);
    // Second row starts below the first row's height plus the gap.
    expect(c?.y).toBe(result.rowHeights[0] + 40);
    expectNoOverlaps(result.placements);
  });

  it('leaves a short final row at its natural width by default', () => {
    const result = layoutJustifiedZones(
      [
        { id: 'a', shapes: [shape(1, 600, 200)] },
        { id: 'b', shapes: [shape(1, 600, 200)] },
        { id: 'lonely', shapes: [shape(1, 300, 200)] },
      ],
      { targetWidth: 1240, gap: 40, startX: 0, startY: 0 }
    );

    const lonely = result.placements.find((p) => p.id === 'lonely');
    // Stretching one zone across the whole canvas reads as a bug, not a layout.
    expect(lonely?.width).toBe(300);
  });

  it('stretches the final row when asked', () => {
    const result = layoutJustifiedZones([{ id: 'lonely', shapes: [shape(1, 300, 200)] }], {
      targetWidth: 1000,
      gap: 40,
      startX: 0,
      startY: 0,
      justifyLastRow: true,
    });

    expect(result.placements[0].width).toBe(1000);
  });

  it('reports a row it cannot shrink into the target width', () => {
    const result = layoutJustifiedZones([{ id: 'huge', shapes: [shape(1, 2000, 300)] }], {
      targetWidth: 1000,
      gap: 40,
      startX: 0,
      startY: 0,
    });

    // Kept at its real size and flagged, rather than clipped in silence.
    expect(result.placements[0].width).toBe(2000);
    expect(result.overflowingRows).toEqual([0]);
  });

  it('breaks a row so a tall zone can take a wider, shorter shape', () => {
    // Without a target height these two pack into one row, which forces the
    // flexible zone to its 300x900 portrait and leaves the short zone 600px
    // of blank. The target makes its own row the cheaper answer.
    const zones = [
      { id: 'flexible', shapes: [shape(1, 300, 900), shape(3, 900, 300)] },
      { id: 'short', shapes: [shape(1, 300, 300)] },
    ];

    const packed = layoutJustifiedZones(zones, {
      targetWidth: 1000,
      gap: 40,
      startX: 0,
      startY: 0,
    });
    expect(packed.rows).toBe(1);
    expect(packed.rowHeights[0]).toBe(900);

    const targeted = layoutJustifiedZones(zones, {
      targetWidth: 1000,
      gap: 40,
      startX: 0,
      startY: 0,
      targetRowHeight: 300,
    });
    expect(targeted.rows).toBe(2);
    expect(targeted.placements.find((p) => p.id === 'flexible')?.columns).toBe(3);
    expect(targeted.rowHeights).toEqual([300, 300]);
    expectNoOverlaps(targeted.placements);
  });

  it('ignores a preferred shape too wide for the row', () => {
    // The 2000-wide shape is closest to the target height but cannot fit, so
    // row breaking must fall back to a shape that does.
    const result = layoutJustifiedZones(
      [
        { id: 'a', shapes: [shape(1, 400, 800), shape(4, 2000, 300)] },
        { id: 'b', shapes: [shape(1, 400, 800)] },
      ],
      { targetWidth: 1000, gap: 40, startX: 0, startY: 0, targetRowHeight: 300 }
    );

    expect(result.overflowingRows).toEqual([]);
    expectNoOverlaps(result.placements);
    for (const placement of result.placements) {
      expect(placement.width).toBeLessThanOrEqual(1000);
    }
  });

  it('honours maxPerRow', () => {
    const zones = ['a', 'b', 'c'].map((id) => ({ id, shapes: [shape(1, 100, 100)] }));
    const result = layoutJustifiedZones(zones, {
      targetWidth: 2000,
      gap: 40,
      startX: 0,
      startY: 0,
      maxPerRow: 2,
    });

    expect(result.rows).toBe(2);
  });

  it('keeps explicit grid rows and columns stable even when targetWidth would wrap them', () => {
    const zones = Array.from({ length: 9 }, (_, index) => ({
      id: `zone-${index}`,
      shapes: [shape(1, index % 2 === 0 ? 600 : 420, 200 + (index % 3) * 40)],
    }));
    const result = layoutJustifiedZones(zones, {
      targetWidth: 1600,
      gap: 40,
      startX: 80,
      startY: 80,
      fixedItemsPerRow: 3,
    });

    expect(result.rows).toBe(3);
    expect(result.placements.map(({ row, column }) => ({ row, column }))).toEqual(
      Array.from({ length: 9 }, (_, index) => ({
        row: Math.floor(index / 3),
        column: index % 3,
      }))
    );
    for (const column of [0, 1, 2]) {
      expect(
        new Set(result.placements.filter((item) => item.column === column).map((item) => item.x))
          .size
      ).toBe(1);
    }
    expectNoOverlaps(result.placements);
  });

  it('does not create empty fixed tracks when the requested grid is wider than its items', () => {
    const result = layoutJustifiedZones(
      ['a', 'b'].map((id) => ({ id, shapes: [shape(1, 400, 200)] })),
      { targetWidth: 1000, gap: 40, fixedItemsPerRow: 20 }
    );

    expect(result).toMatchObject({ rows: 1, overflowingRows: [] });
    expect(result.placements.map(({ column }) => column)).toEqual([0, 1]);
    expectNoOverlaps(result.placements);
  });

  it('drops a shape that is wider and taller than another', () => {
    // 600x400 is dominated by 400x300: worse in both directions, never useful.
    const result = layoutJustifiedZones(
      [{ id: 'a', shapes: [shape(2, 600, 400), shape(1, 400, 300)] }],
      { targetWidth: 400, gap: 40, startX: 0, startY: 0 }
    );

    expect(result.placements[0].columns).toBe(1);
    expect(result.overflowingRows).toEqual([]);
  });

  it('rejects an empty or non-finite shape set', () => {
    expect(() => layoutJustifiedZones([{ id: 'a', shapes: [] }], { targetWidth: 100 })).toThrow(
      /no candidate shapes/
    );
    expect(() =>
      layoutJustifiedZones([{ id: 'a', shapes: [shape(1, Number.NaN, 10)] }], { targetWidth: 100 })
    ).toThrow(/non-finite/);
    expect(() =>
      layoutJustifiedZones([{ id: 'a', shapes: [shape(1, 0, 10)] }], { targetWidth: 100 })
    ).toThrow(/non-positive/);
  });

  it('returns an empty layout for no zones', () => {
    const result = layoutJustifiedZones([], { targetWidth: 1000 });
    expect(result).toMatchObject({ placements: [], rows: 0, width: 0, height: 0 });
  });

  it('keeps rows non-overlapping across a larger mixed board', () => {
    const zones = Array.from({ length: 9 }, (_, index) => ({
      id: `zone-${index}`,
      shapes: [
        shape(1, 300 + index * 20, 700 - index * 40),
        shape(2, 640 + index * 20, 380 - index * 20),
      ],
    }));
    const result = layoutJustifiedZones(zones, {
      targetWidth: 1600,
      gap: 40,
      startX: 0,
      startY: 0,
    });
    expectNoOverlaps(result.placements);
    expect(result.placements).toHaveLength(9);
  });

  it('makes row justification and short-last-row alignment explicit', () => {
    const zones = ['a', 'b', 'c'].map((id) => ({ id, shapes: [shape(1, 300, 200)] }));
    const justified = layoutJustifiedZones(zones, {
      targetWidth: 800,
      gap: 40,
      maxPerRow: 2,
      startX: 0,
      startY: 0,
      lastRowAlignment: 'center',
    });
    expect(justified.placements.slice(0, 2).map(({ width }) => width)).toEqual([380, 380]);
    expect(justified.placements[2]).toMatchObject({ x: 250, width: 300 });

    const natural = layoutJustifiedZones(zones, {
      targetWidth: 800,
      gap: 40,
      maxPerRow: 2,
      startX: 0,
      startY: 0,
      justifyRows: false,
      lastRowAlignment: 'end',
    });
    expect(natural.placements.slice(0, 2).map(({ width }) => width)).toEqual([300, 300]);
    expect(natural.placements[2]).toMatchObject({ x: 500, width: 300 });
  });

  it('never resizes an ineligible loose frame while justifying eligible peers', () => {
    const result = layoutJustifiedZones(
      [
        { id: 'zone', shapes: [shape(1, 300, 200)] },
        { id: 'note', shapes: [shape(1, 200, 120)], resizable: false },
      ],
      {
        targetWidth: 800,
        gap: 40,
        maxPerRow: 2,
        startX: 0,
        startY: 0,
        justifyLastRow: true,
      }
    );
    expect(result.placements.find(({ id }) => id === 'note')).toMatchObject({
      width: 200,
      height: 120,
    });
    expect(result.placements.find(({ id }) => id === 'zone')?.width).toBe(560);
  });
});

describe('zoneShapesForItems', () => {
  const items = Array.from({ length: 6 }, (_, index) => ({
    id: `item-${index}`,
    width: 380,
    height: 56,
  }));

  it('offers a portrait shape and a landscape shape for the same contents', () => {
    const shapes = zoneShapesForItems(items, { titleInset: 64, padding: 24, gapX: 24, gapY: 24 });

    const portrait = shapes[0];
    const landscape = shapes[shapes.length - 1];
    expect(portrait.columns).toBe(1);
    expect(portrait.height).toBeGreaterThan(landscape.height);
    expect(portrait.width).toBeLessThan(landscape.width);
  });

  it('accounts for the label inset and padding in every shape', () => {
    const [single] = zoneShapesForItems([{ id: 'only', width: 380, height: 56 }], {
      titleInset: 64,
      padding: 24,
    });

    expect(single.width).toBe(380 + 48);
    expect(single.height).toBe(56 + 64 + 48);
  });

  it('handles an empty zone without dropping it from the layout', () => {
    const shapes = zoneShapesForItems([], { titleInset: 64, padding: 24 });
    expect(shapes).toHaveLength(1);
    expect(shapes[0].height).toBe(64 + 48);
  });

  it('produces shapes a worktree-width item can actually hold', () => {
    // The constraint that breaks a naive photo-grid port: this content cannot
    // be scaled down, so no shape may be narrower than the card plus padding.
    const shapes = zoneShapesForItems([{ id: 'worktree', width: 500, height: 200 }], {
      padding: 24,
    });
    for (const candidate of shapes) {
      expect(candidate.width).toBeGreaterThanOrEqual(500 + 48);
    }
  });
});
