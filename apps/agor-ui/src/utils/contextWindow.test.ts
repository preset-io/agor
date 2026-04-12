import { describe, expect, it } from 'vitest';
import { getContextWindowGradient, getContextWindowPercentage } from './contextWindow';

describe('contextWindow utils', () => {
  it('clamps percentage to 100 when usage exceeds limit', () => {
    expect(getContextWindowPercentage(600_000, 100_000)).toBe(100);
  });

  it('clamps percentage to 0 for invalid values', () => {
    expect(getContextWindowPercentage(Number.NaN, 100_000)).toBe(0);
    expect(getContextWindowPercentage(1_000, 0)).toBe(0);
  });

  it('builds a bounded gradient for over-limit usage', () => {
    const gradient = getContextWindowGradient(600_000, 100_000);
    expect(gradient).toBe(
      'linear-gradient(to right, rgba(255, 77, 79, 0.12) 100%, transparent 100%)'
    );
  });
});
