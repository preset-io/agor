import { describe, expect, it } from 'vitest';
import { REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE } from '../utils/agentic-tool-runtime.js';
import { resolveZoneTriggerAgent } from './zone-trigger.js';

describe('resolveZoneTriggerAgent', () => {
  it('uses Claude SDK only when the persisted preference is absent', () => {
    expect(resolveZoneTriggerAgent(undefined)).toBe('claude-code');
  });

  it.each(['cursor', 'copilot'] as const)('preserves supported tool %s', (tool) => {
    expect(resolveZoneTriggerAgent(tool)).toBe(tool);
  });

  it('rejects the removed CLI preference instead of mapping it to Claude SDK', () => {
    expect(() => resolveZoneTriggerAgent('claude-code-cli')).toThrow(
      REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE
    );
  });
});
