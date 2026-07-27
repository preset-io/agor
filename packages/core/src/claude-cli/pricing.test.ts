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

  it.each([
    'claude-opus-4-5',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-4-8-20260528',
    'claude-opus-5-20260101',
  ])('prices %s at the modern $5/$25 tier', (modelId) => {
    expect(getModelPricing(modelId)).toMatchObject({
      inputPerMTok: 5,
      outputPerMTok: 25,
    });
  });

  it('retains legacy pricing for Opus 4.1', () => {
    expect(getModelPricing('claude-opus-4-1')).toMatchObject({
      inputPerMTok: 15,
      outputPerMTok: 75,
    });
  });
});

describe('getContextWindowLimit', () => {
  it.each([
    'claude-opus-4-6',
    'claude-opus-4-8',
    'claude-opus-5-20260101',
    'claude-sonnet-4-6',
    'claude-fable-5',
  ])('treats %s as native 1M context', (modelId) => {
    expect(getContextWindowLimit(modelId)).toBe(1_000_000);
  });

  it('keeps the 200K default for non-native models without a [1m] suffix', () => {
    expect(getContextWindowLimit('claude-opus-4-5')).toBe(200_000);
    expect(getContextWindowLimit('claude-opus-4-5[1m]')).toBe(1_000_000);
  });
});
