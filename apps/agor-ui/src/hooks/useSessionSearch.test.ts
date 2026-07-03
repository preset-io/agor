import { describe, expect, it } from 'vitest';
import { getMatchOffsets } from './useSessionSearch';

describe('getMatchOffsets', () => {
  it('returns nothing for empty or whitespace-only queries', () => {
    expect(getMatchOffsets('hello world', '')).toEqual([]);
    expect(getMatchOffsets('hello world', '   ')).toEqual([]);
    expect(getMatchOffsets('', 'hello')).toEqual([]);
  });

  it('finds every non-overlapping, case-insensitive match', () => {
    expect(getMatchOffsets('Foo foo FOO', 'foo')).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ]);
  });

  it('treats regex metacharacters in the query literally', () => {
    expect(getMatchOffsets('a.b a.b axb', 'a.b')).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it('reports offsets that slice back to the matched substring', () => {
    const text = 'the quick brown fox';
    const [start, end] = getMatchOffsets(text, 'quick')[0];
    expect(text.slice(start, end)).toBe('quick');
  });
});
