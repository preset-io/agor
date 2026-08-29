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
        expect.objectContaining({ id: 'claude-opus-5' }),
        expect.objectContaining({ id: 'claude-sonnet-5' }),
        expect.objectContaining({ id: 'claude-haiku-4-5' }),
      ]),
    });
  });

  it('offers curated OpenCode Go models only with saved credential evidence', () => {
    const disconnected = createOpenCodeKnownModelCatalog(new Set());
    const configured = createOpenCodeKnownModelCatalog(new Set(['opencode-go']));

    expect(disconnected.providers.find(({ id }) => id === 'opencode-go')).toMatchObject({
      name: 'OpenCode Go',
      availableForSelection: false,
    });
    expect(configured.suggestedSelection).toEqual({
      providerId: 'opencode-go',
      modelId: 'gpt-5.6-luna',
    });
    expect(configured.providers.find(({ id }) => id === 'opencode-go')).toMatchObject({
      availableForSelection: true,
      suggestedModel: 'gpt-5.6-luna',
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'gpt-5.6-luna', status: 'active' }),
        expect.objectContaining({ id: 'kimi-k3' }),
        expect.objectContaining({ id: 'qwen3.8-max' }),
      ]),
    });
  });

  it('prefers a credentialed Go subscription over credentialed free Zen', () => {
    const catalog = createOpenCodeKnownModelCatalog(new Set(['opencode-go', 'opencode']));

    expect(catalog.suggestedSelection).toEqual({
      providerId: 'opencode-go',
      modelId: 'gpt-5.6-luna',
    });
  });
});
