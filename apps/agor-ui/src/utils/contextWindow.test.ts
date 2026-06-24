import { describe, expect, it } from 'vitest';
import {
  getContextWindowGradient,
  getContextWindowPercentage,
  resolveContextWindowPercentage,
} from './contextWindow';

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

  it('does not build a gradient when context usage is unavailable despite a known limit', () => {
    expect(getContextWindowGradient(undefined, 1_000_000)).toBeUndefined();
    expect(getContextWindowGradient(0, 1_000_000)).toBeUndefined();
  });

  it('prefers the snapshot percentage over raw used/limit when provided', () => {
    // Authoritative snapshot says 0% (e.g. Codex baseline-adjusted) — must
    // win over the raw 50% the ratio would produce.
    expect(
      resolveContextWindowPercentage(50_000, 100_000, {
        totalTokens: 50_000,
        maxTokens: 100_000,
        percentage: 0,
      })
    ).toBe(0);
  });

  it('keeps the gradient in lockstep with the snapshot percentage', () => {
    const gradient = getContextWindowGradient(50_000, 100_000, {
      totalTokens: 50_000,
      maxTokens: 100_000,
      percentage: 0,
    });
    // Green (0% bucket), 0% fill
    expect(gradient).toBe('linear-gradient(to right, rgba(82, 196, 26, 0.12) 0%, transparent 0%)');
  });
});
