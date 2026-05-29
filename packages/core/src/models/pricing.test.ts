import { describe, expect, it } from 'vitest';
import {
  computeOpenAITextCost,
  getOpenAITextModelPricing,
} from './pricing.js';

describe('getOpenAITextModelPricing', () => {
  it('uses longest-prefix matching for snapshot ids', () => {
    expect(getOpenAITextModelPricing('gpt-5.4-mini-2026-03-05')).toEqual({
      inputPerMTok: 0.75,
      cachedInputPerMTok: 0.075,
      outputPerMTok: 4.5,
    });
  });

  it('returns null for unknown models', () => {
    expect(getOpenAITextModelPricing('gpt-5.3-codex-spark')).toBeNull();
    expect(getOpenAITextModelPricing('gpt-5-codex-mini')).toBeNull();
    expect(getOpenAITextModelPricing(undefined)).toBeNull();
  });
});

describe('computeOpenAITextCost', () => {
  it('applies cached-input discounts without double-counting input tokens', () => {
    const cost = computeOpenAITextCost('gpt-5-codex', {
      inputTokens: 10_000,
      cachedInputTokens: 2_000,
      outputTokens: 500,
    });

    // (8_000 * 1.25 + 2_000 * 0.125 + 500 * 10) / 1_000_000 = 0.01525
    expect(cost).toBeCloseTo(0.01525, 10);
  });

  it('falls back to full input price when a model has no cached-input discount', () => {
    const cost = computeOpenAITextCost('gpt-5.4-pro', {
      inputTokens: 10_000,
      cachedInputTokens: 2_000,
      outputTokens: 500,
    });

    // Cached tokens bill at the full input rate for pro models.
    expect(cost).toBeCloseTo((10_000 * 30 + 500 * 180) / 1_000_000, 10);
  });

  it('clamps malformed cached-input counts to the total input', () => {
    const cost = computeOpenAITextCost('gpt-4o-mini', {
      inputTokens: 1_000,
      cachedInputTokens: 9_000,
      outputTokens: 100,
    });

    expect(cost).toBeCloseTo((1_000 * 0.075 + 100 * 0.6) / 1_000_000, 10);
  });

  it('returns undefined when pricing is unavailable', () => {
    expect(
      computeOpenAITextCost('gpt-5.3-codex-spark', {
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 100,
      })
    ).toBeUndefined();
  });
});
