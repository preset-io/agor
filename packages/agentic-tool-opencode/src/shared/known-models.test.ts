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
});

describe('OpenCode hosted provider projection', () => {
  it('projects only reviewed providers and registers every key as a redaction secret', async () => {
    const { buildOpenCodeAuthContent, hostedProviderIdsFromConnection } = await import(
      './known-models.js'
    );
    const projected = buildOpenCodeAuthContent({
      OPENCODE_API_KEY_ANTHROPIC: ' sk-ant-test ',
      OPENCODE_API_KEY_OPENAI: '',
      SOMETHING_ELSE: 'ignored',
    });
    expect(projected.providerIds).toEqual(['anthropic']);
    expect(JSON.parse(projected.content ?? '')).toEqual({
      anthropic: { type: 'api', key: 'sk-ant-test' },
    });
    expect(projected.secrets).toEqual(['sk-ant-test', projected.content]);
    expect(buildOpenCodeAuthContent({})).toEqual({
      content: undefined,
      providerIds: [],
      secrets: [],
    });
    expect([...hostedProviderIdsFromConnection({ OPENCODE_API_KEY_OPENAI: true })]).toEqual([
      'openai',
    ]);
  });

  it('keeps the hosted field map aligned with the core provider-connection fields', async () => {
    const { OPENCODE_HOSTED_PROVIDER_FIELDS } = await import('./known-models.js');
    const { PROVIDER_CONNECTION_FIELDS } = await import('@agor/core/types');
    expect([...Object.values(OPENCODE_HOSTED_PROVIDER_FIELDS)].sort()).toEqual(
      [...PROVIDER_CONNECTION_FIELDS.opencode].sort()
    );
  });

  it('derives hosted provider settings from saved-key presence without OAuth methods', async () => {
    const { createOpenCodeHostedProviderDiscovery } = await import('./known-models.js');
    const discovery = createOpenCodeHostedProviderDiscovery(new Set(['openai']));
    const openai = discovery.providers.find((provider) => provider.id === 'openai');
    const zen = discovery.providers.find((provider) => provider.id === 'opencode');
    expect(discovery.runtime).toBe('available');
    expect(openai).toMatchObject({
      credentialPresence: 'present',
      runtimeAvailable: true,
      authMethods: [{ index: 0, type: 'api', label: 'API key' }],
    });
    expect(zen).toMatchObject({
      credentialPresence: 'absent',
      runtimeAvailable: true,
      authMethods: [],
    });
    expect(
      discovery.providers.every((provider) => provider.authMethods.every((m) => m.type === 'api'))
    ).toBe(true);
    expect(discovery.suggestedSelection).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.6-terra-pro',
    });
  });
});
