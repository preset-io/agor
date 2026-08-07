import { AGENTIC_TOOL_NAMES } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  AGENTIC_TOOL_CAPABILITIES,
  AGENTIC_TOOL_DISPLAY_NAMES,
  AGENTIC_TOOL_INTEGRATIONS,
  getAgenticToolModelSelectionError,
  TOOL_API_KEY_NAMES,
} from './index.js';

describe('agentic-tool integrations', () => {
  it.each(['codex', 'opencode'] as const)(
    'exposes every Agor reasoning effort level for %s',
    (tool) => {
      expect(AGENTIC_TOOL_CAPABILITIES[tool].reasoningEffortLevels).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
    }
  );

  it('describes every canonical tool exactly once', () => {
    expect(Object.keys(AGENTIC_TOOL_INTEGRATIONS).sort()).toEqual([...AGENTIC_TOOL_NAMES].sort());
  });

  it('owns OpenCode metadata without inventing a host credential', () => {
    expect(AGENTIC_TOOL_INTEGRATIONS.opencode).toMatchObject({
      name: 'opencode',
      displayName: 'OpenCode',
      authentication: 'runtime-managed',
      sdkVersion: '@opencode-ai/sdk@1.14.33',
      unverifiedTerminationReason: 'OpenCode server-side execution termination is not verified.',
    });
    expect(TOOL_API_KEY_NAMES.opencode).toBeUndefined();
    expect(AGENTIC_TOOL_CAPABILITIES.opencode).toEqual(
      AGENTIC_TOOL_INTEGRATIONS.opencode.capabilities
    );
    expect(AGENTIC_TOOL_DISPLAY_NAMES.opencode).toBe('OpenCode');
    expect(
      getAgenticToolModelSelectionError('opencode', { provider: 'openai', model: '' })
    ).toMatch(/provider and model/i);
    expect(
      getAgenticToolModelSelectionError('opencode', { provider: 'openai', model: 'gpt-5' })
    ).toBeUndefined();
  });
});
