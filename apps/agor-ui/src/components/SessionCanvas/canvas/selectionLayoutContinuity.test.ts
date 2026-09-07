import { describe, expect, it } from 'vitest';
import {
  type SelectionLayoutContinuity,
  stableSelectionLayoutOrder,
} from './selectionLayoutContinuity';

describe('stableSelectionLayoutOrder', () => {
  const previous: SelectionLayoutContinuity = {
    key: 'a\0b\0c',
    ids: ['a', 'b', 'c'],
    before: { a: { x: 0, y: 0 }, b: { x: 800, y: 0 }, c: { x: 0, y: 800 } },
    after: { a: { x: 200, y: 200 }, b: { x: 440, y: 200 }, c: { x: 680, y: 200 } },
  };

  it('keeps stable order through a mixed stale/settled realtime snapshot', () => {
    const result = stableSelectionLayoutOrder(
      [
        { id: 'c', position: previous.after.c },
        { id: 'b', position: previous.before.b },
        { id: 'a', position: previous.after.a },
      ],
      previous
    );

    expect(result.ids).toEqual(['a', 'b', 'c']);
  });

  it('recomputes spatial order after a real move or selection membership change', () => {
    expect(
      stableSelectionLayoutOrder(
        [
          { id: 'a', position: { x: 900, y: 900 } },
          { id: 'b', position: previous.after.b },
          { id: 'c', position: previous.after.c },
        ],
        previous
      ).ids
    ).toEqual(['b', 'c', 'a']);
    expect(
      stableSelectionLayoutOrder([{ id: 'new', position: { x: 0, y: 0 } }], previous).ids
    ).toEqual(['new']);
  });
});
