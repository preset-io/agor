import { describe, expect, it } from 'vitest';
import {
  AGENTIC_TOOL_CAPABILITIES,
  AGENTIC_TOOL_DISPLAY_NAMES,
  AGENTIC_TOOL_INTEGRATIONS,
  AGENTIC_TOOL_NAMES,
  getAgenticToolIntegration,
  getDefaultModelForTool,
  TOOL_API_KEY_NAMES,
} from './index.js';

describe('agentic-tool integration registry', () => {
  it('derives shared decisions from one integration descriptor map', () => {
    expect(Object.keys(AGENTIC_TOOL_INTEGRATIONS)).toEqual([
      'claude-code',
      'codex',
      'gemini',
      'opencode',
      'copilot',
      'cursor',
    ]);
    expect(AGENTIC_TOOL_NAMES).toEqual(Object.keys(AGENTIC_TOOL_INTEGRATIONS));
    expect(AGENTIC_TOOL_DISPLAY_NAMES.opencode).toBe('OpenCode');
    expect(AGENTIC_TOOL_CAPABILITIES.codex.supportsSessionFork).toBe(true);
    expect(TOOL_API_KEY_NAMES.opencode).toBeUndefined();
    expect(getDefaultModelForTool('opencode')).toBeUndefined();
  });

  it('returns the OpenCode-owned model policy', () => {
    const integration = getAgenticToolIntegration('opencode');
    expect(integration.configuration.missingSelectionError).toMatch(/provider and model/i);
    expect(integration.configuration.resolveSources).toBeTypeOf('function');
  });
});
