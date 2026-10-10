import type { Node } from 'reactflow';
import { describe, expect, it } from 'vitest';
import {
  consumeTrackedDragPosition,
  dedupeLayoutGuides,
  flowSnapDistanceForZoom,
  getGuideLayoutRects,
  type LayoutGuide,
  type LayoutRect,
  layoutGuideScreenStyle,
  layoutSizeReadoutScreenStyle,
  snapRectToPeers,
} from './layoutGuides';

describe('drag position handoff', () => {
  it('persists the accepted guide snap once, then cannot leak it into the next drag', () => {
    const tracked = { moving: { x: -120, y: 992 } };

    expect(consumeTrackedDragPosition('moving', { x: -120, y: 1000 }, tracked)).toEqual({
      x: -120,
      y: 992,
    });
    expect(tracked).toEqual({});
    expect(consumeTrackedDragPosition('moving', { x: 100, y: 1040 }, tracked)).toEqual({
      x: 100,
      y: 1040,
    });
  });
});

describe('snapRectToPeers', () => {
  it('snaps edges and centers with one deterministic local guide per axis', () => {
    const result = snapRectToPeers({ id: 'moving', x: 101, y: 199, width: 100, height: 50 }, [
      { id: 'z-peer', x: 0, y: 0, width: 100, height: 200 },
      { id: 'a-peer', x: 0, y: 0, width: 100, height: 200 },
    ]);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
    expect(result.guides.filter((guide) => guide.kind === 'alignment')).toEqual([
      expect.objectContaining({ orientation: 'horizontal', offset: 200, start: 0, end: 200 }),
      expect.objectContaining({ orientation: 'vertical', offset: 100, start: 0, end: 250 }),
    ]);
  });

  it('does not move when no alignment is close enough', () => {
    const result = snapRectToPeers({ id: 'moving', x: 300, y: 300, width: 100, height: 50 }, [
      { id: 'peer', x: 0, y: 0, width: 100, height: 100 },
    ]);
    expect(result).toMatchObject({ x: 300, y: 300 });
    expect(result.guides).toContainEqual(
      expect.objectContaining({
        kind: 'size',
        label: '100 × 50',
        offset: 350,
        start: 300,
        end: 400,
      })
    );
    expect(result.guides.filter((guide) => guide.kind === 'size')).toHaveLength(1);
  });

  it('draws both compared horizontal gaps with ticks metadata and one comparison id', () => {
    const result = snapRectToPeers({ id: 'moving', x: 100, y: 100, width: 100, height: 50 }, [
      { id: 'left', x: 0, y: 100, width: 76, height: 50 },
      { id: 'right', x: 224, y: 100, width: 100, height: 50 },
    ]);
    const gaps = result.guides.filter((guide) => guide.kind === 'gap');

    expect(gaps).toHaveLength(2);
    expect(gaps).toEqual([
      expect.objectContaining({
        orientation: 'horizontal',
        start: 76,
        end: 100,
        label: '24px',
      }),
      expect.objectContaining({
        orientation: 'horizontal',
        start: 200,
        end: 224,
        label: '24px',
      }),
    ]);
    expect(new Set(gaps.map((guide) => guide.comparisonId)).size).toBe(1);
  });

  it('chooses nearest competitors deterministically and emits only one vertical gap pair', () => {
    const peers = [
      { id: 'far-above', x: 100, y: 0, width: 50, height: 20 },
      { id: 'near-above', x: 100, y: 60, width: 50, height: 20 },
      { id: 'near-below', x: 100, y: 180, width: 50, height: 20 },
      { id: 'far-below', x: 100, y: 260, width: 50, height: 20 },
    ];
    const result = snapRectToPeers(
      { id: 'moving', x: 100, y: 100, width: 50, height: 60 },
      peers.reverse()
    );
    const gaps = result.guides.filter((guide) => guide.kind === 'gap');
    expect(gaps).toHaveLength(2);
    expect(gaps.map(({ start, end }) => [start, end])).toEqual([
      [80, 100],
      [160, 180],
    ]);
    expect(gaps.every((guide) => guide.label === '20px')).toBe(true);
  });
});

describe('layout guide dedupe and transforms', () => {
  it('merges same-axis near-identical alignment coordinates without stacked labels', () => {
    const guides: LayoutGuide[] = [
      {
        id: 'z',
        orientation: 'horizontal',
        offset: 100.3,
        start: 20,
        end: 60,
        kind: 'alignment',
        label: 'duplicate',
      },
      {
        id: 'a',
        orientation: 'horizontal',
        offset: 100,
        start: 0,
        end: 40,
        kind: 'alignment',
      },
    ];
    expect(dedupeLayoutGuides(guides)).toEqual([
      expect.objectContaining({ id: 'a', offset: 100, start: 0, end: 60, label: 'duplicate' }),
    ]);
  });

  it('keeps equal-gap comparison spans separate while deduping repeated measurements', () => {
    const segment: LayoutGuide = {
      id: 'first',
      orientation: 'horizontal',
      offset: 125,
      start: 0,
      end: 20,
      kind: 'gap',
      label: '20px',
      comparisonId: 'comparison',
    };
    expect(
      dedupeLayoutGuides([
        segment,
        { ...segment, id: 'duplicate', offset: 125.2 },
        { ...segment, id: 'second-span', start: 120, end: 140 },
      ])
    ).toHaveLength(2);
  });

  it('keeps snap tolerance and one-pixel line appearance stable across zoom', () => {
    expect(flowSnapDistanceForZoom(0.5)).toBe(16);
    expect(flowSnapDistanceForZoom(2)).toBe(4);
    const guide: LayoutGuide = {
      id: 'guide',
      orientation: 'horizontal',
      offset: 20,
      start: 10,
      end: 30,
      kind: 'alignment',
    };
    expect(layoutGuideScreenStyle(guide, { x: 100, y: 50, zoom: 2 })).toEqual({
      left: 120,
      top: 90,
      width: 40,
    });
  });
});

describe('compact size readout placement', () => {
  const makeGuide = (target: LayoutRect, avoid: LayoutRect[] = []): LayoutGuide => ({
    id: 'size-moving',
    orientation: 'horizontal',
    offset: target.y + target.height,
    start: target.x,
    end: target.x + target.width,
    kind: 'size',
    label: `${target.width} × ${target.height}`,
    readout: { target, avoid },
  });
  const bounds = { left: 0, top: 0, right: 500, bottom: 300 };

  it('keeps the badge below and fully outside an ordinary moving object', () => {
    const target = { id: 'moving', x: 100, y: 100, width: 100, height: 50 };
    const style = layoutSizeReadoutScreenStyle(makeGuide(target), { x: 0, y: 0, zoom: 1 }, bounds);

    expect(style).toMatchObject({ left: 120, top: 156, width: 60, height: 20 });
    expect(Number(style?.top)).toBeGreaterThan(target.y + target.height);
  });

  it('flips above instead of clipping or moving into content at the viewport bottom', () => {
    const target = { id: 'moving', x: 100, y: 270, width: 100, height: 20 };
    const style = layoutSizeReadoutScreenStyle(makeGuide(target), { x: 0, y: 0, zoom: 1 }, bounds);

    expect(Number(style?.top) + Number(style?.height)).toBeLessThan(target.y);
    expect(Number(style?.top)).toBeGreaterThanOrEqual(bounds.top + 4);
  });

  it('chooses another outside edge when a neighbour occupies the preferred side', () => {
    const target = { id: 'moving', x: 100, y: 100, width: 100, height: 50 };
    const below = { id: 'below', x: 100, y: 154, width: 100, height: 60 };
    const style = layoutSizeReadoutScreenStyle(
      makeGuide(target, [below]),
      { x: 0, y: 0, zoom: 1 },
      bounds
    );

    expect(Number(style?.top) + Number(style?.height)).toBeLessThan(target.y);
  });

  it('keeps a badge wider than a tiny zoomed-out object legible and on-canvas', () => {
    const target = { id: 'moving', x: 10, y: 10, width: 10, height: 10 };
    const style = layoutSizeReadoutScreenStyle(
      makeGuide(target),
      { x: 0, y: 0, zoom: 0.1 },
      { left: 0, top: 0, right: 100, bottom: 100 }
    );

    expect(style).toMatchObject({ left: 4, top: 8, width: 54, height: 20 });
    expect(Number(style?.top)).toBeGreaterThan((target.y + target.height) * 0.1);
  });
});

describe('getGuideLayoutRects', () => {
  it('uses every heterogeneous selectable entity as a subject and candidate', () => {
    const types = ['branchNode', 'cardNode', 'zone', 'markdown', 'appNode', 'artifactNode'];
    const nodes: Node[] = types.map((type, index) => ({
      id: type,
      type,
      position: { x: index * 120, y: 0 },
      width: 100,
      height: 80,
      data: {},
    }));
    for (const moving of nodes) {
      expect(getGuideLayoutRects(moving, nodes)?.peers).toHaveLength(types.length - 1);
    }
  });

  it('excludes hidden, locked, non-selectable, selected-group, and descendant peers', () => {
    const moving: Node = {
      id: 'zone',
      type: 'zone',
      selected: true,
      position: { x: 100, y: 100 },
      width: 200,
      height: 200,
      data: {},
    };
    const makePeer = (id: string, overrides: Partial<Node> = {}): Node => ({
      id,
      type: 'cardNode',
      position: { x: 400, y: 100 },
      width: 100,
      height: 80,
      data: {},
      ...overrides,
    });
    const eligible = makePeer('eligible');
    const nodes = [
      moving,
      eligible,
      makePeer('hidden', { hidden: true }),
      makePeer('locked', { data: { locked: true } }),
      makePeer('non-selectable', { selectable: false }),
      makePeer('selected', { selected: true }),
      makePeer('child', { parentId: 'zone' }),
    ];
    expect(getGuideLayoutRects(moving, nodes)?.peers.map((peer) => peer.id)).toEqual(['eligible']);
  });

  it('returns absolute flow geometry for a branch nested in a zone', () => {
    const zone: Node = {
      id: 'zone',
      type: 'zone',
      position: { x: 100, y: 200 },
      width: 500,
      height: 400,
      data: {},
    };
    const branch: Node = {
      id: 'branch',
      type: 'branchNode',
      parentId: 'zone',
      position: { x: 25, y: 40 },
      width: 200,
      height: 100,
      data: {},
    };
    expect(getGuideLayoutRects(branch, [zone, branch])?.moving).toEqual({
      id: 'branch',
      x: 125,
      y: 240,
      width: 200,
      height: 100,
    });
  });
});
