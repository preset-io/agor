import { describe, expect, it } from 'vitest';
import {
  REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE,
  requireActiveAgenticTool,
} from './agentic-tool-runtime';

describe('requireActiveAgenticTool', () => {
  it('returns supported runtime identifiers unchanged', () => {
    expect(requireActiveAgenticTool('claude-code')).toBe('claude-code');
    expect(requireActiveAgenticTool('codex')).toBe('codex');
  });

  it('rejects the removed runtime without mapping it to SDK Claude', () => {
    expect(() => requireActiveAgenticTool('claude-code-cli')).toThrow(
      REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE
    );
  });
});
