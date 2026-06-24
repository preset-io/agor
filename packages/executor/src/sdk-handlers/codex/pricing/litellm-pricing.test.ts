import { describe, expect, it } from 'vitest';
import { estimateCodexCostUsd, getLiteLlmPricingForModel } from './litellm-pricing.js';

describe('LiteLLM Codex pricing snapshot', () => {
  it('contains current Codex default model pricing', () => {
    const pricing = getLiteLlmPricingForModel('gpt-5.5');

    expect(pricing?.input_cost_per_token).toBeGreaterThan(0);
    expect(pricing?.output_cost_per_token).toBeGreaterThan(0);
    expect(pricing?.cache_read_input_token_cost).toBeGreaterThan(0);
  });

  it('estimates cost with cached input tokens as a subset of input tokens', () => {
    const cost = estimateCodexCostUsd({
      modelId: 'gpt-5.5',
      inputTokens: 10_000,
      cacheReadTokens: 4_000,
      outputTokens: 1_000,
    });

    // gpt-5.5 snapshot: 6k uncached input * $0.000005 +
    // 4k cached input * $0.0000005 + 1k output * $0.00003.
    expect(cost).toBeCloseTo(0.062, 8);
  });

  it('uses long-context pricing above 272k input tokens', () => {
    const cost = estimateCodexCostUsd({
      modelId: 'gpt-5.5',
      inputTokens: 300_000,
      cacheReadTokens: 100_000,
      outputTokens: 10_000,
    });

    // gpt-5.5 long-context snapshot: 200k uncached input * $0.00001 +
    // 100k cached input * $0.000001 + 10k output * $0.000045.
    expect(cost).toBeCloseTo(2.55, 8);
  });

  it('returns undefined for unknown explicit models instead of guessing', () => {
    expect(
      estimateCodexCostUsd({
        modelId: 'future-model-not-in-pricing-map',
        inputTokens: 1_000,
        outputTokens: 1_000,
      })
    ).toBeUndefined();
  });
});
