import { describe, expect, it } from 'vitest';
import { getAgenticToolUIIntegration, getAgenticToolUIIntegrations } from './ui.js';

describe('agentic-tool UI registry', () => {
  it('projects OpenCode-owned presentation and behavior through generic slots', () => {
    const integration = getAgenticToolUIIntegration('opencode');

    expect(integration).toMatchObject({
      modelLabel: 'OpenCode LLM Provider',
      onboardingOption: {
        title: 'Multiple providers',
      },
    });
    expect(integration?.ModelSelector).toBeTypeOf('function');
    expect(integration?.ProviderSettings).toBeTypeOf('function');
    expect(integration?.permissionModes?.map(({ mode }) => mode)).toEqual([
      'default',
      'autoEdit',
      'yolo',
    ]);
    expect(getAgenticToolUIIntegrations().map(([tool]) => tool)).toContain('opencode');
  });
});
