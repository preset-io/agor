import type { SDKResultMessage } from '@agor/core/sdk';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeNormalizer } from './normalizer.js';

const topLevelUsage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

describe('ClaudeCodeNormalizer context-window precedence', () => {
  it.each([
    ['claude-opus-4-8', 200_000],
    ['claude-opus-4-8[1m]', 1_000_000],
    ['claude-opus-5', 200_000],
    ['claude-opus-5[1m]', 1_000_000],
  ] as const)('uses the selected %s registry capacity for legacy result shapes', (model, limit) => {
    const normalized = new ClaudeCodeNormalizer().normalize(
      { type: 'result', usage: topLevelUsage } as SDKResultMessage,
      { modelHint: model }
    );

    expect(normalized.contextWindowLimit).toBe(limit);
  });

  it('prefers runtime-reported model usage over registry metadata', () => {
    const normalized = new ClaudeCodeNormalizer().normalize(
      {
        type: 'result',
        modelUsage: {
          'runtime-routed-model': {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: 777_000,
          },
        },
      } as unknown as SDKResultMessage,
      { modelHint: 'claude-opus-4-8' }
    );

    expect(normalized.contextWindowLimit).toBe(777_000);
  });

  it('leaves unknown exact models without a guessed denominator', () => {
    const normalized = new ClaudeCodeNormalizer().normalize(
      { type: 'result', usage: topLevelUsage } as SDKResultMessage,
      { modelHint: 'private-account-model' }
    );

    expect(normalized.contextWindowLimit).toBe(0);
  });
});
