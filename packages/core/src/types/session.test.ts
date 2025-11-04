/**
 * Tests for session.ts runtime behavior
 */

import { describe, expect, it } from 'vitest';
import type { AgenticToolName } from './agentic-tool';
import { getDefaultPermissionMode } from './session';

describe('getDefaultPermissionMode', () => {
  it('returns "auto" for codex', () => {
    expect(getDefaultPermissionMode('codex')).toBe('auto');
  });

  it('returns "acceptEdits" for claude-code', () => {
    expect(getDefaultPermissionMode('claude-code')).toBe('acceptEdits');
  });

  it('returns "acceptEdits" for gemini', () => {
    expect(getDefaultPermissionMode('gemini')).toBe('acceptEdits');
  });

  it('returns "acceptEdits" for any unknown tool (default case)', () => {
    // Type assertion to test default behavior with invalid input
    const unknownTool = 'unknown-tool' as AgenticToolName;
    expect(getDefaultPermissionMode(unknownTool)).toBe('acceptEdits');
  });

  describe('permission mode characteristics', () => {
    it('codex uses auto-approve safe operations mode', () => {
      // Codex-specific behavior: auto-approve safe operations, ask for dangerous ones
      const mode = getDefaultPermissionMode('codex');
      expect(mode).toBe('auto');
    });

    it('claude-code and gemini use accept edits mode', () => {
      // Claude-based tools: auto-accept file edits, prompt for other tools
      const tools: AgenticToolName[] = ['claude-code', 'gemini'];

      for (const tool of tools) {
        expect(getDefaultPermissionMode(tool)).toBe('acceptEdits');
      }
    });

    it('returns consistent values for repeated calls', () => {
      // Ensure function is deterministic
      const tool: AgenticToolName = 'claude-code';
      const first = getDefaultPermissionMode(tool);
      const second = getDefaultPermissionMode(tool);
      const third = getDefaultPermissionMode(tool);

      expect(first).toBe(second);
      expect(second).toBe(third);
    });
  });

  describe('all agentic tools coverage', () => {
    it('handles all valid AgenticToolName values', () => {
      const allTools: AgenticToolName[] = ['claude-code', 'codex', 'gemini'];
      const results: Record<string, string> = {};

      for (const tool of allTools) {
        results[tool] = getDefaultPermissionMode(tool);
      }

      // Verify expected mappings
      expect(results['claude-code']).toBe('acceptEdits');
      expect(results.codex).toBe('auto');
      expect(results.gemini).toBe('acceptEdits');
    });

    it('returns valid PermissionMode values', () => {
      const allTools: AgenticToolName[] = ['claude-code', 'codex', 'gemini'];
      const validModes = [
        'default',
        'acceptEdits',
        'bypassPermissions',
        'plan',
        'ask',
        'auto',
        'on-failure',
        'allow-all',
      ];

      for (const tool of allTools) {
        const mode = getDefaultPermissionMode(tool);
        expect(validModes).toContain(mode);
      }
    });
  });
});
