import { describe, expect, it } from 'vitest';
import { getContextWindowLimit, getModelPricing } from './pricing.js';

describe('getModelPricing', () => {
  it('prices Opus 5 at $5/$25 (unchanged from Opus 4.8, half of Fable 5)', () => {
    const price = getModelPricing('claude-opus-5');
    expect(price).toEqual({
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheWritePerMTok: 6.25,
      cacheReadPerMTok: 0.5,
      webSearchPerRequest: 0.01,
    });
  });

  it('resolves dated Opus 5 snapshots to the Opus 5 tier, not Opus 4.x', () => {
    // Longest-prefix match: `claude-opus-5-*` must NOT fall through to the
    // `claude-opus-4` ($15/$75) entry.
    expect(getModelPricing('claude-opus-5-20260101')?.inputPerMTok).toBe(5);
    expect(getModelPricing('claude-opus-4-8')?.inputPerMTok).toBe(15);
  });
});

describe('getContextWindowLimit', () => {
  it('treats Opus 5 as native 1M context (default and maximum, no [1m] suffix)', () => {
    expect(getContextWindowLimit('claude-opus-5')).toBe(1_000_000);
    expect(getContextWindowLimit('claude-opus-5-20260101')).toBe(1_000_000);
  });

  it('keeps the 200K default for non-native models without a [1m] suffix', () => {
    expect(getContextWindowLimit('claude-opus-4-8')).toBe(200_000);
    expect(getContextWindowLimit('claude-opus-4-8[1m]')).toBe(1_000_000);
  });
});
