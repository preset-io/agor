import { describe, expect, it } from 'vitest';
import { dealDelayMs, dealOrderIndex, dealStyle, dealTiming } from './arrangeAnimation';

describe('dealTiming', () => {
  it('staggers a small deal at the maximum step', () => {
    const timing = dealTiming({ count: 4 });
    expect(timing.stepMs).toBe(45);
    // Four cards leave a beat apart and the last still lands promptly.
    expect(timing.totalMs).toBe(Math.round(45 * 3 + 380));
  });

  it('keeps a large deal inside roughly the same wall clock', () => {
    // The point of a budget: 60 items must not take 60 x the per-item delay.
    const small = dealTiming({ count: 6 });
    const large = dealTiming({ count: 60 });
    expect(large.stepMs).toBeLessThan(small.stepMs);
    expect(large.totalMs).toBeLessThan(small.totalMs + 500);
  });

  it('never steps below the floor, so a huge deal still reads as a stagger', () => {
    const timing = dealTiming({ count: 5000 });
    expect(timing.stepMs).toBeGreaterThanOrEqual(8);
  });

  it('collapses entirely under reduced motion', () => {
    // Shortening is not enough; the motion itself is the accessibility issue.
    expect(dealTiming({ count: 20, reducedMotion: true })).toEqual({
      stepMs: 0,
      durationMs: 0,
      totalMs: 0,
    });
  });

  it('does not stagger a single item against itself', () => {
    const timing = dealTiming({ count: 1 });
    expect(timing.stepMs).toBe(0);
    expect(timing.totalMs).toBe(380);
  });

  it('handles an empty deal', () => {
    expect(dealTiming({ count: 0 }).totalMs).toBe(0);
  });

  it('falls back on nonsense inputs rather than producing NaN timings', () => {
    const timing = dealTiming({
      count: 5,
      staggerBudgetMs: Number.NaN,
      durationMs: Number.NaN,
    });
    expect(Number.isFinite(timing.stepMs)).toBe(true);
    expect(Number.isFinite(timing.totalMs)).toBe(true);
  });
});

describe('dealDelayMs', () => {
  it('gives the first item no delay and later items progressively more', () => {
    const timing = dealTiming({ count: 3 });
    expect(dealDelayMs(0, timing)).toBe(0);
    expect(dealDelayMs(1, timing)).toBeGreaterThan(0);
    expect(dealDelayMs(2, timing)).toBeGreaterThan(dealDelayMs(1, timing));
  });

  it('treats a negative or non-finite index as immediate', () => {
    const timing = dealTiming({ count: 3 });
    expect(dealDelayMs(-2, timing)).toBe(0);
    expect(dealDelayMs(Number.NaN, timing)).toBe(0);
  });
});

describe('dealOrderIndex', () => {
  it('deals in reading order, rows before columns', () => {
    expect(dealOrderIndex({ row: 0, column: 0 }, 3)).toBe(0);
    expect(dealOrderIndex({ row: 0, column: 2 }, 3)).toBe(2);
    // Second row starts after the whole first row, which is what makes the
    // eye follow one line at a time instead of seeing scatter.
    expect(dealOrderIndex({ row: 1, column: 0 }, 3)).toBe(3);
  });

  it('survives a zero column count', () => {
    expect(dealOrderIndex({ row: 2, column: 0 }, 0)).toBe(2);
  });
});

describe('dealStyle', () => {
  it('exposes the delay and duration as custom properties', () => {
    const timing = dealTiming({ count: 2 });
    expect(dealStyle(90, timing)).toEqual({
      '--agor-deal-delay': '90ms',
      '--agor-deal-duration': '380ms',
    });
  });
});
