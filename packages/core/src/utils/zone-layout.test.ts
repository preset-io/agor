import { describe, expect, it } from 'vitest';
import {
  planZoneGrid,
  readZoneGridOrder,
  ZONE_GRID_HEADER,
  ZONE_GRID_PADDING,
  zoneGridColumns,
  zoneGridDropIndex,
  zoneGridEntryPosition,
  zoneGridOrderKeyBetween,
  zoneGridOrderKeys,
  zoneGridWidthOnSwitch,
  zoneLayoutOf,
} from './zone-layout';

const items = (heights: number[]) => heights.map((height, i) => ({ id: `b${i}`, height }));

describe('zoneLayoutOf', () => {
  it('treats missing and unknown layouts as free', () => {
    expect(zoneLayoutOf(undefined)).toBe('free');
    expect(zoneLayoutOf({})).toBe('free');
    expect(zoneLayoutOf({ layout: 'masonry' as never })).toBe('free');
    expect(zoneLayoutOf({ layout: 'grid' })).toBe('grid');
    expect(zoneLayoutOf({ layout: 'row' })).toBe('row');
    expect(zoneLayoutOf({ layout: 'column' })).toBe('column');
  });
});

describe('zoneGridColumns', () => {
  it('fills a grid zone with the fewest columns that stay within the maximum width', () => {
    expect(zoneGridColumns('grid', 1060, 9)).toEqual({ count: 2, width: 500 });
    expect(zoneGridColumns('grid', 1600, 9)).toEqual({ count: 3, width: 506 });
    expect(zoneGridColumns('grid', 1140, 9)).toEqual({ count: 2, width: 540 });
    expect(zoneGridColumns('grid', 1200, 9)).toEqual({ count: 3, width: 373 });
  });

  it('never shows more grid columns than cards, so a few cards stretch instead', () => {
    expect(zoneGridColumns('grid', 2600, 3)).toEqual({ count: 3, width: 560 });
  });

  it('keeps at least two grid columns, at no less than the minimum width', () => {
    expect(zoneGridColumns('grid', 400)).toEqual({ count: 2, width: 320 });
    expect(planZoneGrid('grid', 400, items([100])).contentWidth).toBe(700);
  });

  it('fits a column to a narrow zone instead of widening it', () => {
    expect(zoneGridColumns('column', 370)).toEqual({ count: 1, width: 330 });
    expect(planZoneGrid('column', 370, items([100])).contentWidth).toBe(370);
    expect(zoneGridColumns('column', 1580).width).toBe(560);
  });

  it('gives a row one column per card', () => {
    expect(zoneGridColumns('row', 1060, 2)).toEqual({ count: 2, width: 500 });
    expect(zoneGridColumns('row', 400, 3)).toEqual({ count: 3, width: 320 });
  });
});

describe('planZoneGrid', () => {
  it('assigns item n to column n mod columns and stacks on the 20px grid', () => {
    const plan = planZoneGrid('grid', 1060, items([150, 300, 210]));
    expect(plan.columns.get('b0')).toBe(0);
    expect(plan.columns.get('b1')).toBe(1);
    expect(plan.columns.get('b2')).toBe(0);
    expect(plan.positions.get('b0')).toEqual({ x: ZONE_GRID_PADDING, y: ZONE_GRID_HEADER });
    expect(plan.positions.get('b1')).toEqual({ x: ZONE_GRID_PADDING + 520, y: ZONE_GRID_HEADER });
    // 80 + 150 + 20 = 250, snapped up to 260.
    expect(plan.positions.get('b2')).toEqual({ x: ZONE_GRID_PADDING, y: 260 });
    // Column 0 ends at 260 + 210 = 470; plus padding, snapped = 500.
    expect(plan.contentHeight).toBe(500);
  });

  it('moves only the items below a grown item in its own column', () => {
    const before = planZoneGrid('grid', 1060, items([150, 150, 150, 150, 150]));
    const after = planZoneGrid('grid', 1060, items([150, 260, 150, 150, 150]));
    const moved = [...before.positions.keys()].filter(
      (id) => before.positions.get(id)?.y !== after.positions.get(id)?.y
    );
    expect(moved).toEqual(['b3']);
    expect([...after.columns]).toEqual([...before.columns]);
  });

  it('is idempotent for the same input', () => {
    const input = items([180, 240, 90, 400]);
    expect(planZoneGrid('grid', 1600, input)).toEqual(planZoneGrid('grid', 1600, input));
  });

  it('stacks a column', () => {
    const plan = planZoneGrid('column', 1600, items([100, 100]));
    expect(plan.positions.get('b1')).toEqual({ x: ZONE_GRID_PADDING, y: 200 });
  });

  it('lines a row up side by side, as wide as its cards', () => {
    const plan = planZoneGrid('row', 1060, items([150, 300]));
    expect(plan.positions.get('b1')).toEqual({ x: ZONE_GRID_PADDING + 520, y: ZONE_GRID_HEADER });
    expect(plan.contentWidth).toBe(1060);
    expect(plan.contentHeight).toBe(400);
  });

  it('keeps the header and padding for an empty zone', () => {
    expect(planZoneGrid('grid', 1060, []).contentHeight).toBe(100);
  });

  it('treats unusable heights as zero', () => {
    const plan = planZoneGrid('column', 600, items([Number.NaN, -5, 100]));
    expect(plan.positions.get('b1')?.y).toBe(100);
    expect(plan.positions.get('b2')?.y).toBe(120);
  });
});

describe('readZoneGridOrder', () => {
  const ids = (list: Array<{ id: string }>) => list.map((item) => item.id);

  it('reads positions saved from a grid back in the same order', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    const plan = planZoneGrid(
      'grid',
      1060,
      order.map((id, i) => ({ id, height: [150, 300, 260, 120, 200][i] }))
    );
    const saved = order
      .map((id) => ({ id, position: plan.positions.get(id) ?? { x: 0, y: 0 } }))
      .reverse();
    expect(ids(readZoneGridOrder(1060, saved))).toEqual(order);
  });

  it('reads order keys in one column top to bottom', () => {
    const keys = zoneGridOrderKeys(['x', 'y', 'z']);
    const items = ['z', 'x', 'y'].map((id) => ({ id, position: keys.get(id) ?? { x: 0, y: 0 } }));
    expect(ids(readZoneGridOrder(1580, items))).toEqual(['x', 'y', 'z']);
  });

  it('reads free positions row by row across their nearest columns', () => {
    const ordered = readZoneGridOrder(1060, [
      { id: 'right-top', position: { x: 600, y: 40 } },
      { id: 'left-second', position: { x: 10, y: 500 } },
      { id: 'left-top', position: { x: 30, y: 90 } },
      { id: 'far-right', position: { x: 2000, y: 300 } },
    ]);
    expect(ids(ordered)).toEqual(['left-top', 'right-top', 'left-second', 'far-right']);
  });

  it('reads the same order whichever auto layout the zone switches to', () => {
    const shownAsGrid = [
      { id: 'a', position: { x: 20, y: 80 } },
      { id: 'b', position: { x: 540, y: 80 } },
      { id: 'c', position: { x: 20, y: 400 } },
      { id: 'd', position: { x: 540, y: 320 } },
    ];
    expect(ids(readZoneGridOrder(1060, shownAsGrid))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('breaks exact ties by id', () => {
    const ordered = readZoneGridOrder(600, [
      { id: 'b', position: { x: 0, y: 0 } },
      { id: 'a', position: { x: 0, y: 0 } },
    ]);
    expect(ids(ordered)).toEqual(['a', 'b']);
  });
});

describe('zoneGridEntryPosition', () => {
  it('starts below the header in an empty zone', () => {
    expect(zoneGridEntryPosition([])).toEqual({ x: ZONE_GRID_PADDING, y: ZONE_GRID_HEADER });
  });

  it('orders after every order key', () => {
    const keys = [...zoneGridOrderKeys(['s0', 's1', 's2']).entries()].map(([id, position]) => ({
      id,
      position,
    }));
    const entry = zoneGridEntryPosition(keys.map((key) => key.position));
    const ordered = readZoneGridOrder(1060, [...keys, { id: 'new', position: entry }]);
    expect(ordered.at(-1)?.id).toBe('new');
    expect(entry.y % 20).toBe(0);
  });
});

describe('zoneGridDropIndex', () => {
  const others = items([150, 150, 150, 150]);
  const dragged = { id: 'moved', height: 150 };

  it('takes the slot nearest the drop point', () => {
    // Slots in a two-column grid: 0 (20,80), 1 (540,80), 2 (20,260), 3 (540,260), 4 (20,440).
    expect(zoneGridDropIndex('grid', 1060, others, dragged, { x: 30, y: 90 })).toBe(0);
    expect(zoneGridDropIndex('grid', 1060, others, dragged, { x: 530, y: 250 })).toBe(3);
    expect(zoneGridDropIndex('grid', 1060, others, dragged, { x: 0, y: 2000 })).toBe(4);
  });

  it('reads a column top to bottom, and a row left to right', () => {
    expect(zoneGridDropIndex('column', 600, others, dragged, { x: 20, y: 270 })).toBe(1);
    expect(zoneGridDropIndex('row', 2620, others, dragged, { x: 1050, y: 80 })).toBe(2);
  });
});

describe('zoneGridOrderKeyBetween', () => {
  const key = (y: number) => ({ x: ZONE_GRID_PADDING, y });

  it('lands between, before or after one-column keys', () => {
    expect(zoneGridOrderKeyBetween(key(80), key(300))).toEqual(key(190));
    expect(zoneGridOrderKeyBetween(undefined, key(80))?.y).toBeLessThan(80);
    expect(zoneGridOrderKeyBetween(key(300), undefined)?.y).toBeGreaterThan(300);
  });

  it('asks for a full rewrite when there is no room or the keys are free positions', () => {
    expect(zoneGridOrderKeyBetween(key(80), key(81))).toBeUndefined();
    expect(zoneGridOrderKeyBetween({ x: 540, y: 80 }, key(300))).toBeUndefined();
  });
});

describe('zoneGridWidthOnSwitch', () => {
  it('gives a grid square-ish columns when its width would make a single row', () => {
    // Six cards in a 3140px zone (a row's width) would all fit side by side.
    expect(zoneGridWidthOnSwitch(3140, 6)).toBe(1580);
    expect(zoneGridWidthOnSwitch(5000, 9)).toBe(1580);
  });

  it('keeps a width that already wraps the cards, or a small zone', () => {
    expect(zoneGridWidthOnSwitch(1060, 6)).toBeUndefined();
    expect(zoneGridWidthOnSwitch(3140, 2)).toBeUndefined();
  });
});
