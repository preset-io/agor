import { describe, expect, it } from 'vitest';
import { planZoneGrowthReflow, type ZoneGrowthRect } from './zone-growth-reflow';

const zone = (id: string, x: number, y: number, width = 300, height = 200): ZoneGrowthRect => ({
  id,
  x,
  y,
  width,
  height,
});

describe('planZoneGrowthReflow', () => {
  it('pushes only newly covered zones down by the minimum grid-aligned distance', () => {
    const zones = [zone('grow', 0, 0), zone('near', 0, 240), zone('side', 400, 240)];
    const plan = planZoneGrowthReflow(zones, 'grow', zone('grow', 0, 0, 300, 360));

    expect(plan.movedZoneIds).toEqual(['near']);
    expect(plan.placements).toEqual([
      zone('grow', 0, 0, 300, 360),
      zone('near', 0, 380),
      zone('side', 400, 240),
    ]);
  });

  it('cascades without moving unaffected zones or changing logical order', () => {
    const zones = [
      zone('grow', 0, 0),
      zone('first', 0, 240),
      zone('second', 0, 460),
      zone('far', 500, 100),
    ];
    const plan = planZoneGrowthReflow(zones, 'grow', zone('grow', 0, 0, 300, 400));

    expect(plan.movedZoneIds).toEqual(['first', 'second']);
    expect(plan.placements).toEqual([
      zone('grow', 0, 0, 300, 400),
      zone('first', 0, 420),
      zone('second', 0, 640),
      zone('far', 500, 100),
    ]);
  });

  it('chooses the smaller right/down displacement when both edges grow', () => {
    const zones = [zone('grow', 0, 0), zone('blocked', 260, 280, 200, 200)];
    const plan = planZoneGrowthReflow(zones, 'grow', zone('grow', 0, 0, 360, 360));
    expect(plan.placements[1]).toEqual(zone('blocked', 260, 380, 200, 200));
  });

  it('preserves overlaps that predate the grow', () => {
    const zones = [zone('grow', 0, 0), zone('already-overlapping', 260, 100, 200, 200)];
    const plan = planZoneGrowthReflow(zones, 'grow', zone('grow', 0, 0, 360, 300));
    expect(plan.movedZoneIds).toEqual([]);
    expect(plan.placements[1]).toEqual(zones[1]);
  });

  it('is deterministic, permutation-stable by id, and idempotent after persistence', () => {
    const zones = [zone('grow', 0, 0), zone('a', 0, 240), zone('b', 0, 460)];
    const next = zone('grow', 0, 0, 300, 400);
    const first = planZoneGrowthReflow(zones, 'grow', next);
    const permuted = planZoneGrowthReflow([...zones].reverse(), 'grow', next);
    const byId = (items: readonly ZoneGrowthRect[]) =>
      Object.fromEntries(items.map(({ id, x, y }) => [id, { x, y }]));

    expect(byId(permuted.placements)).toEqual(byId(first.placements));
    expect(planZoneGrowthReflow(first.placements, 'grow', next).movedZoneIds).toEqual([]);
  });

  it('cascades through heterogeneous top-level roots while preserving locked obstacles', () => {
    const roots = [
      zone('grow', 0, 0),
      zone('note', 0, 240, 300, 180),
      zone('app', 0, 440, 300, 260),
      { ...zone('locked-artifact', 520, 40, 300, 300), locked: true },
    ];
    const plan = planZoneGrowthReflow(roots, 'grow', zone('grow', 0, 0, 300, 380));

    expect(plan.movedZoneIds).toEqual(['note', 'app']);
    expect(plan.placements.find(({ id }) => id === 'locked-artifact')).toEqual(roots[3]);
    expect(plan.placements.find(({ id }) => id === 'note')?.y).toBe(400);
    expect(plan.placements.find(({ id }) => id === 'app')?.y).toBe(600);
  });

  it('minimally repositions the growing zone rather than covering a locked obstacle', () => {
    const roots = [zone('grow', 0, 0), { ...zone('locked', 320, 0, 300, 300), locked: true }];
    const plan = planZoneGrowthReflow(roots, 'grow', zone('grow', 0, 0, 360, 300));
    const grown = plan.placements.find(({ id }) => id === 'grow')!;
    const locked = plan.placements.find(({ id }) => id === 'locked')!;

    expect(plan.movedZoneIds).toEqual(['grow']);
    expect(grown.x + grown.width).toBeLessThanOrEqual(locked.x - 20);
    expect(locked).toEqual(roots[1]);
  });

  it('routes a displaced peer around a locked obstacle during a cascade', () => {
    const roots = [
      zone('grow', 0, 0),
      zone('peer', 320, 0, 300, 300),
      { ...zone('locked', 640, 0, 300, 300), locked: true },
    ];
    const plan = planZoneGrowthReflow(roots, 'grow', zone('grow', 0, 0, 360, 300));
    const grown = plan.placements.find(({ id }) => id === 'grow')!;
    const peer = plan.placements.find(({ id }) => id === 'peer')!;
    const locked = plan.placements.find(({ id }) => id === 'locked')!;

    expect(plan.movedZoneIds).toEqual(['peer']);
    expect(peer.y).toBeGreaterThan(grown.y + grown.height);
    expect(peer.y).toBeGreaterThan(locked.y + locked.height);
    expect(locked).toEqual(roots[2]);
  });
});
