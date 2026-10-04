import type { RectanglePlacement } from '@agor/core/layout/rectangle-packing';
import { describe, expect, it } from 'vitest';
import {
  renderedZoneStackHeaderHeight,
  stackExposesHeaders,
  zoneStackRevealHeight,
} from './zoneStack';

const placement = (id: string, y: number, deckDepth: number): RectanglePlacement => ({
  id,
  x: 20,
  y,
  width: 380,
  height: 120,
  row: 0,
  column: 0,
  stackIndex: 0,
  deckDepth,
});

describe('Auto Zone stack geometry', () => {
  it.each([
    { renderedHeader: 39, reveal: 40 },
    { renderedHeader: 40, reveal: 40 },
    { renderedHeader: 41, reveal: 60 },
    { renderedHeader: 61, reveal: 80 },
  ])('grid-ceils a $renderedHeader px header to $reveal px', ({ renderedHeader, reveal }) => {
    expect(zoneStackRevealHeight([renderedHeader])).toBe(reveal);
  });

  it('measures from the node edge through header chrome and action icons', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'react-flow__node';
    wrapper.dataset.id = 'card-1';
    wrapper.getBoundingClientRect = () => ({
      x: 0,
      y: 10,
      top: 10,
      left: 0,
      right: 380,
      bottom: 130,
      width: 380,
      height: 120,
      toJSON: () => ({}),
    });
    const header = document.createElement('div');
    header.dataset.zoneStackHeader = '';
    header.getBoundingClientRect = () => ({
      x: 0,
      y: 26,
      top: 26,
      left: 0,
      right: 380,
      bottom: 83,
      width: 380,
      height: 57,
      toJSON: () => ({}),
    });
    wrapper.append(header);
    document.body.append(wrapper);

    const measured = renderedZoneStackHeaderHeight(
      { id: 'card-1', position: { x: 0, y: 0 }, data: {} },
      40
    );
    expect(measured).toBe(73);
    expect(zoneStackRevealHeight([measured])).toBe(80);
    wrapper.remove();
  });

  it('keeps every title and action row inside its exposed interactive strip', () => {
    const reveal = zoneStackRevealHeight([41, 59, 38]);
    const placements = [
      placement('a', 20, 0),
      placement('b', 20 + reveal, 1),
      placement('c', 20 + reveal * 2, 2),
    ];

    expect(
      stackExposesHeaders(
        placements,
        new Map([
          ['a', 41],
          ['b', 59],
          ['c', 38],
        ])
      )
    ).toBe(true);
    expect(placements[1]!.y - placements[0]!.y).toBeLessThan(placements[0]!.height);
  });
});
