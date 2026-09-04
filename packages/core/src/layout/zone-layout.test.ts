import { describe, expect, it } from 'vitest';
import { BOARD_GRID_SIZE } from './rectangle-packing';
import {
  compactZoneItemSize,
  estimateExpandedGenericCardHeight,
  GENERIC_BOARD_CARD_LAYOUT,
  getZoneLayoutFrame,
  growZoneLayoutHeight,
  isBoardEntityDensityExpandable,
  justifyZoneContentCluster,
  layoutCompactTarget,
  normalizeZoneLayoutPolicy,
  resolveZoneLayoutPolicy,
  setZoneLayoutMode,
  sortZoneLayoutItems,
  type ZoneLayoutSortItem,
  zoneLayoutBinding,
  zoneLayoutSortDirectionOptions,
} from './zone-layout';

describe('grow-only zone height', () => {
  it('keeps a direct resize as the floor and still grows for larger contents', () => {
    expect(growZoneLayoutHeight(1000, 260)).toBe(1000);
    expect(growZoneLayoutHeight(1000, 1201)).toBe(1220);
    expect(growZoneLayoutHeight(120, 80)).toBe(200);
  });
});

describe('zone content justification', () => {
  const frame = getZoneLayoutFrame({ width: 620 });
  const mixed = [
    { id: 'wide', x: 100, y: 180, width: 300, height: 100 },
    { id: 'tall', x: 420, y: 180, width: 100, height: 260 },
    { id: 'small', x: 100, y: 300, width: 120, height: 80 },
  ];

  it.each([
    ['left', { left: 20, top: 180, right: 440, bottom: 440 }],
    ['right', { left: 180, top: 180, right: 600, bottom: 440 }],
    ['top', { left: 100, top: 100, right: 520, bottom: 360 }],
    ['bottom', { left: 100, top: 620, right: 520, bottom: 880 }],
    ['middle', { left: 100, top: 180, right: 520, bottom: 440 }],
    ['vertical_middle', { left: 100, top: 320, right: 520, bottom: 580 }],
  ] as const)('justifies collision-independent components to %s', (justification, expected) => {
    const result = justifyZoneContentCluster(mixed, frame, 900, justification);
    const bounds = {
      left: Math.min(...result.placements.map((item) => item.x)),
      top: Math.min(...result.placements.map((item) => item.y)),
      right: Math.max(...result.placements.map((item) => item.x + item.width)),
      bottom: Math.max(...result.placements.map((item) => item.y + item.height)),
    };
    expect(result.fits).toBe(true);
    expect(bounds).toEqual(expected);
    for (let left = 0; left < result.placements.length; left += 1) {
      for (let right = left + 1; right < result.placements.length; right += 1) {
        const a = result.placements[left];
        const b = result.placements[right];
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapX > 0 && overlapY > 0).toBe(false);
      }
    }
  });

  it('centers vertically on the zone itself without title or status bias', () => {
    const child = [{ id: 'child', x: 20, y: 100, width: 500, height: 240 }];
    const ordinary = getZoneLayoutFrame({ width: 540 });
    const prominentTitle = getZoneLayoutFrame({ width: 540, fontSize: 48, status: 'Blocked' });

    expect(prominentTitle.headerInset).toBeGreaterThan(ordinary.headerInset);
    expect(justifyZoneContentCluster(child, ordinary, 500, 'vertical_middle').placements[0].y).toBe(
      140
    );
    expect(
      justifyZoneContentCluster(child, prominentTitle, 500, 'vertical_middle').placements[0].y
    ).toBe(140);
  });

  it('centers the seeded Review rows independently without changing their vertical order', () => {
    const reviewFrame = getZoneLayoutFrame({ width: 540 });
    const review = [
      { id: 'worktree', x: 20, y: 100, width: 500, height: 240 },
      { id: 'card', x: 20, y: 380, width: 380, height: 100 },
    ];

    const centered = justifyZoneContentCluster(review, reviewFrame, 500, 'middle');
    expect(centered).toEqual({
      fits: true,
      placements: [
        { id: 'worktree', x: 20, y: 100, width: 500, height: 240 },
        { id: 'card', x: 80, y: 380, width: 380, height: 100 },
      ],
    });
    expect(justifyZoneContentCluster(centered.placements, reviewFrame, 500, 'middle')).toEqual(
      centered
    );
    expect(
      Object.fromEntries(
        justifyZoneContentCluster([...review].reverse(), reviewFrame, 500, 'middle').placements.map(
          ({ id, x, y }) => [id, { x, y }]
        )
      )
    ).toEqual(Object.fromEntries(centered.placements.map(({ id, x, y }) => [id, { x, y }])));
  });

  it('bottom-aligns collision-independent columns without moving either column on X', () => {
    const columns = [
      { id: 'tall-left', x: 20, y: 100, width: 200, height: 200 },
      { id: 'short-right', x: 300, y: 100, width: 200, height: 100 },
    ];
    expect(justifyZoneContentCluster(columns, frame, 900, 'bottom').placements).toEqual([
      { ...columns[0], y: 680 },
      { ...columns[1], y: 780 },
    ]);
  });

  it('is permutation-stable, idempotent, and preserves connected-component offsets', () => {
    const first = justifyZoneContentCluster(mixed, frame, 900, 'left');
    const second = justifyZoneContentCluster(first.placements, frame, 900, 'left');
    const permuted = justifyZoneContentCluster([...mixed].reverse(), frame, 900, 'left');
    const byId = (items: typeof mixed) =>
      Object.fromEntries(items.map(({ id, x, y }) => [id, { x, y }]));

    expect(second).toEqual(first);
    expect(byId(permuted.placements)).toEqual(byId(first.placements));
    expect(first.placements[1].x - first.placements[0].x).toBe(mixed[1].x - mixed[0].x);
    expect(first.placements.map(({ y }) => y)).toEqual(mixed.map(({ y }) => y));
  });

  it('refuses an axis that cannot fit instead of clipping or distorting the cluster', () => {
    const oversized = [{ id: 'too-wide', x: 40, y: 120, width: 700, height: 100 }];
    expect(justifyZoneContentCluster(oversized, frame, 900, 'right')).toEqual({
      fits: false,
      placements: oversized,
    });
  });
});

describe('zone layout frame', () => {
  it('gives cards and worktrees the same inset, header reserve, and usable width', () => {
    const frame = getZoneLayoutFrame({ width: 620 });
    const card = compactZoneItemSize('card', frame.usableWidth);
    const branch = compactZoneItemSize('branch', frame.usableWidth);

    expect(frame).toEqual({ width: 620, padding: 20, headerInset: 80, usableWidth: 580 });
    expect(card.width).toBe(frame.usableWidth);
    expect(branch.width).toBe(frame.usableWidth);
    expect(frame.width - frame.padding - card.width).toBe(frame.padding);
    expect(frame.width - frame.padding - branch.width).toBe(frame.padding);
  });

  it('keeps custom header reserves and the full frame on the board grid', () => {
    const frame = getZoneLayoutFrame({ width: 613, fontSize: 31, status: 'Active' });

    for (const value of Object.values(frame)) expect(value % 20).toBe(0);
    expect(frame.headerInset).toBeGreaterThan(80);
  });

  it('reserves board-space title height at the current canvas scale', () => {
    const normal = getZoneLayoutFrame({ width: 540, fontSize: 48, status: 'Active' });
    const zoomedOut = getZoneLayoutFrame(
      { width: 540, fontSize: 48, status: 'Active' },
      { fontScale: 2 }
    );

    expect(zoomedOut.headerInset).toBeGreaterThan(normal.headerInset);
    expect(zoomedOut.headerInset % BOARD_GRID_SIZE).toBe(0);
  });
});

const item = (id: string, overrides: Partial<ZoneLayoutSortItem> = {}) => ({
  id,
  position: { x: 0, y: 0 },
  ...overrides,
});

describe('normalizeZoneLayoutPolicy', () => {
  it('keeps legacy zones manual and sanitizes persisted values', () => {
    expect(normalizeZoneLayoutPolicy(undefined)).toMatchObject({
      mode: 'manual',
      preset: 'grid',
      sortBy: 'position',
      sortDirection: 'asc',
      autoResizeHeight: false,
      gap: 24,
    });
    expect(normalizeZoneLayoutPolicy({ mode: 'auto', columns: 2.9 })).toMatchObject({
      mode: 'auto',
      columns: 2,
    });
    expect(normalizeZoneLayoutPolicy({ gap: -4 })).toMatchObject({ gap: 0 });
    expect(normalizeZoneLayoutPolicy({ gap: 200 })).toMatchObject({ gap: 96 });
    expect(normalizeZoneLayoutPolicy({ preset: 'compact_list' })).toMatchObject({
      preset: 'compact_list',
      density: 'preserve',
    });
    expect(normalizeZoneLayoutPolicy({ density: 'collapse' })).toMatchObject({
      density: 'collapse',
    });
  });

  it('shares an idempotent Auto Zone transition without overwriting configured sorting', () => {
    expect(setZoneLayoutMode(undefined, 'auto')).toMatchObject({
      mode: 'auto',
      sortBy: 'updated',
      sortDirection: 'desc',
    });

    const configured = setZoneLayoutMode(
      { mode: 'manual', sortBy: 'title', sortDirection: 'desc', columns: 2, gap: 12 },
      'auto'
    );
    expect(configured).toMatchObject({
      mode: 'auto',
      sortBy: 'title',
      sortDirection: 'desc',
      columns: 2,
      gap: 12,
    });
    expect(setZoneLayoutMode(configured, 'auto')).toEqual(configured);
    expect(setZoneLayoutMode(configured, 'manual')).toEqual({ ...configured, mode: 'manual' });
  });

  it('treats legacy zones as overrides and resolves explicit inheritance through board defaults', () => {
    expect(zoneLayoutBinding({})).toBe('override');
    expect(resolveZoneLayoutPolicy({ layout: { gap: 40 } }, { gap: 4 })).toMatchObject({ gap: 40 });
    expect(
      resolveZoneLayoutPolicy({ layout_binding: 'inherit', layout: { gap: 40 } }, { gap: 4 })
    ).toMatchObject({ gap: 4 });
  });

  it('owns the direction labels used by every Configure Zone sort key', () => {
    expect(zoneLayoutSortDirectionOptions('position')).toEqual([
      { value: 'asc', label: 'Top-left first' },
      { value: 'desc', label: 'Bottom-right first' },
    ]);
    expect(zoneLayoutSortDirectionOptions('updated')).toEqual([
      { value: 'desc', label: 'Newest first' },
      { value: 'asc', label: 'Oldest first' },
    ]);
  });
});

describe('board density capability', () => {
  it('preserves the exact legacy value unless an eligible explicit policy changes it', () => {
    expect(layoutCompactTarget('preserve', undefined, true)).toBeUndefined();
    expect(layoutCompactTarget('preserve', false, true)).toBe(false);
    expect(layoutCompactTarget('preserve', true, true)).toBe(true);
    expect(layoutCompactTarget('collapse', false, true)).toBe(true);
    expect(layoutCompactTarget('expand', true, true)).toBe(false);
    expect(layoutCompactTarget('collapse', undefined, false)).toBeUndefined();
  });

  it('includes worktrees and only generic cards with a real rendered body', () => {
    expect(isBoardEntityDensityExpandable('branch')).toBe(true);
    expect(isBoardEntityDensityExpandable('card', { description: 'Details' })).toBe(true);
    expect(isBoardEntityDensityExpandable('card', { note: 'Live note' })).toBe(true);
    expect(isBoardEntityDensityExpandable('card', {})).toBe(false);
    for (const kind of ['text', 'markdown', 'app', 'artifact', 'zone'] as const) {
      expect(isBoardEntityDensityExpandable(kind), kind).toBe(false);
    }
  });

  it('caps expanded generic-card estimates at the shared scroll-body contract', () => {
    expect(estimateExpandedGenericCardHeight(undefined)).toBe(GENERIC_BOARD_CARD_LAYOUT.minHeight);

    const veryLong = estimateExpandedGenericCardHeight({
      description: 'Fictional description. '.repeat(1_000),
      note: 'Fictional status line.\n'.repeat(1_000),
    });
    expect(veryLong).toBe(
      GENERIC_BOARD_CARD_LAYOUT.headerEstimatedHeight + GENERIC_BOARD_CARD_LAYOUT.bodyMaxHeight
    );
    expect(veryLong).toBeLessThan(400);
  });
});

describe('sortZoneLayoutItems', () => {
  const sortableItems = [
    item('alpha', {
      title: 'Alpha',
      position: { x: 0, y: 0 },
      priority: 'urgent',
      status: 'active',
      updatedAt: '2026-01-02T00:00:00.000Z',
      createdAt: '2026-01-03T00:00:00.000Z',
    }),
    item('bravo', {
      title: 'Bravo',
      position: { x: 0, y: 20 },
      priority: 'low',
      status: 'done',
      updatedAt: '2026-01-03T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    item('charlie', {
      title: 'Charlie',
      position: { x: 20, y: 20 },
      priority: 'medium',
      status: 'blocked',
      updatedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-02T00:00:00.000Z',
    }),
  ];

  it.each([
    ['position', ['alpha', 'bravo', 'charlie']],
    ['priority', ['alpha', 'charlie', 'bravo']],
    ['status', ['charlie', 'alpha', 'bravo']],
    ['updated', ['charlie', 'alpha', 'bravo']],
    ['created', ['bravo', 'charlie', 'alpha']],
    ['title', ['alpha', 'bravo', 'charlie']],
  ] as const)('visibly reverses the complete deterministic %s order', (sortBy, ascending) => {
    const asc = sortZoneLayoutItems(sortableItems, { sortBy, sortDirection: 'asc' });
    const desc = sortZoneLayoutItems(sortableItems, { sortBy, sortDirection: 'desc' });

    expect(asc.map(({ id }) => id)).toEqual(ascending);
    expect(desc.map(({ id }) => id)).toEqual([...ascending].reverse());
  });

  it('sorts urgent and ranked work first while leaving missing priority last', () => {
    const result = sortZoneLayoutItems(
      [
        item('missing'),
        item('low', { priority: 'low' }),
        item('urgent', { priority: 'urgent' }),
        item('ranked', { rank: -1 }),
      ],
      { sortBy: 'priority', sortDirection: 'asc' }
    );
    expect(result.map(({ id }) => id)).toEqual(['ranked', 'urgent', 'low', 'missing']);
  });

  it('sorts latest first without pulling missing timestamps forward', () => {
    const result = sortZoneLayoutItems(
      [
        item('missing'),
        item('older', { updatedAt: '2026-01-01T00:00:00.000Z' }),
        item('newer', { updatedAt: '2026-02-01T00:00:00.000Z' }),
      ],
      { sortBy: 'updated', sortDirection: 'desc' }
    );
    expect(result.map(({ id }) => id)).toEqual(['newer', 'older', 'missing']);
  });

  it('keeps unknown workflow labels after known statuses in descending order', () => {
    const result = sortZoneLayoutItems(
      [
        item('custom', { status: 'someday' }),
        item('urgent', { status: 'urgent' }),
        item('done', { status: 'done' }),
      ],
      { sortBy: 'status', sortDirection: 'desc' }
    );
    expect(result.map(({ id }) => id)).toEqual(['done', 'urgent', 'custom']);
  });

  it('sorts every canonical branch filesystem status semantically', () => {
    const result = sortZoneLayoutItems(
      [
        item('deleted', { status: 'deleted' }),
        item('ready', { status: 'ready' }),
        item('failed', { status: 'failed' }),
        item('cleaned', { status: 'cleaned' }),
        item('creating', { status: 'creating' }),
        item('preserved', { status: 'preserved' }),
      ],
      { sortBy: 'status', sortDirection: 'asc' }
    );
    expect(result.map(({ id }) => id)).toEqual([
      'failed',
      'creating',
      'ready',
      'preserved',
      'cleaned',
      'deleted',
    ]);
  });

  it('uses spatial order for manual sorting and stable ids for ties', () => {
    const result = sortZoneLayoutItems(
      [item('c', { position: { x: 0, y: 10 } }), item('b'), item('a')],
      { sortBy: 'position', sortDirection: 'asc' }
    );
    expect(result.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });

  it('applies direction to visible and opaque tie-breakers while keeping missing values last', () => {
    const tied = [
      item('a', { title: 'Bravo', priority: 'medium' }),
      item('z', { title: 'Alpha', priority: 'medium' }),
      item('y', { title: 'Alpha', priority: 'medium' }),
      item('missing-z', { title: 'Zulu' }),
      item('missing-a', { title: 'Able' }),
    ];

    expect(
      sortZoneLayoutItems(tied, { sortBy: 'priority', sortDirection: 'asc' }).map(({ id }) => id)
    ).toEqual(['y', 'z', 'a', 'missing-a', 'missing-z']);
    expect(
      sortZoneLayoutItems(tied, { sortBy: 'priority', sortDirection: 'desc' }).map(({ id }) => id)
    ).toEqual(['a', 'z', 'y', 'missing-z', 'missing-a']);
  });
});

describe('zone resize policy', () => {
  it('reads a legacy autoResizeHeight boolean as the height mode', () => {
    const policy = normalizeZoneLayoutPolicy({ mode: 'auto', autoResizeHeight: true });
    expect(policy.resize).toBe('height');
    expect(policy.autoResizeHeight).toBe(true);
  });

  it('defaults an absent policy to fixed', () => {
    const policy = normalizeZoneLayoutPolicy(undefined);
    expect(policy.resize).toBe('fixed');
    expect(policy.autoResizeHeight).toBe(false);
    expect(policy.onOverflow).toBe('report');
  });

  it('lets an explicit resize win over the legacy boolean', () => {
    // A caller that knows about `resize` is not second-guessed by a stale
    // boolean sitting beside it in the persisted policy.
    const widened = normalizeZoneLayoutPolicy({ resize: 'both', autoResizeHeight: false });
    expect(widened.resize).toBe('both');
    const pinned = normalizeZoneLayoutPolicy({ resize: 'fixed', autoResizeHeight: true });
    expect(pinned.resize).toBe('fixed');
  });

  it('keeps the legacy boolean in step so older readers still behave', () => {
    // `autoResizeHeight` is what a reader predating `resize` looks at; it has
    // to stay true for any mode that resizes, not just the height one.
    expect(normalizeZoneLayoutPolicy({ resize: 'both' }).autoResizeHeight).toBe(true);
    expect(normalizeZoneLayoutPolicy({ resize: 'height' }).autoResizeHeight).toBe(true);
    expect(normalizeZoneLayoutPolicy({ resize: 'fixed' }).autoResizeHeight).toBe(false);
  });

  it('falls back on an unrecognised mode or strategy', () => {
    const policy = normalizeZoneLayoutPolicy({
      resize: 'enormous' as never,
      onOverflow: 'panic' as never,
    });
    expect(policy.resize).toBe('fixed');
    expect(policy.onOverflow).toBe('report');
  });

  it('round-trips a normalized policy unchanged', () => {
    const once = normalizeZoneLayoutPolicy({
      mode: 'auto',
      resize: 'both',
      onOverflow: 'reflow_board',
    });
    expect(normalizeZoneLayoutPolicy(once)).toEqual(once);
  });
});
