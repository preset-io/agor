import { AGENTIC_TOOL_NAMES } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  AGENTIC_TOOL_CAPABILITIES,
  AGENTIC_TOOL_DISPLAY_NAMES,
  AGENTIC_TOOL_INTEGRATIONS,
  TOOL_API_KEY_NAMES,
} from './index.js';

describe('agentic-tool integrations', () => {
  it('describes every canonical tool exactly once', () => {
    expect(Object.keys(AGENTIC_TOOL_INTEGRATIONS).sort()).toEqual([...AGENTIC_TOOL_NAMES].sort());
  });

  it('owns OpenCode metadata without inventing a host credential', () => {
    expect(AGENTIC_TOOL_INTEGRATIONS.opencode).toMatchObject({
      name: 'opencode',
      displayName: 'OpenCode',
      authentication: 'none',
      sdkVersion: '@opencode-ai/sdk@1.14.33',
      unverifiedTerminationReason: 'OpenCode server-side execution termination is not verified.',
    });
    expect(TOOL_API_KEY_NAMES.opencode).toBeUndefined();
    expect(AGENTIC_TOOL_CAPABILITIES.opencode).toEqual(
      AGENTIC_TOOL_INTEGRATIONS.opencode.capabilities
    );
    expect(AGENTIC_TOOL_DISPLAY_NAMES.opencode).toBe('OpenCode');
  });
});
