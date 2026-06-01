import { describe, expect, it } from 'vitest';
import { CopilotNormalizer, type CopilotSdkResponse } from './normalizer.js';

describe('CopilotNormalizer', () => {
  const normalizer = new CopilotNormalizer();

  it('records primaryModel when the response carries one', () => {
    const result = normalizer.normalize({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    });
    expect(result.primaryModel).toBe('claude-sonnet-4-6');
    expect(result.tokenUsage.totalTokens).toBe(30);
  });

  // Regression: previously `primaryModel: response.model` left the key
  // present with value undefined. The contract (see normalizer.interface
  // and buildAssistantMessageMetadata) is that optional keys are absent
  // when unknown — matches what exactOptionalPropertyTypes would enforce.
  it('omits primaryModel entirely when the response has no model', () => {
    const result = normalizer.normalize({
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
    });
    expect(result).not.toHaveProperty('primaryModel');
  });

  it('omits primaryModel when the response is empty', () => {
    // No usage, no model — legacy / pre-normalization row.
    const result = normalizer.normalize({} as CopilotSdkResponse);
    expect(result).not.toHaveProperty('primaryModel');
    expect(result.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('derives totalTokens from input + output when SDK total is missing', () => {
    const result = normalizer.normalize({
      model: 'gpt-4o',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(result.tokenUsage.totalTokens).toBe(150);
  });
});
