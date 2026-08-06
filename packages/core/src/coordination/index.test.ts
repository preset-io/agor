import { describe, expect, it } from 'vitest';
import { boundedBackoffDelay, initialWorkOffset, jitterDelay } from './index';

describe('distributed work delay helpers', () => {
  it('computes deterministic symmetric jitter', () => {
    expect(jitterDelay(1_000, 0.2, 0)).toBe(800);
    expect(jitterDelay(1_000, 0.2, 0.5)).toBe(1_000);
    expect(jitterDelay(1_000, 0.2, 1)).toBe(1_200);
  });

  it('caps exponential idle backoff before jitter', () => {
    const policy = { baseDelayMs: 1_000, maxDelayMs: 2_000, jitterRatio: 0.1 };
    expect(boundedBackoffDelay(0, policy, 0.5)).toBe(1_000);
    expect(boundedBackoffDelay(1, policy, 0.5)).toBe(2_000);
    expect(boundedBackoffDelay(20, policy, 1)).toBe(2_200);
  });

  it('computes a deterministic uniform startup offset', () => {
    expect(initialWorkOffset(30_000, 0)).toBe(0);
    expect(initialWorkOffset(30_000, 0.25)).toBe(7_500);
    expect(initialWorkOffset(30_000, 1)).toBe(30_000);
  });
});
