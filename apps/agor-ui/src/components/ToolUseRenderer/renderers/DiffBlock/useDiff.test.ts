import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDiff } from './useDiff';

describe('useDiff', () => {
  it('assigns old and new line numbers to client-computed file diffs', () => {
    const { result } = renderHook(() => useDiff('alpha\nbefore\nomega\n', 'alpha\nafter\nomega\n'));

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

    const { result } = renderHook(() => useDiff(`${before.join('\n')}\n`, `${after.join('\n')}\n`));

    expect(result.current.lines.some((line) => line.content === '...')).toBe(true);
    expect(result.current.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'remove', content: 'line 10', oldLineNumber: 10 }),
        expect.objectContaining({ type: 'add', content: 'changed line', newLineNumber: 10 }),
      ])
    );
    expect(result.current.lines).toHaveLength(10);
  });
});
