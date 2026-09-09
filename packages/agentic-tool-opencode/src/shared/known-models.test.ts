import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createOpenCodeKnownModelCatalog, OPENCODE_VERSION } from './known-models.js';

describe('OpenCode known model catalog', () => {
  it('stays versioned with the packaged native runtime and SDK', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { devDependencies: Record<string, string> };

    expect(manifest.devDependencies['@opencode-ai/sdk']).toBe(OPENCODE_VERSION);
  });

  it('prefers the first provider with saved credentials', () => {
    const catalog = createOpenCodeKnownModelCatalog(new Set(['kimi-for-coding']));

    expect(catalog.suggestedSelection).toEqual({
      providerId: 'kimi-for-coding',
      modelId: 'k3',
    });
    expect(catalog.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'kimi-for-coding', availableForSelection: true }),
        expect.objectContaining({ id: 'opencode', availableForSelection: true }),
      ])
    );
  });

  it('falls back to the credentialless OpenCode Zen default', () => {
    const catalog = createOpenCodeKnownModelCatalog(new Set());

    expect(catalog.suggestedSelection).toEqual({
      providerId: 'opencode',
      modelId: 'big-pickle',
    });
    expect(catalog.providers.find(({ id }) => id === 'kimi-for-coding')).toMatchObject({
      availableForSelection: false,
    });
  });

  it('keeps configured providers outside the curated registry available for exact entry', () => {
    const catalog = createOpenCodeKnownModelCatalog(new Set(['custom-provider']));

    expect(catalog.suggestedSelection).toEqual({
      providerId: 'opencode',
      modelId: 'big-pickle',
    });
    expect(catalog.providers.find(({ id }) => id === 'custom-provider')).toEqual({
      id: 'custom-provider',
      name: 'custom-provider',
      availableForSelection: true,
      models: [],
    });
  });

  it('offers OpenAI models only when OpenAI has saved credential evidence', () => {
    const disconnected = createOpenCodeKnownModelCatalog(new Set());
    const configured = createOpenCodeKnownModelCatalog(new Set(['openai']));

    expect(disconnected.providers.find(({ id }) => id === 'openai')).toMatchObject({
      availableForSelection: false,
    });
    expect(configured.providers.find(({ id }) => id === 'openai')).toMatchObject({
      availableForSelection: true,
      suggestedModel: 'gpt-5.6-terra-pro',
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'gpt-5.6-luna' }),
        expect.objectContaining({ id: 'gpt-5.6-terra-pro' }),
      ]),
    });
  });

  it('offers curated Anthropic models only with saved credential evidence', () => {
    const disconnected = createOpenCodeKnownModelCatalog(new Set());
    const configured = createOpenCodeKnownModelCatalog(new Set(['anthropic']));

    expect(disconnected.providers.find(({ id }) => id === 'anthropic')).toMatchObject({
      availableForSelection: false,
    });
    expect(configured.suggestedSelection).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5',
    });
    expect(configured.providers.find(({ id }) => id === 'anthropic')).toMatchObject({
      name: 'Anthropic',
      availableForSelection: true,
      suggestedModel: 'claude-sonnet-5',
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'claude-fable-5-1' }),
        expect.objectContaining({ id: 'claude-opus-5' }),
        expect.objectContaining({ id: 'claude-sonnet-5' }),
        expect.objectContaining({ id: 'claude-haiku-4-5' }),
      ]),
    });
  });

  it('pins OpenCode Go model effort metadata to the packaged runtime', () => {
    const disconnected = createOpenCodeKnownModelCatalog(new Set());
    const configured = createOpenCodeKnownModelCatalog(new Set(['opencode-go']));
    const provider = configured.providers.find(({ id }) => id === 'opencode-go');

    expect(disconnected.providers.find(({ id }) => id === 'opencode-go')).toMatchObject({
      availableForSelection: false,
    });
    expect(configured.suggestedSelection).toEqual({
      providerId: 'opencode-go',
      modelId: 'gpt-5.6-luna',
    });
    expect(provider?.models).toHaveLength(25);
    expect(provider?.models.find(({ id }) => id === 'gpt-5.6-luna')).toMatchObject({
      reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh'],
    });
    expect(provider?.models.find(({ id }) => id === 'deepseek-v4-pro')).toMatchObject({
      reasoningEffortLevels: ['low', 'medium', 'high', 'max'],
    });
    expect(provider?.models.find(({ id }) => id === 'qwen3.8-flash')).toMatchObject({
      reasoningEffortLevels: [],
    });
    expect(
      Object.fromEntries(
        Object.entries(
          Object.groupBy(
            provider?.models ?? [],
            (model) => model.reasoningEffortLevels?.join(',') || 'none'
          )
        ).map(([levels, models]) => [levels, models?.map(({ id }) => id)])
      )
    ).toEqual({
      'low,medium,high,xhigh': ['gpt-5.6-luna', 'muse-spark-1.2-contributor'],
      'low,medium,high,max': [
        'deepseek-v4-flash',
        'deepseek-v4-flash-vision-exp',
        'deepseek-v4-pro',
      ],
      'low,medium,high': ['hy3', 'hy4-preview', 'longcat-2.0', 'mimo-v2.5', 'mimo-v2.5-pro'],
      none: [
        'glm-5.1',
        'glm-5.2',
        'glm-5.3',
        'glm-5.3-flash',
        'grok-4.6',
        'kimi-k2.6',
        'kimi-k2.7-code',
        'kimi-k3',
        'minimax-m2.7',
        'minimax-m3',
        'qwen3.6-plus',
        'qwen3.7-max',
        'qwen3.7-plus',
        'qwen3.8-flash',
        'qwen3.8-max',
      ],
    });
  });
});
