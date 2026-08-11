import { describe, expect, it } from 'vitest';
import { getAgenticToolUIIntegration } from './ui.js';

describe('agentic-tool UI integrations', () => {
  it('registers package-owned OpenCode UI contributions', () => {
    const integration = getAgenticToolUIIntegration('opencode');
    expect(integration).toMatchObject({
      modelLabel: 'OpenCode LLM Provider',
      agentSelectionOption: { description: expect.stringMatching(/open-source terminal ai/i) },
    });
    expect(integration.ModelSelector).toBeTypeOf('function');
    expect(integration.ProviderSettings).toBeTypeOf('function');
    expect(integration.Readiness).toBeTypeOf('function');
    expect(integration.permissionModes).toHaveLength(3);
  });
});
