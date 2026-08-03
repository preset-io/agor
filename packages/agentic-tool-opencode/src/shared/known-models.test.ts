import { describe, expect, it } from 'vitest';
import { createOpenCodeKnownModelCatalog } from './known-models.js';

describe('OpenCode known model catalog', () => {
  it('prefers the first provider with saved credentials', () => {
    const catalog = createOpenCodeKnownModelCatalog(new Set(['kimi-for-coding']));

    expect(catalog.suggestedSelection).toEqual({
      providerId: 'kimi-for-coding',
      modelId: 'k3',
    });
    expect(catalog.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'kimi-for-coding', runtimeAvailable: true }),
        expect.objectContaining({ id: 'opencode', runtimeAvailable: true }),
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
      runtimeAvailable: false,
    });
  });

  it('ignores credentials for providers outside the curated registry', () => {
    const catalog = createOpenCodeKnownModelCatalog(new Set(['custom-provider']));

    expect(catalog.suggestedSelection).toEqual({
      providerId: 'opencode',
      modelId: 'big-pickle',
    });
    expect(catalog.providers.some(({ id }) => id === 'custom-provider')).toBe(false);
  });
});
