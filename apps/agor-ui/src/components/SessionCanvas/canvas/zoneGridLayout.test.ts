import type { Node } from 'reactflow';
import { describe, expect, it } from 'vitest';
import { applyZoneGridLayouts, type MeasuredNodeSize } from './zoneGridLayout';

const zone = (id: string, layout: string | undefined, width = 1060, height = 300): Node => ({
  id,
  type: 'zone',
  position: { x: 1000, y: 1000 },
  width,
  height,
  style: { width, height },
  data: { width, height, layout },
});

const branch = (id: string, parentId: string, position = { x: 0, y: 0 }): Node => ({
  id,
  type: 'branchNode',
  parentId,
  position,
  zIndex: 500,
  data: {},
});

const layout = (
  nodes: Node[],
  sizes: Record<string, MeasuredNodeSize> = {},
  stored: Record<string, { x: number; y: number }> = {}
) =>
  applyZoneGridLayouts(nodes, {
    measuredSizes: new Map(Object.entries(sizes)),
    storedPositionOf: (id) => stored[id],
  });

const byId = (nodes: Node[]) => new Map(nodes.map((node) => [node.id, node]));

describe('applyZoneGridLayouts', () => {
  it('leaves free zones and their cards untouched', () => {
    const nodes = [zone('zone-1', undefined), branch('b1', 'zone-1', { x: 7, y: 9 })];
    expect(layout(nodes, { b1: { width: 500, height: 300 } })).toBe(nodes);
  });

  it('places cards in stored order, in fixed columns, from measured heights', () => {
    const nodes = [
      zone('zone-1', 'grid'),
      branch('a', 'zone-1'),
      branch('b', 'zone-1'),
      branch('c', 'zone-1'),
    ];
    const result = byId(
      layout(
        nodes,
        {
          a: { width: 500, height: 150 },
          b: { width: 500, height: 300 },
          c: { width: 500, height: 210 },
        },
        { a: { x: 20, y: 80 }, b: { x: 540, y: 80 }, c: { x: 20, y: 400 } }
      )
    );
    expect(result.get('a')?.position).toEqual({ x: 20, y: 80 });
    expect(result.get('b')?.position).toEqual({ x: 540, y: 80 });
    expect(result.get('c')?.position).toEqual({ x: 20, y: 260 });
  });

  it('fits the zone height to its cards, growing and shrinking', () => {
    const tall = layout([zone('zone-1', 'column', 600, 200), branch('a', 'zone-1')], {
      a: { width: 500, height: 400 },
    });
    expect(byId(tall).get('zone-1')?.style?.height).toBe(500);

    const roomy = layout([zone('zone-1', 'column', 600, 900), branch('a', 'zone-1')], {
      a: { width: 500, height: 100 },
    });
    expect(byId(roomy).get('zone-1')?.style?.height).toBe(200);
  });

  it('fits a row zone to its cards side by side, stretched up to the maximum width', () => {
    const result = byId(
      layout([zone('zone-1', 'row', 2000), branch('a', 'zone-1'), branch('b', 'zone-1')], {
        a: { width: 560, height: 150 },
        b: { width: 560, height: 300 },
      })
    );
    expect(result.get('zone-1')?.style).toMatchObject({ width: 1180, height: 400 });
    expect(result.get('b')?.position).toEqual({ x: 600, y: 80 });
  });

  it('narrows cards to fit two grid columns, and widens the zone only below the minimum', () => {
    const sizes = { a: { width: 450, height: 150 }, b: { width: 450, height: 150 } };
    const fitted = byId(
      layout([zone('zone-1', 'grid', 960), branch('a', 'zone-1'), branch('b', 'zone-1')], sizes)
    );
    expect(fitted.get('zone-1')?.style?.width).toBe(960);
    expect(fitted.get('b')?.position.x).toBe(490);
    expect(fitted.get('b')?.data.slotWidth).toBe(450);

    const narrow = byId(
      layout([zone('zone-1', 'grid', 500), branch('a', 'zone-1'), branch('b', 'zone-1')], sizes)
    );
    expect(narrow.get('zone-1')?.style?.width).toBe(700);
  });

  it("follows the zone's saved order, with cards it hasn't listed last", () => {
    const listed = zone('zone-1', 'column', 600);
    listed.data.order = ['c', 'a'];
    const result = byId(
      layout([listed, branch('a', 'zone-1'), branch('b', 'zone-1'), branch('c', 'zone-1')], {
        a: { width: 560, height: 100 },
        b: { width: 560, height: 100 },
        c: { width: 560, height: 100 },
      })
    );
    expect(['c', 'a', 'b'].map((id) => result.get(id)?.position.y)).toEqual([80, 200, 320]);
  });

  it('returns the same array once laid out, so setNodes cannot loop', () => {
    const sizes = { a: { width: 500, height: 150 } };
    const once = layout([zone('zone-1', 'grid'), branch('a', 'zone-1')], sizes);
    expect(layout(once, sizes)).toBe(once);
  });

  it('floats a card widened for a session peek above its neighbor', () => {
    const result = layout([zone('zone-1', 'grid'), branch('a', 'zone-1')], {
      a: { width: 880, height: 300 },
    });
    expect(byId(result).get('a')?.zIndex).toBe(501);
  });

  it('ignores nodes whose parent is not an auto zone', () => {
    const nodes = [zone('zone-1', 'grid'), branch('loose', 'zone-2', { x: 3, y: 4 })];
    expect(byId(layout(nodes)).get('loose')?.position).toEqual({ x: 3, y: 4 });
  });
});
