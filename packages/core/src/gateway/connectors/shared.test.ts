import { describe, expect, it } from 'vitest';
import { addToRingBuffer, escapeRegex } from './shared';

describe('escapeRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
    expect(escapeRegex('(x)[y]{z}')).toBe('\\(x\\)\\[y\\]\\{z\\}');
  });

  it('leaves plain text untouched', () => {
    expect(escapeRegex('agorithm')).toBe('agorithm');
  });

  it('produces a pattern that matches the literal string', () => {
    const literal = 'team:"Back end" (v2)';
    expect(new RegExp(escapeRegex(literal)).test(literal)).toBe(true);
  });
});

describe('addToRingBuffer', () => {
  it('adds ids', () => {
    const set = new Set<number>();
    addToRingBuffer(set, 1);
    addToRingBuffer(set, 2);
    expect([...set]).toEqual([1, 2]);
  });

  it('evicts the oldest entries past maxSize', () => {
    const set = new Set<number>();
    for (let i = 0; i < 5; i++) addToRingBuffer(set, i, 3);
    // Oldest (0, 1) evicted; newest 3 retained in insertion order.
    expect([...set]).toEqual([2, 3, 4]);
    expect(set.size).toBe(3);
  });

  it('does not duplicate existing ids', () => {
    const set = new Set<number>();
    addToRingBuffer(set, 7);
    addToRingBuffer(set, 7);
    expect([...set]).toEqual([7]);
  });
});
