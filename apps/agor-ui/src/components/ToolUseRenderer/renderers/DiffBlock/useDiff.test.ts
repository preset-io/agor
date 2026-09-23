import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDiff } from './useDiff';

describe('useDiff', () => {
  it('assigns old and new line numbers to client-computed file diffs', () => {
    const { result } = renderHook(() =>
      useDiff('alpha\nbefore\nomega\n', 'alpha\nafter\nomega\n', undefined, 'full-file')
    );

    expect(result.current.hasLineNumbers).toBe(true);
    expect(result.current.lines).toMatchObject([
      { type: 'context', content: 'alpha', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'remove', content: 'before', oldLineNumber: 2 },
      { type: 'add', content: 'after', newLineNumber: 2 },
      { type: 'context', content: 'omega', oldLineNumber: 3, newLineNumber: 3 },
    ]);
  });

  it('folds distant unchanged lines while keeping the edited hunk visible', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const after = [...before];
    after[9] = 'changed line';

    const { result } = renderHook(() =>
      useDiff(`${before.join('\n')}\n`, `${after.join('\n')}\n`, undefined, 'full-file')
    );

    expect(result.current.lines.some((line) => line.content === '...')).toBe(true);
    expect(result.current.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'remove', content: 'line 10', oldLineNumber: 10 }),
        expect.objectContaining({ type: 'add', content: 'changed line', newLineNumber: 10 }),
      ])
    );
    expect(result.current.lines).toHaveLength(10);
  });

  it('does not invent file line numbers for unknown-position fragments', () => {
    const { result } = renderHook(() => useDiff('before', 'after'));

    expect(result.current.hasLineNumbers).toBe(false);
    expect(result.current.lines).toMatchObject([
      { type: 'remove', content: 'before' },
      { type: 'add', content: 'after' },
    ]);
    expect(result.current.lines[0]).not.toHaveProperty('oldLineNumber');
    expect(result.current.lines[1]).not.toHaveProperty('newLineNumber');
  });

  it('uses authoritative line numbers from structured patches', () => {
    const { result } = renderHook(() =>
      useDiff(undefined, undefined, [
        {
          oldStart: 40,
          oldLines: 1,
          newStart: 40,
          newLines: 1,
          lines: ['-before', '+after'],
        },
      ])
    );

    expect(result.current.hasLineNumbers).toBe(true);
    expect(result.current.lines).toMatchObject([
      { type: 'remove', oldLineNumber: 40 },
      { type: 'add', newLineNumber: 40 },
    ]);
  });

  it('returns a limited result when a raw diff exceeds its edit budget', () => {
    const before = Array.from({ length: 1001 }, (_, index) => `before ${index}`).join('\n');
    const after = Array.from({ length: 1001 }, (_, index) => `after ${index}`).join('\n');
    const { result } = renderHook(() => useDiff(before, after, undefined, 'full-file'));

    expect(result.current).toMatchObject({
      limited: true,
      lines: [],
      totalLines: 0,
    });
  });

  it('limits high-line-count input before expanding it into render rows', () => {
    const before = `${'same\n'.repeat(20000)}before`;
    const after = `${'same\n'.repeat(20000)}after`;
    const { result } = renderHook(() => useDiff(before, after, undefined, 'full-file'));

    expect(result.current.limited).toBe(true);
    expect(result.current.lines).toEqual([]);
  });

  it('recognizes identical content without applying the complexity fallback', () => {
    const content = 'same\n'.repeat(20000);
    const { result } = renderHook(() => useDiff(content, content, undefined, 'full-file'));

    expect(result.current).toMatchObject({ limited: false, lines: [], totalLines: 0 });
  });

  it('skips word-level diffing for oversized paired lines', () => {
    const before = `before ${'a'.repeat(5000)}`;
    const after = `after ${'b'.repeat(5000)}`;
    const { result } = renderHook(() => useDiff(before, after, undefined, 'full-file'));

    expect(result.current.limited).toBe(false);
    expect(result.current.lines).toHaveLength(2);
    expect(result.current.lines.every((line) => line.wordSegments === undefined)).toBe(true);
  });
});
