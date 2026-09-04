import { describe, expect, it } from 'vitest';
import {
  type BoardZoneArrangementInput,
  containingBoardZoneId,
  DEFAULT_BOARD_ZONE_ARRANGEMENT,
  planBoardZoneArrangement,
} from './board-zone-arrangement';
import { growZoneLayoutHeight } from './zone-layout';

const item = (id: string, width: number, height: number, x = 0, y = 0) => ({
  id,
  entityType: 'card' as const,
  width,
  height,
  position: { x, y },
});
const branchItem = (id: string, width: number, height: number, x = 0, y = 0) => ({
  ...item(id, width, height, x, y),
  entityType: 'branch' as const,
});
const zone = (
  id: string,
  x: number,
  y: number,
  items: BoardZoneArrangementInput['items']
): BoardZoneArrangementInput => ({ id, x, y, width: 600, height: 500, items });

describe('planBoardZoneArrangement', () => {
  it('keeps a protruding anchored canvas child in its smallest containing zone', () => {
    expect(
      containingBoardZoneId({ x: 100, y: 120, width: 860, height: 660 }, [
        { id: 'outer', x: 0, y: 0, width: 1200, height: 1000 },
        { id: 'tiny', x: 80, y: 80, width: 300, height: 220 },
      ])
    ).toBe('tiny');
    expect(
      containingBoardZoneId({ x: 400, y: 400, width: 100, height: 100 }, [
        { id: 'tiny', x: 80, y: 80, width: 300, height: 220 },
      ])
    ).toBeUndefined();
  });

  it('packs inner geometry before outer placement, growing small zones and compacting waste', () => {
    const plan = planBoardZoneArrangement(
      [
        { ...zone('tiny', 0, 0, [item('protruding', 860, 660, 20, 120)]), width: 300, height: 220 },
        { ...zone('wasteful', 400, 0, [item('single', 380, 100)]), width: 1600, height: 900 },
        { ...zone('empty', 2100, 0, []), width: 1600, height: 900 },
      ],
      { looseItems: [{ id: 'free', x: 0, y: 1200, width: 500, height: 300 }] }
    );
    const tiny = plan.zones.find(({ id }) => id === 'tiny')!;
    const wasteful = plan.zones.find(({ id }) => id === 'wasteful')!;
    const empty = plan.zones.find(({ id }) => id === 'empty')!;

    expect(tiny.width).toBeGreaterThanOrEqual(900);
    expect(tiny.items[0]!.x + tiny.items[0]!.width).toBeLessThanOrEqual(tiny.width);
    expect(tiny.items[0]!.y + tiny.items[0]!.height).toBeLessThanOrEqual(tiny.height);
    expect(wasteful.width).toBeLessThan(1600);
    expect(wasteful.height).toBeLessThan(900);
    expect(empty).toMatchObject({ width: 600, height: 300 });
    for (const arranged of plan.zones) {
      expect(plan.layout.placements.find(({ id }) => id === arranged.id)).toMatchObject({
        width: arranged.width,
        height: arranged.height,
      });
    }
    // Persisting this explicit packed frame makes it the next durable Auto
    // Grow floor; background maintenance may grow it, but never undo Pack.
    expect(growZoneLayoutHeight(wasteful.height, 120)).toBe(wasteful.height);
    const free = plan.looseItems[0]!;
    expect(
      tiny.position.x + tiny.width <= free.x ||
        free.x + free.width <= tiny.position.x ||
        tiny.position.y + tiny.height <= free.y ||
        free.y + free.height <= tiny.position.y
    ).toBe(true);
  });

  it('preserves zone frames and child geometry when Pack zone contents is off', () => {
    const source = {
      ...zone('manual', 900, 700, [item('child', 860, 660, 20, 120)]),
      width: 300,
      height: 220,
    };
    const arranged = planBoardZoneArrangement([source], { packZoneContents: false }).zones[0]!;
    expect(arranged).toMatchObject({ width: 300, height: 220 });
    expect(arranged.items).toHaveLength(1);
    expect(arranged.items[0]).toMatchObject({
      id: 'child',
      x: 20,
      y: 120,
      width: 860,
      height: 660,
    });
  });

  it('uses shared defaults, preserves persisted input order, and packs every child', () => {
    const plan = planBoardZoneArrangement([
      zone('a-later', 900, 200, [item('later-card', 380, 100)]),
      zone('z-first', 20, 20, [item('first-card', 380, 120), item('first-branch', 500, 200)]),
    ]);
    expect(plan.zones.map(({ id }) => id)).toEqual(['a-later', 'z-first']);
    expect(plan.zones[0]?.position).toEqual({
      x: DEFAULT_BOARD_ZONE_ARRANGEMENT.startX,
      y: DEFAULT_BOARD_ZONE_ARRANGEMENT.startY,
    });
    expect(plan.zones.map(({ items }) => items.length)).toEqual([1, 2]);
    for (const arranged of plan.zones) {
      for (const child of arranged.items) {
        expect(child.x).toBeGreaterThanOrEqual(0);
        expect(child.y).toBeGreaterThan(0);
        expect(child.x + child.width).toBeLessThanOrEqual(arranged.width);
        expect(child.y + child.height).toBeLessThanOrEqual(arranged.height);
      }
    }
  });

  it('is deterministic, grid aligned, and collision free', () => {
    const input = [
      zone('a', 0, 0, [item('a-1', 381, 101), item('a-2', 499, 199)]),
      zone('b', 700, 0, [item('b-1', 380, 160)]),
      zone('c', 0, 700, [item('c-1', 500, 200), item('c-2', 380, 80)]),
    ];
    const first = planBoardZoneArrangement(input);
    expect(planBoardZoneArrangement(input)).toEqual(first);
    for (const arranged of first.zones) {
      for (const value of [
        arranged.position.x,
        arranged.position.y,
        arranged.width,
        arranged.height,
      ])
        expect(value % 20).toBe(0);
    }
    for (const [index, left] of first.zones.entries()) {
      for (const right of first.zones.slice(index + 1)) {
        expect(
          left.position.x < right.position.x + right.width &&
            right.position.x < left.position.x + left.width &&
            left.position.y < right.position.y + right.height &&
            right.position.y < left.position.y + left.height
        ).toBe(false);
      }
    }
  });

  it('keeps empty zones useful and compact lists single-column', () => {
    const plan = planBoardZoneArrangement([
      zone('empty', 0, 0, []),
      {
        ...zone('list', 700, 0, [item('one', 380, 100), item('two', 380, 100)]),
        layout: { preset: 'compact_list' },
      },
    ]);
    const empty = plan.zones.find(({ id }) => id === 'empty');
    const list = plan.zones.find(({ id }) => id === 'list');
    expect(empty?.width).toBeGreaterThanOrEqual(400);
    expect(empty?.height).toBeGreaterThanOrEqual(240);
    expect(list?.contentColumns).toBe(1);
    expect(new Set(list?.items.map(({ x }) => x))).toHaveLength(1);
  });

  it('uses compact-list geometry for capable worktrees/cards but not header-only or canvas items', () => {
    const plan = planBoardZoneArrangement([
      {
        ...zone('honest-list', 0, 0, [
          branchItem('worktree', 500, 220),
          { ...item('generic-card', 380, 180), densityExpandable: true },
          { ...item('header-only-card', 380, 140), densityExpandable: false },
          { id: 'artifact', width: 440, height: 300, position: { x: 0, y: 0 } },
        ]),
        layout: { preset: 'compact_list', gap: 8 },
      },
    ]);
    const byId = new Map(plan.zones[0]?.items.map((entry) => [entry.id, entry]));

    expect(byId.get('worktree')?.height).toBeLessThan(220);
    expect(byId.get('generic-card')?.height).toBeLessThan(180);
    expect(byId.get('header-only-card')).toMatchObject({ width: 380, height: 140 });
    expect(byId.get('artifact')).toMatchObject({ width: 440, height: 300 });
  });

  it('makes two-column Apply geometry identical to a repeated Arrange and idempotent', () => {
    const source = [
      zone('one', 0, 0, [branchItem('one-child', 500, 220)]),
      zone('two', 2200, 0, [item('two-child', 380, 180)]),
      zone('three', 0, 1600, [item('three-child', 380, 100)]),
    ];
    const options = { fixedItemsPerRow: 2 };
    const applied = planBoardZoneArrangement(source, options);
    const reapplied = planBoardZoneArrangement(
      source.map((zoneInput) => {
        const arranged = applied.zones.find(({ id }) => id === zoneInput.id)!;
        const itemById = new Map(arranged.items.map((entry) => [entry.id, entry]));
        return {
          ...zoneInput,
          x: arranged.position.x,
          y: arranged.position.y,
          width: arranged.width,
          height: arranged.height,
          items: zoneInput.items.map((entry) => ({
            ...entry,
            position: {
              x: itemById.get(entry.id)?.x ?? entry.position.x,
              y: itemById.get(entry.id)?.y ?? entry.position.y,
            },
          })),
        };
      }),
      options
    );

    expect(reapplied).toEqual(applied);
    expect(applied.zones.map(({ row, column }) => ({ row, column }))).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 0 },
    ]);
  });

  it('does not feed justified compact-list frame width back into the next Arrange', () => {
    const source = [
      {
        ...zone('list', 0, 0, [
          branchItem('branch', 500, 240),
          { ...item('card', 380, 180), densityExpandable: true },
        ]),
        layout: { preset: 'compact_list' as const, gap: 40 },
      },
      zone('wide', 700, 0, [item('wide-card', 700, 260)]),
      zone('small', 0, 700, [item('small-card', 320, 180)]),
    ];
    const options = { targetAspectRatio: 16 / 9, justifyRows: true };
    const first = planBoardZoneArrangement(source, options);
    const secondSource = source.map((zoneInput) => {
      const arranged = first.zones.find(({ id }) => id === zoneInput.id)!;
      const arrangedItems = new Map(arranged.items.map((entry) => [entry.id, entry]));
      return {
        ...zoneInput,
        ...arranged.position,
        width: arranged.width,
        height: arranged.height,
        items: zoneInput.items.map((entry) => {
          const output = arrangedItems.get(entry.id)!;
          return {
            ...entry,
            width: output.width,
            height: output.height,
            position: { x: output.x, y: output.y },
          };
        }),
      };
    });

    expect(planBoardZoneArrangement(secondSource, options)).toEqual(first);
    expect(first.zones.find(({ id }) => id === 'list')?.items.map(({ width }) => width)).toEqual([
      500, 500,
    ]);
  });

  it('produces a compact aligned three-by-three explicit outer grid', () => {
    const source = Array.from({ length: 9 }, (_, index) => ({
      ...zone(`zone-${index}`, (index % 4) * 900, Math.floor(index / 4) * 700, []),
      width: 400 + (index % 3) * 80,
      height: 260 + (index % 2) * 80,
    }));
    const plan = planBoardZoneArrangement(source, {
      fixedItemsPerRow: 3,
      compactFixedGrid: true,
    });

    expect(plan.layout.rows).toBe(3);
    expect(plan.zones.map(({ row, column }) => ({ row, column }))).toEqual(
      Array.from({ length: 9 }, (_, index) => ({
        row: Math.floor(index / 3),
        column: index % 3,
      }))
    );
    for (const column of [0, 1, 2]) {
      expect(
        new Set(
          plan.zones.filter((entry) => entry.column === column).map((entry) => entry.position.x)
        ).size
      ).toBe(1);
    }
    expect(plan.zones[2]!.position.x - plan.zones[1]!.position.x).toBe(
      plan.zones[1]!.position.x - plan.zones[0]!.position.x
    );
    expect(plan.zones[1]!.position.x - (plan.zones[0]!.position.x + plan.zones[0]!.width)).toBe(40);

    const twoColumns = planBoardZoneArrangement(source.slice(0, 2), {
      fixedItemsPerRow: 2,
      compactFixedGrid: true,
    });
    expect(
      twoColumns.zones[1]!.position.x -
        (twoColumns.zones[0]!.position.x + twoColumns.zones[0]!.width)
    ).toBe(40);
  });

  it('keeps explicit selection rows rigid while minimally clearing fixed board obstacles', () => {
    const source = [
      { ...zone('one', 0, 0, []), width: 400, height: 260 },
      { ...zone('two', 1200, 0, []), width: 520, height: 340 },
      { ...zone('three', 0, 900, []), width: 440, height: 280 },
    ];
    const base = planBoardZoneArrangement(source, {
      fixedItemsPerRow: 2,
      packZoneContents: false,
      anchorToSelectionBounds: true,
    });
    const blockedTarget = base.zones.find(({ id }) => id === 'two')!;
    const obstacle = {
      id: 'locked-note',
      x: blockedTarget.position.x,
      y: blockedTarget.position.y,
      width: 300,
      height: 180,
    };
    const options = {
      fixedItemsPerRow: 2,
      packZoneContents: false,
      anchorToSelectionBounds: true,
      fixedObstacles: [obstacle],
    };
    const arranged = planBoardZoneArrangement(source, options);
    const firstDelta = {
      x: arranged.zones[0]!.position.x - base.zones[0]!.position.x,
      y: arranged.zones[0]!.position.y - base.zones[0]!.position.y,
    };

    expect(firstDelta).not.toEqual({ x: 0, y: 0 });
    expect(
      arranged.zones.map((entry, index) => ({
        x: entry.position.x - base.zones[index]!.position.x,
        y: entry.position.y - base.zones[index]!.position.y,
      }))
    ).toEqual(Array(arranged.zones.length).fill(firstDelta));
    expect(arranged.zones.map(({ row, column }) => ({ row, column }))).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 0 },
    ]);
    for (const entry of arranged.zones) {
      expect(
        entry.position.x < obstacle.x + obstacle.width + 40 &&
          entry.position.x + entry.width + 40 > obstacle.x &&
          entry.position.y < obstacle.y + obstacle.height + 40 &&
          entry.position.y + entry.height + 40 > obstacle.y
      ).toBe(false);
    }

    const repeated = planBoardZoneArrangement(
      source.map((entry) => {
        const next = arranged.zones.find(({ id }) => id === entry.id)!;
        return { ...entry, x: next.position.x, y: next.position.y };
      }),
      options
    );
    expect(repeated).toEqual(arranged);
  });

  it('matches final zone heights only when the explicit grid requests it', () => {
    const source = [
      { ...zone('short', 0, 0, []), height: 240 },
      { ...zone('tall', 800, 0, [item('child', 380, 420)]), height: 560 },
    ];
    const natural = planBoardZoneArrangement(source, {
      fixedItemsPerRow: 2,
      matchRowHeights: false,
    });
    const matched = planBoardZoneArrangement(source, {
      fixedItemsPerRow: 2,
      matchRowHeights: true,
    });

    expect(natural.zones[0]!.height).not.toBe(natural.zones[1]!.height);
    expect(matched.zones[0]!.height).toBe(matched.zones[1]!.height);
  });

  it('keeps Compact boundary gaps uniform instead of inheriting invisible justified tracks', () => {
    const source = [
      zone('empty', 0, 0, []),
      zone('tall', 800, 0, [item('tall-child', 380, 500)]),
      zone('wide', 0, 800, [item('wide-child', 760, 120)]),
    ];
    const compact = planBoardZoneArrangement(source, { compactOuterLayout: true });
    const justified = planBoardZoneArrangement(source);

    expect(compact.zones.map(({ position }) => position)).not.toEqual(
      justified.zones.map(({ position }) => position)
    );
    for (const [index, current] of compact.zones.entries()) {
      if (index === 0) continue;
      expect(
        compact.zones
          .slice(0, index)
          .some(
            (previous) =>
              previous.position.x + previous.width + 40 === current.position.x ||
              current.position.x + current.width + 40 === previous.position.x ||
              previous.position.y + previous.height + 40 === current.position.y ||
              current.position.y + current.height + 40 === previous.position.y
          )
      ).toBe(true);
    }
    const repeated = planBoardZoneArrangement(
      source.map((entry) => {
        const arranged = compact.zones.find(({ id }) => id === entry.id)!;
        const childById = new Map(arranged.items.map((child) => [child.id, child]));
        return {
          ...entry,
          x: arranged.position.x,
          y: arranged.position.y,
          width: arranged.width,
          height: arranged.height,
          items: entry.items.map((child) => ({
            ...child,
            position: {
              x: childById.get(child.id)?.x ?? child.position.x,
              y: childById.get(child.id)?.y ?? child.position.y,
            },
          })),
        };
      }),
      { compactOuterLayout: true }
    );
    expect(repeated).toEqual(compact);
  });

  it('propagates zone spacing to real child boundaries in Grid and Compact board modes', () => {
    const boundaryGap = (gap: number, mode: 'grid' | 'compact') => {
      const arranged = planBoardZoneArrangement(
        [
          {
            ...zone('density', 0, 0, [item('left', 380, 100), item('right', 380, 100)]),
            layout: { preset: 'grid', columns: 2, gap },
          },
        ],
        { mode, packZoneContents: true, resizeZoneFrames: true, justifyRows: mode === 'grid' }
      ).zones[0]!;
      const [left, right] = arranged.items;
      const actualGap =
        arranged.contentColumns === 1
          ? right!.y - (left!.y + left!.height)
          : right!.x - (left!.x + left!.width);
      expect(actualGap).toBe(gap);
      return arranged;
    };

    for (const mode of ['grid', 'compact'] as const) {
      const roomy = boundaryGap(24, mode);
      const medium = boundaryGap(12, mode);
      const dense = boundaryGap(4, mode);
      expect(
        mode === 'grid'
          ? [roomy.width, medium.width, dense.width]
          : [roomy.height, medium.height, dense.height]
      ).toEqual(mode === 'grid' ? [840, 820, 820] : [360, 340, 340]);
      expect(
        planBoardZoneArrangement(
          [
            {
              ...zone('density', dense.position.x, dense.position.y, [
                item('left', 380, 100, dense.items[0]!.x, dense.items[0]!.y),
                item('right', 380, 100, dense.items[1]!.x, dense.items[1]!.y),
              ]),
              width: dense.width,
              height: dense.height,
              layout: { preset: 'grid', columns: 2, gap: 4 },
            },
          ],
          { mode, packZoneContents: true, resizeZoneFrames: true, justifyRows: mode === 'grid' }
        ).zones[0]
      ).toEqual(dense);
    }
  });

  it('does not rewrite child spacing when Pack is off', () => {
    const source = {
      ...zone('manual', 100, 200, [
        item('left', 380, 100, 20, 120),
        item('right', 380, 100, 460, 120),
      ]),
      layout: { preset: 'grid' as const, columns: 2, gap: 4 },
    };
    for (const mode of ['grid', 'compact'] as const) {
      expect(
        planBoardZoneArrangement([source], { mode, packZoneContents: false }).zones[0]?.items.map(
          ({ x, y }) => ({ x, y })
        )
      ).toEqual([
        { x: 20, y: 120 },
        { x: 460, y: 120 },
      ]);
    }
  });

  it('matches both zone frame axes to explicit grid tracks without crossing content minimums', () => {
    const source = [
      zone('empty', 0, 0, []),
      zone('tall', 800, 0, [item('tall-child', 380, 500)]),
      zone('wide', 0, 800, [item('wide-child', 760, 120)]),
    ];
    const options = {
      fixedItemsPerRow: 2,
      compactFixedGrid: true,
      matchColumnWidths: true,
      matchRowHeights: true,
    } as const;
    const matched = planBoardZoneArrangement(source, options);
    const [empty, tall, wide] = matched.zones;

    expect(empty?.width).toBe(wide?.width);
    expect(empty?.height).toBe(tall?.height);
    expect((tall?.position.x ?? 0) - ((empty?.position.x ?? 0) + (empty?.width ?? 0))).toBe(40);
    expect((wide?.position.y ?? 0) - ((empty?.position.y ?? 0) + (empty?.height ?? 0))).toBe(40);
    for (const arranged of matched.zones) {
      for (const child of arranged.items) {
        expect(child.x + child.width).toBeLessThanOrEqual(arranged.width);
        expect(child.y + child.height).toBeLessThanOrEqual(arranged.height);
      }
    }

    const preserved = planBoardZoneArrangement(source, {
      fixedItemsPerRow: 2,
      compactFixedGrid: true,
      matchColumnWidths: false,
      matchRowHeights: false,
    });
    expect(preserved.zones.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 600, height: 240 },
      { width: 420, height: 620 },
      { width: 800, height: 240 },
    ]);
    expect(preserved.zones[1]!.position.x - (preserved.zones[0]!.position.x + 600)).toBeGreaterThan(
      40
    );

    const repeated = planBoardZoneArrangement(
      source.map((entry) => {
        const arranged = matched.zones.find(({ id }) => id === entry.id)!;
        const childById = new Map(arranged.items.map((child) => [child.id, child]));
        return {
          ...entry,
          x: arranged.position.x,
          y: arranged.position.y,
          width: arranged.width,
          height: arranged.height,
          items: entry.items.map((child) => ({
            ...child,
            position: {
              x: childById.get(child.id)?.x ?? child.position.x,
              y: childById.get(child.id)?.y ?? child.position.y,
            },
          })),
        };
      }),
      options
    );
    expect(repeated).toEqual(matched);
  });

  it('carries a measured title scale through zone sizing and child packing', () => {
    const base = { ...zone('large-title', 0, 0, [item('child', 500, 240)]), fontSize: 48 };
    const normal = planBoardZoneArrangement([base]).zones[0]!;
    const zoomedOut = planBoardZoneArrangement([{ ...base, fontScale: 2 }]).zones[0]!;

    expect(zoomedOut.height).toBeGreaterThan(normal.height);
    expect(zoomedOut.items[0]!.y).toBeGreaterThan(normal.items[0]!.y);
  });

  it('does not exceed an explicit zone column preference', () => {
    const plan = planBoardZoneArrangement([
      {
        ...zone(
          'limited',
          0,
          0,
          Array.from({ length: 6 }, (_, index) => item(`item-${index}`, 200, 100))
        ),
        layout: { columns: 2 },
      },
    ]);
    expect(plan.zones[0]?.contentColumns).toBeLessThanOrEqual(2);
  });

  it('uses the compact engine for heterogeneous entity and canvas children', () => {
    const mixed: BoardZoneArrangementInput['items'] = [
      item('wide-worktree', 520, 140, 20, 100),
      item('card', 280, 180, 20, 280),
      { id: 'tall-artifact', width: 260, height: 440, position: { x: 600, y: 100 } },
      { id: 'note', width: 320, height: 140, position: { x: 880, y: 100 } },
      { id: 'app', width: 360, height: 220, position: { x: 880, y: 280 } },
    ];
    const first = planBoardZoneArrangement([zone('mixed', 0, 0, mixed)]);
    const arranged = first.zones[0];

    expect(arranged?.items).toHaveLength(mixed.length);
    expect(arranged?.contentColumns).toBeGreaterThan(0);
    for (const [index, left] of (arranged?.items ?? []).entries()) {
      expect(left.x + left.width).toBeLessThanOrEqual(arranged?.width ?? 0);
      expect(left.y + left.height).toBeLessThanOrEqual(arranged?.height ?? 0);
      for (const right of (arranged?.items ?? []).slice(index + 1)) {
        expect(
          left.x + left.width + 20 <= right.x ||
            right.x + right.width + 20 <= left.x ||
            left.y + left.height + 20 <= right.y ||
            right.y + right.height + 20 <= left.y
        ).toBe(true);
      }
    }

    const byId = new Map(arranged?.items.map((entry) => [entry.id, entry]));
    const second = planBoardZoneArrangement([
      zone(
        'mixed',
        arranged?.position.x ?? 0,
        arranged?.position.y ?? 0,
        mixed.map((entry) => ({
          ...entry,
          position: {
            x: byId.get(entry.id)?.x ?? entry.position.x,
            y: byId.get(entry.id)?.y ?? entry.position.y,
          },
        }))
      ),
    ]);
    expect(second.zones[0]?.items).toEqual(arranged?.items);
  });

  it('normalizes input permutations when a durable logical sort is configured', () => {
    const items: BoardZoneArrangementInput['items'] = [
      { ...item('c', 360, 180), title: 'Charlie' },
      { ...item('a', 520, 140), title: 'Alpha' },
      { id: 'artifact', width: 260, height: 440, position: { x: 700, y: 100 }, title: 'Bravo' },
    ];
    const arrange = (values: BoardZoneArrangementInput['items']) =>
      planBoardZoneArrangement([{ ...zone('sorted', 0, 0, values), layout: { sortBy: 'title' } }])
        .zones[0]?.items;

    expect(arrange([items[2]!, items[0]!, items[1]!])).toEqual(arrange(items));
  });

  it('packs content-sized zones and heterogeneous free board nodes into one idempotent cluster', () => {
    const zones = [
      zone('review', 0, 0, [item('review-card', 380, 120)]),
      zone('shipping', 900, 0, [item('shipping-worktree', 500, 200)]),
    ];
    const looseItems = [
      { id: 'artifact', x: 0, y: 800, width: 720, height: 420 },
      { id: 'free-card', x: 760, y: 800, width: 380, height: 100 },
      { id: 'note', x: 1180, y: 800, width: 260, height: 500 },
    ];
    const first = planBoardZoneArrangement(zones, { looseItems, mode: 'compact' });

    expect(first.boardLayout?.mode).toBe('cluster');
    expect(first.looseItems.map((entry) => entry.id)).toEqual(looseItems.map((entry) => entry.id));
    const topLevel = [
      ...first.zones.map((entry) => ({
        id: entry.id,
        x: entry.position.x,
        y: entry.position.y,
        width: entry.width,
        height: entry.height,
      })),
      ...first.looseItems,
    ];
    for (const [index, left] of topLevel.entries()) {
      for (const right of topLevel.slice(index + 1)) {
        expect(
          left.x + left.width <= right.x ||
            right.x + right.width <= left.x ||
            left.y + left.height <= right.y ||
            right.y + right.height <= left.y,
          `${left.id} overlaps ${right.id}`
        ).toBe(true);
      }
    }

    const firstZoneById = new Map(first.zones.map((entry) => [entry.id, entry]));
    const second = planBoardZoneArrangement(
      zones.map((entry) => ({
        ...entry,
        x: firstZoneById.get(entry.id)?.position.x ?? entry.x,
        y: firstZoneById.get(entry.id)?.position.y ?? entry.y,
      })),
      {
        mode: 'compact',
        looseItems: looseItems.map((entry) => {
          const placed = first.looseItems.find((item) => item.id === entry.id);
          return { ...entry, x: placed?.x ?? entry.x, y: placed?.y ?? entry.y };
        }),
      }
    );
    expect(new Map(second.zones.map((entry) => [entry.id, entry.position]))).toEqual(
      new Map(first.zones.map((entry) => [entry.id, entry.position]))
    );
    expect(second.looseItems).toEqual(first.looseItems);
  });

  it('uses identical authoritative geometry for whole-board and select-all scopes modulo anchoring', () => {
    const zones = [
      zone('alpha', 120, 100, [item('alpha-card', 380, 160)]),
      zone('beta', 980, 120, [branchItem('beta-worktree', 500, 240)]),
      zone('gamma', 120, 820, [
        item('gamma-card', 300, 180),
        { id: 'gamma-app', width: 620, height: 380, position: { x: 420, y: 80 } },
      ]),
    ];
    const looseItems = [
      { id: 'note', x: 780, y: 760, width: 360, height: 260 },
      { id: 'artifact', x: 1220, y: 760, width: 640, height: 420 },
    ];
    const options = {
      mode: 'grid' as const,
      targetAspectRatio: 16 / 9,
      justifyRows: true,
      resizeZoneFrames: true,
      looseItems,
    };
    const whole = planBoardZoneArrangement(zones, options);
    const selected = planBoardZoneArrangement(zones, {
      ...options,
      anchorToSelectionBounds: true,
    });
    const normalized = (plan: ReturnType<typeof planBoardZoneArrangement>) => {
      const roots = [
        ...plan.zones.map((entry) => ({
          id: entry.id,
          ...entry.position,
          width: entry.width,
          height: entry.height,
        })),
        ...plan.looseItems.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
      ];
      const minX = Math.min(...roots.map((entry) => entry.x));
      const minY = Math.min(...roots.map((entry) => entry.y));
      return new Map(
        roots.map((entry) => [entry.id, { ...entry, x: entry.x - minX, y: entry.y - minY }])
      );
    };

    expect(normalized(selected)).toEqual(normalized(whole));
    expect(selected.zones.map((entry) => entry.items)).toEqual(
      whole.zones.map((entry) => entry.items)
    );
  });

  it.each([7, 8, 9, 10])(
    'lays out %i mixed roots in stable viewport-shaped Grid rows without overlap',
    (count) => {
      const looseItems = Array.from({ length: count }, (_, index) => ({
        id: `root-${index}`,
        x: (index % 4) * 520,
        y: Math.floor(index / 4) * 360,
        width: index % 3 === 0 ? 600 : index % 3 === 1 ? 380 : 260,
        height: index % 2 === 0 ? 220 : 360,
      }));
      const first = planBoardZoneArrangement([], {
        mode: 'grid',
        targetAspectRatio: 16 / 9,
        looseItems,
      });
      const second = planBoardZoneArrangement([], {
        mode: 'grid',
        targetAspectRatio: 16 / 9,
        looseItems: looseItems.map((item) => {
          const placed = first.looseItems.find((candidate) => candidate.id === item.id)!;
          return { ...item, x: placed.x, y: placed.y };
        }),
      });
      for (const [index, left] of first.looseItems.entries()) {
        for (const right of first.looseItems.slice(index + 1)) {
          expect(
            left.x + left.width <= right.x ||
              right.x + right.width <= left.x ||
              left.y + left.height <= right.y ||
              right.y + right.height <= left.y
          ).toBe(true);
        }
      }
      expect(second.looseItems).toEqual(first.looseItems);
    }
  );

  it('uses viewport aspect for row composition and exposes safe zone-frame resizing off', () => {
    const looseItems = Array.from({ length: 9 }, (_, index) => ({
      id: `item-${index}`,
      x: index * 20,
      y: index * 20,
      width: 400,
      height: 240,
    }));
    const wide = planBoardZoneArrangement([], {
      mode: 'grid',
      targetAspectRatio: 2.2,
      looseItems,
    });
    const tall = planBoardZoneArrangement([], {
      mode: 'grid',
      targetAspectRatio: 0.75,
      looseItems,
    });
    expect(wide.layout.rows).toBeLessThan(tall.layout.rows);

    const source = [
      { ...zone('small', 0, 0, [item('large-child', 760, 420)]), width: 300, height: 220 },
      { ...zone('manual', 900, 0, [item('small-child', 300, 100)]), width: 940, height: 700 },
    ];
    const preserved = planBoardZoneArrangement(source, {
      mode: 'grid',
      resizeZoneFrames: false,
    });
    expect(preserved.zones.find(({ id }) => id === 'small')?.width).toBeGreaterThan(300);
    expect(preserved.zones.find(({ id }) => id === 'manual')).toMatchObject({
      width: 940,
      height: 700,
    });
  });
});
