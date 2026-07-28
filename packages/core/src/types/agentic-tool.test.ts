import { describe, expect, it } from 'vitest';
import {
  AGENTIC_TOOL_NAMES,
  isAgenticToolName,
  isLegacyAgenticToolName,
  LEGACY_AGENTIC_TOOL_NAMES,
} from './agentic-tool';

describe('agentic tool runtime identifiers', () => {
  it('excludes removed identifiers from active runtime options', () => {
    expect(AGENTIC_TOOL_NAMES).not.toContain('claude-code-cli');
    expect(isAgenticToolName('claude-code-cli')).toBe(false);
  });

  it('recognizes the removed identifier only as historical metadata', () => {
    expect(LEGACY_AGENTIC_TOOL_NAMES).toEqual(['claude-code-cli']);
    expect(isLegacyAgenticToolName('claude-code-cli')).toBe(true);
    expect(isLegacyAgenticToolName('claude-code')).toBe(false);
  });
});
