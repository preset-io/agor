import { describe, expect, it } from 'vitest';
import {
  hasCompleteOpenCodeModelConfig,
  OPENCODE_MODEL_CONFIG_PAIR_ERROR,
  resolveOpenCodeCatalogFallback,
  resolveOpenCodeModelConfig,
} from './model-configuration.js';

const now = new Date('2026-04-23T00:00:00.000Z');

describe('OpenCode model configuration', () => {
  it('owns the catalog suggestion fallback as an exact pair', () => {
    expect(
      resolveOpenCodeCatalogFallback({
        suggestedSelection: { providerId: 'openai', modelId: 'gpt-5' },
      })
    ).toEqual({ mode: 'exact', provider: 'openai', model: 'gpt-5' });
  });

  it('requires one atomic provider and model pair', () => {
    for (const source of [
      { model: 'gpt-5' },
      { provider: 'openai' },
      { provider: '   ', model: 'gpt-5' },
      { provider: 'openai', model: '   ' },
    ]) {
      expect(() => resolveOpenCodeModelConfig([source], { now })).toThrow(
        OPENCODE_MODEL_CONFIG_PAIR_ERROR
      );
    }
  });

  it('uses the first complete pair and forces exact mode', () => {
    expect(
      resolveOpenCodeModelConfig(
        [
          { mode: 'alias', provider: 'openai', model: 'gpt-5', effort: 'high' },
          { mode: 'exact', provider: 'anthropic', model: 'claude-sonnet-5' },
        ],
        { now }
      )
    ).toEqual({
      mode: 'exact',
      provider: 'openai',
      model: 'gpt-5',
      effort: 'high',
      updated_at: now.toISOString(),
    });
  });

  it('ignores model-less sources and reports an absent selection', () => {
    expect(
      resolveOpenCodeModelConfig([undefined, null, {}, { effort: 'high' }], { now })
    ).toBeUndefined();
  });

  it('validates a materialized exact pair', () => {
    expect(
      hasCompleteOpenCodeModelConfig({
        mode: 'exact',
        provider: 'openai',
        model: 'gpt-5',
      })
    ).toBe(true);
  });
});
