import { describe, expect, it } from 'vitest';
import { OPENCODE_VERSION } from '../shared/known-models.js';
import { HOSTED_OPENCODE_SNAPSHOT_VERSION } from './hosted-providers.generated.js';
import {
  hostedOpenCodeModelCatalog,
  hostedOpenCodeProviderDiscovery,
  isHostedOpenCodeProvider,
} from './hosted-providers.js';

describe('hosted OpenCode providers', () => {
  it('was generated from the pinned OpenCode version', () => {
    expect(HOSTED_OPENCODE_SNAPSHOT_VERSION).toBe(OPENCODE_VERSION);
  });

  it('offers single-key agentic providers and leaves out keyless, sign-in, multi-credential, local and non-agentic ones', () => {
    for (const id of ['anthropic', 'openai', 'google', 'openrouter', 'kimi-for-coding']) {
      expect(isHostedOpenCodeProvider(id)).toBe(true);
    }
    for (const id of [
      'opencode',
      'github-copilot',
      'amazon-bedrock',
      'azure',
      'lmstudio',
      'morph',
    ]) {
      expect(isHostedOpenCodeProvider(id)).toBe(false);
    }
  });

  it('makes only saved providers selectable and keeps retired saved keys removable', () => {
    const catalog = hostedOpenCodeModelCatalog(new Set(['anthropic']));
    expect(catalog.providers.find((p) => p.id === 'anthropic')?.availableForSelection).toBe(true);
    expect(catalog.providers.find((p) => p.id === 'openai')?.availableForSelection).toBe(false);
    expect(catalog.suggestedSelection?.providerId).toBe('anthropic');
    expect(hostedOpenCodeModelCatalog(new Set(['google'])).suggestedSelection).toBeUndefined();

    const discovery = hostedOpenCodeProviderDiscovery(new Set(['retired-provider']));
    expect(discovery.providers.find((p) => p.id === 'retired-provider')).toMatchObject({
      credentialPresence: 'present',
      runtimeAvailable: false,
    });
  });
});
