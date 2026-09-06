import { describe, expect, it } from 'vitest';
import {
  BOARD_GRID_SIZE,
  layoutAlignedRectangles,
  layoutCompactRectangles,
  layoutRectangles,
  type RectanglePlacement,
  snapBoardGridPoint,
} from './rectangle-packing';

describe('layoutAlignedRectangles', () => {
  const sideBySide = [
    { id: 'a', width: 300, height: 200, sourceX: 0, sourceY: 100 },
    { id: 'b', width: 400, height: 160, sourceX: 400, sourceY: 100 },
    { id: 'c', width: 240, height: 240, sourceX: 900, sourceY: 100 },
  ];

  it('aligns a horizontal row on the left without stacking zones on one another', () => {
    const result = layoutAlignedRectangles(sideBySide, 'left', {
      gap: 40,
      gridSize: BOARD_GRID_SIZE,
    });

    expect(result.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: 'a', x: 0, y: 100 },
      { id: 'b', x: 0, y: 340 },
      { id: 'c', x: 0, y: 540 },
    ]);
    expectNoOverlap(result);
  });

  it('keeps already separated perpendicular positions and is permutation-stable', () => {
    const separated = [
      { ...sideBySide[0], sourceY: 0 },
      { ...sideBySide[1], sourceY: 400 },
      { ...sideBySide[2], sourceY: 900 },
    ];
    const first = layoutAlignedRectangles(separated, 'center', {
      gap: 40,
      gridSize: BOARD_GRID_SIZE,
    });
    const permuted = layoutAlignedRectangles([...separated].reverse(), 'center', {
      gap: 40,
      gridSize: BOARD_GRID_SIZE,
    });

    expect(first.map((item) => item.y)).toEqual([0, 400, 900]);
    expect(new Map(permuted.map((item) => [item.id, item]))).toEqual(
      new Map(first.map((item) => [item.id, item]))
    );
    expectNoOverlap(first);
  });

  it('aligns a vertical column on top and minimally shifts later peers to the right', () => {
    const result = layoutAlignedRectangles(
      [
        { id: 'a', width: 300, height: 200, sourceX: 100, sourceY: 0 },
        { id: 'b', width: 200, height: 300, sourceX: 100, sourceY: 400 },
      ],
      'top',
      { gap: 40, gridSize: BOARD_GRID_SIZE }
    );

    expect(result.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: 'a', x: 100, y: 0 },
      { id: 'b', x: 440, y: 0 },
    ]);
    expectNoOverlap(result);
  });

  it('is idempotent and absorbs sub-grid position noise', () => {
    const options = { gap: 40, gridSize: BOARD_GRID_SIZE };
    const first = layoutAlignedRectangles(sideBySide, 'right', options);
    const repeated = layoutAlignedRectangles(
      first.map((item) => ({
        id: item.id,
        width: item.width,
        height: item.height,
        sourceX: item.x + 0.4,
        sourceY: item.y + 0.4,
      })),
      'right',
      options
    );

    expect(repeated).toEqual(first);
  });
});

function expectNoOverlap(placements: RectanglePlacement[]): void {
  for (const [index, a] of placements.entries()) {
    for (const b of placements.slice(index + 1)) {
      const separated =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      expect(separated, `${a.id} overlaps ${b.id}`).toBe(true);
    }
  }
}

describe('layoutRectangles', () => {
  it('keeps item sizes on the manual grid while preserving an exact visual gap', () => {
    const result = layoutRectangles(
      [
        { id: 'zone', width: 613, height: 397 },
        { id: 'card', width: 381, height: 117 },
      ],
      { preferredColumns: 2, padding: 24, gapX: 27, gapY: 31, gridSize: BOARD_GRID_SIZE }
    );

    for (const placement of result.placements) {
      for (const value of [placement.width, placement.height]) {
        expect(value % BOARD_GRID_SIZE).toBe(0);
      }
    }
    expect(snapBoardGridPoint(result.placements[0]!)).toEqual({
      x: result.placements[0]!.x,
      y: result.placements[0]!.y,
    });
    expect(result.placements[1]!.x - (result.placements[0]!.x + result.placements[0]!.width)).toBe(
      27
    );
  });

  it('handles empty and single-item layouts without phantom rows or columns', () => {
    const empty = layoutRectangles([], { bounds: { width: 0, height: 0 } });
    expect(empty).toMatchObject({ placements: [], columns: 1, rows: 0 });

    const single = layoutRectangles([{ id: 'only', width: 120, height: 80 }], {
      bounds: { width: 160, height: 120 },
      padding: 20,
    });
    expect(single).toMatchObject({ columns: 1, rows: 1, overflowingItemIds: [] });
    expect(single.placements[0]).toMatchObject({ x: 20, y: 20, row: 0, column: 0 });
  });

  it('packs different rendered sizes into complete row-major rows and columns', () => {
    const result = layoutRectangles(
      [
        { id: 'worktree', width: 500, height: 200 },
        { id: 'short-card', width: 280, height: 64 },
        { id: 'note', width: 320, height: 180 },
        { id: 'tall-card', width: 280, height: 240 },
      ],
      { preferredColumns: 2, padding: 20, gapX: 30, gapY: 40 }
    );

    expect(result).toMatchObject({ mode: 'grid', columns: 2, rows: 2 });
    expect(
      result.placements.map(({ id, x, y, row, column }) => ({ id, x, y, row, column }))
    ).toEqual([
      { id: 'worktree', x: 20, y: 20, row: 0, column: 0 },
      { id: 'short-card', x: 550, y: 20, row: 0, column: 1 },
      { id: 'note', x: 20, y: 260, row: 1, column: 0 },
      { id: 'tall-card', x: 550, y: 260, row: 1, column: 1 },
    ]);
    expectNoOverlap(result.placements);
  });

  it('uses actual per-column widths instead of multiplying the widest item', () => {
    const result = layoutRectangles(
      [
        { id: 'wide', width: 500, height: 100 },
        { id: 'narrow-a', width: 120, height: 100 },
        { id: 'medium', width: 260, height: 100 },
        { id: 'narrow-b', width: 120, height: 100 },
      ],
      {
        bounds: { width: 700, height: 300 },
        preferredColumns: 2,
        padding: 20,
        gapX: 20,
        gapY: 20,
      }
    );

    expect(result).toMatchObject({ mode: 'grid', columns: 2, rows: 2 });
    expect(result.width).toBe(680);
    expect(result.overflowingItemIds).toEqual([]);
    expectNoOverlap(result.placements);
  });

  it('chooses the nearest fitting column count and contains every full rectangle', () => {
    const result = layoutRectangles(
      Array.from({ length: 20 }, (_, index) => ({
        id: `card-${index}`,
        width: 380,
        height: 56,
      })),
      {
        bounds: { width: 620, height: 1800 },
        preferredColumns: 3,
        padding: 24,
        gapX: 24,
        gapY: 24,
      }
    );

    expect(result).toMatchObject({ mode: 'grid', columns: 1, rows: 20 });
    expect(result.overflowingItemIds).toEqual([]);
    expect(result.placements.at(-1)).toMatchObject({ x: 24, y: 1544 });
    expectNoOverlap(result.placements);
  });

  it('compacts outer margins before it considers overlapping a roomy zone', () => {
    const result = layoutRectangles(
      Array.from({ length: 20 }, (_, index) => ({ id: `card-${index}`, width: 380, height: 200 })),
      {
        bounds: { width: 1200, height: 1800 },
        preferredColumns: 3,
        padding: 24,
        minPadding: 8,
        gapX: 24,
        gapY: 24,
        minGapX: 8,
        minGapY: 8,
      }
    );

    expect(result).toMatchObject({
      mode: 'grid',
      columns: 3,
      rows: 7,
      padding: 8,
      fitsWithoutOverlap: true,
      overflowingItemIds: [],
    });
    expectNoOverlap(result.placements);
  });

  it('uses a contained grid fallback when a requested column target cannot fit', () => {
    const result = layoutRectangles(
      Array.from({ length: 20 }, (_, index) => ({ id: `card-${index}`, width: 380, height: 200 })),
      {
        bounds: { width: 1200, height: 1800 },
        preferredColumns: 1,
        padding: 24,
        minPadding: 8,
        gapX: 24,
        gapY: 24,
        minGapX: 8,
        minGapY: 8,
      }
    );

    expect(result).toMatchObject({
      mode: 'grid',
      columns: 3,
      rows: 7,
      fitsWithoutOverlap: true,
      overflowingItemIds: [],
    });
    expectNoOverlap(result.placements);
  });

  it('uses the maximum number of stacks only when a separated grid cannot fit', () => {
    const result = layoutRectangles(
      Array.from({ length: 6 }, (_, index) => ({ id: `card-${index}`, width: 180, height: 140 })),
      {
        bounds: { width: 450, height: 350 },
        preferredColumns: 2,
        padding: 20,
        gapX: 20,
        gapY: 20,
        deckOffset: 8,
      }
    );

    expect(result).toMatchObject({
      mode: 'deck',
      columns: 2,
      rows: 2,
      stackCount: 4,
      maxDeckDepth: 2,
      fitsWithoutOverlap: false,
    });
    expect(result.placements[4]).toMatchObject({
      x: result.placements[0]?.x + 8,
      y: result.placements[0]?.y + 8,
      stackIndex: 0,
      deckDepth: 1,
    });
    expect(result.overflowingItemIds).toEqual([]);
  });

  it('keeps exact deck columns and exposes every cascade layer', () => {
    const result = layoutRectangles(
      Array.from({ length: 6 }, (_, index) => ({ id: `card-${index}`, width: 180, height: 140 })),
      {
        bounds: { width: 450, height: 500 },
        exactColumns: 1,
        padding: 20,
        minPadding: 20,
        gapX: 20,
        gapY: 20,
        allowDeck: true,
        deckOffsetX: 12,
        deckOffsetY: 48,
      }
    );

    expect(result).toMatchObject({
      mode: 'deck',
      columns: 1,
      rows: 1,
      stackCount: 1,
      maxDeckDepth: 6,
      fitsWithoutOverlap: false,
      deckOffsetX: 12,
      deckOffsetY: 48,
      width: 280,
      height: 420,
    });
    expect(result.overflowingItemIds).toEqual([]);
    expect(result.placements.every((placement) => placement.column === 0)).toBe(true);
    expect(result.placements[1]).toMatchObject({
      x: result.placements[0]?.x + 12,
      y: result.placements[0]?.y + 48,
      stackIndex: 0,
      deckDepth: 1,
    });
    expect(result.placements.at(-1)).toMatchObject({
      x: result.placements[0]?.x + 60,
      y: result.placements[0]?.y + 240,
      stackIndex: 0,
      deckDepth: 5,
    });
  });

  it('does not silently substitute a fitting count for exact columns', () => {
    const result = layoutRectangles(
      Array.from({ length: 4 }, (_, index) => ({ id: `card-${index}`, width: 180, height: 80 })),
      {
        bounds: { width: 450, height: 300 },
        exactColumns: 3,
        padding: 20,
        gapX: 20,
        gapY: 20,
      }
    );

    expect(result).toMatchObject({ mode: 'grid', columns: 3, rows: 2 });
    expect(result.overflowingItemIds.length).toBeGreaterThan(0);
  });

  it('rejects ambiguous exact and preferred column options', () => {
    expect(() =>
      layoutRectangles([{ id: 'card', width: 100, height: 100 }], {
        preferredColumns: 1,
        exactColumns: 1,
      })
    ).toThrow('Specify either preferredColumns or exactColumns, not both.');
  });

  it('reports items that are physically larger than the container', () => {
    const result = layoutRectangles([{ id: 'oversized', width: 700, height: 300 }], {
      bounds: { width: 620, height: 400 },
      padding: 24,
    });

    expect(result.overflowingItemIds).toEqual(['oversized']);
    expect(result.placements[0]).toMatchObject({ x: 24, y: 24 });
  });

  it('terminates for very large heterogeneous inputs without leaving grid holes', () => {
    const items = Array.from({ length: 10_000 }, (_, index) => ({
      id: `item-${index}`,
      width: 80 + (index % 17),
      height: 40 + (index % 29),
    }));
    const result = layoutRectangles(items, {
      bounds: { width: 1_200, height: 1_000_000 },
      preferredColumns: 10,
      padding: 8,
      minPadding: 8,
      gapX: 8,
      gapY: 8,
      minGapX: 8,
      minGapY: 8,
    });

    expect(result).toMatchObject({ mode: 'grid', columns: 10, rows: 1_000 });
    expect(result.overflowingItemIds).toEqual([]);
    expect(result.placements).toHaveLength(items.length);
    expect(result.placements.every((item, index) => item.stackIndex === index)).toBe(true);
    for (const [index, placement] of result.placements.entries()) {
      expect(placement.row).toBe(Math.floor(index / result.columns));
      expect(placement.column).toBe(index % result.columns);
      const left = placement.column > 0 ? result.placements[index - 1] : undefined;
      const above = placement.row > 0 ? result.placements[index - result.columns] : undefined;
      if (left) expect(left.x + left.width).toBeLessThanOrEqual(placement.x);
      if (above) expect(above.y + above.height).toBeLessThanOrEqual(placement.y);
    }
  });

  it('preserves supported sub-grid gaps as exact rectangle boundaries', () => {
    const widths = [0, 4, 12, 24].map((gap) => {
      const result = layoutRectangles(
        [
          { id: 'left', width: 101, height: 80 },
          { id: 'right', width: 101, height: 80 },
        ],
        { exactColumns: 2, gapX: gap, gapY: gap, gridSize: BOARD_GRID_SIZE }
      );
      const [left, right] = result.placements;
      expect(right!.x - (left!.x + left!.width)).toBe(gap);
      expect(result.gapX).toBe(gap);
      return result.width;
    });

    expect(widths).toEqual([240, 244, 252, 264]);
  });

  it('packs heterogeneous board shapes into a smaller-diameter non-grid cluster', () => {
    const items = [
      { id: 'wide', width: 800, height: 160, sourceX: 0, sourceY: 0 },
      { id: 'tall', width: 220, height: 500, sourceX: 0, sourceY: 240 },
      { id: 'artifact-a', width: 260, height: 180, sourceX: 300, sourceY: 240 },
      { id: 'artifact-b', width: 260, height: 180, sourceX: 600, sourceY: 240 },
      { id: 'card', width: 260, height: 180, sourceX: 600, sourceY: 460 },
    ];
    const cluster = layoutCompactRectangles(items, {
      gapX: 40,
      gapY: 40,
      gridSize: BOARD_GRID_SIZE,
    });
    const squareGrid = layoutRectangles(items, {
      preferredColumns: 3,
      gapX: 40,
      gapY: 40,
      gridSize: BOARD_GRID_SIZE,
    });

    expect(cluster.mode).toBe('cluster');
    expect(cluster.placements.map((item) => item.id)).toEqual(items.map((item) => item.id));
    expectNoOverlap(cluster.placements);
    expect(cluster.width ** 2 + cluster.height ** 2).toBeLessThan(
      squareGrid.width ** 2 + squareGrid.height ** 2
    );
    // A true frontier pack occupies both axes rather than degenerating into a
    // horizontal or vertical shelf. Exact corners are intentionally free to
    // improve as long as the lexicographic compact objective improves.
    expect(new Set(cluster.placements.map((item) => item.x)).size).toBeGreaterThan(1);
    expect(new Set(cluster.placements.map((item) => item.y)).size).toBeGreaterThan(1);
  });

  it('handles empty and single-item compact clusters without phantom movement', () => {
    expect(layoutCompactRectangles([], { padding: 20 })).toMatchObject({
      placements: [],
      columns: 1,
      rows: 0,
      width: 40,
      height: 40,
    });
    expect(
      layoutCompactRectangles(
        [{ id: 'only', width: 301, height: 179, sourceX: 480, sourceY: 260 }],
        { padding: 20, gridSize: BOARD_GRID_SIZE }
      )
    ).toMatchObject({
      placements: [{ id: 'only', x: 20, y: 20, width: 320, height: 180 }],
      columns: 1,
      rows: 1,
    });
  });

  it('is deterministic, grid-snapped, gap-separated, and retains input identity order', () => {
    const items = [
      { id: 'zone', width: 613, height: 377, sourceX: 900, sourceY: 100 },
      { id: 'artifact', width: 347, height: 291, sourceX: 120, sourceY: 600 },
      { id: 'worktree', width: 381, height: 143, sourceX: 540, sourceY: 620 },
      { id: 'note', width: 219, height: 407, sourceX: 980, sourceY: 650 },
    ];
    const first = layoutCompactRectangles(items, {
      padding: 20,
      gapX: 40,
      gapY: 40,
      gridSize: BOARD_GRID_SIZE,
    });
    const second = layoutCompactRectangles(items, {
      padding: 20,
      gapX: 40,
      gapY: 40,
      gridSize: BOARD_GRID_SIZE,
    });

    expect(second).toEqual(first);
    expect(first.placements.every((item) => item.x % 20 === 0 && item.y % 20 === 0)).toBe(true);
    expect(first.placements.map((item) => item.id)).toEqual(items.map((item) => item.id));
    for (const [index, left] of first.placements.entries()) {
      for (const right of first.placements.slice(index + 1)) {
        expect(
          left.x + left.width + 40 <= right.x ||
            right.x + right.width + 40 <= left.x ||
            left.y + left.height + 40 <= right.y ||
            right.y + right.height + 40 <= left.y
        ).toBe(true);
      }
    }
  });

  it('uses existing spatial geometry to break equally compact placement ties', () => {
    const base = { id: 'base', width: 200, height: 200, sourceX: 0, sourceY: 0 };
    const toRight = layoutCompactRectangles(
      [base, { id: 'peer', width: 200, height: 200, sourceX: 300, sourceY: 0 }],
      { gapX: 40, gapY: 40 }
    );
    const below = layoutCompactRectangles(
      [base, { id: 'peer', width: 200, height: 200, sourceX: 0, sourceY: 300 }],
      { gapX: 40, gapY: 40 }
    );

    expect(toRight.placements[1]).toMatchObject({ x: 240, y: 0 });
    expect(below.placements[1]).toMatchObject({ x: 0, y: 240 });
  });

  it('is idempotent when its prior placements become the next source geometry', () => {
    const items = [
      { id: 'wide', width: 800, height: 160, sourceX: 0, sourceY: 0 },
      { id: 'tall', width: 220, height: 500, sourceX: 0, sourceY: 240 },
      { id: 'artifact-a', width: 260, height: 180, sourceX: 300, sourceY: 240 },
      { id: 'artifact-b', width: 260, height: 180, sourceX: 600, sourceY: 240 },
      { id: 'worktree', width: 260, height: 180, sourceX: 600, sourceY: 460 },
    ];
    const options = { gapX: 40, gapY: 40, gridSize: BOARD_GRID_SIZE };
    const first = layoutCompactRectangles(items, options);
    const firstById = new Map(first.placements.map((item) => [item.id, item]));
    const second = layoutCompactRectangles(
      items.map((item) => ({
        ...item,
        sourceX: firstById.get(item.id)?.x,
        sourceY: firstById.get(item.id)?.y,
      })),
      options
    );

    expect(second).toEqual(first);
  });

  it('packs a heterogeneous cluster inside a bounded zone without overlap', () => {
    const result = layoutCompactRectangles(
      [
        { id: 'wide-card', width: 520, height: 120, sourceX: 20, sourceY: 80 },
        { id: 'tall-artifact', width: 180, height: 380, sourceX: 20, sourceY: 240 },
        { id: 'worktree', width: 300, height: 160, sourceX: 240, sourceY: 240 },
        { id: 'note', width: 300, height: 160, sourceX: 240, sourceY: 440 },
      ],
      {
        bounds: { width: 760, height: 660 },
        padding: 20,
        gapX: 20,
        gapY: 20,
        gridSize: BOARD_GRID_SIZE,
      }
    );

    expect(result.overflowingItemIds).toEqual([]);
    expectNoOverlap(result.placements);
    for (const item of result.placements) {
      expect(item.x).toBeGreaterThanOrEqual(20);
      expect(item.y).toBeGreaterThanOrEqual(20);
      expect(item.x + item.width).toBeLessThanOrEqual(740);
      expect(item.y + item.height).toBeLessThanOrEqual(640);
    }
  });

  it('honors a narrow zone bound when the unconstrained diameter prefers a horizontal pair', () => {
    const result = layoutCompactRectangles(
      [
        { id: 'tall-a', width: 100, height: 300 },
        { id: 'tall-b', width: 100, height: 300 },
      ],
      {
        bounds: { width: 140, height: 660 },
        padding: 20,
        gapX: 20,
        gapY: 20,
        gridSize: BOARD_GRID_SIZE,
      }
    );

    expect(result.overflowingItemIds).toEqual([]);
    expect(result.placements[1]).toMatchObject({ x: 20, y: 340 });
  });

  it('reports bounded overflow without returning a partial cluster', () => {
    const result = layoutCompactRectangles(
      [
        { id: 'one', width: 380, height: 200 },
        { id: 'two', width: 380, height: 200 },
      ],
      {
        bounds: { width: 420, height: 300 },
        padding: 20,
        gapX: 20,
        gapY: 20,
        gridSize: BOARD_GRID_SIZE,
      }
    );

    expect(result.placements).toHaveLength(2);
    expect(result.overflowingItemIds).toContain('two');
    expectNoOverlap(result.placements);
  });

  it('absorbs sub-grid measurement noise into the same durable cluster', () => {
    const options = { gapX: 20, gapY: 20, gridSize: BOARD_GRID_SIZE };
    const base = layoutCompactRectangles(
      [
        { id: 'card', width: 379.1, height: 99.1, sourceX: 19.2, sourceY: 79.4 },
        { id: 'artifact', width: 599.1, height: 399.1, sourceX: 419.2, sourceY: 79.4 },
      ],
      options
    );
    const noisy = layoutCompactRectangles(
      [
        { id: 'card', width: 379.8, height: 99.8, sourceX: 19.8, sourceY: 79.9 },
        { id: 'artifact', width: 599.8, height: 399.8, sourceX: 419.8, sourceY: 79.9 },
      ],
      options
    );

    expect(noisy).toEqual(base);
  });
});
