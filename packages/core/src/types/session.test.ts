/**
 * Tests for session.ts runtime behavior
 *
 * Each agent now uses its native permission modes:
 * - Claude Code: acceptEdits (auto-accept file edits)
 * - Gemini: autoEdit (native SDK mode)
 * - Codex: auto (auto-approve safe ops)
 */

import { describe, expect, it } from 'vitest';
import type { AgenticToolName } from './agentic-tool';
import { getDefaultPermissionMode } from './session';

describe('getDefaultPermissionMode', () => {
  it('returns "auto" for codex (native Codex mode)', () => {
    expect(getDefaultPermissionMode('codex')).toBe('auto');
  });

  it('returns "acceptEdits" for claude-code (native Claude mode)', () => {
    expect(getDefaultPermissionMode('claude-code')).toBe('acceptEdits');
  });

  it('returns "autoEdit" for gemini (native Gemini mode)', () => {
    expect(getDefaultPermissionMode('gemini')).toBe('autoEdit');
  });

  it('returns "autoEdit" for opencode (uses Gemini-like modes)', () => {
    expect(getDefaultPermissionMode('opencode')).toBe('autoEdit');
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

    it('claude-code uses Claude native mode', () => {
      const mode = getDefaultPermissionMode('claude-code');
      expect(mode).toBe('acceptEdits');
    });

    it('gemini uses native Gemini SDK mode', () => {
      const mode = getDefaultPermissionMode('gemini');
      expect(mode).toBe('autoEdit');
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
      const allTools: AgenticToolName[] = ['claude-code', 'codex', 'gemini', 'opencode'];
      const results: Record<string, string> = {};

      for (const tool of allTools) {
        results[tool] = getDefaultPermissionMode(tool);
      }

      // Verify expected mappings - each uses its native SDK mode
      expect(results['claude-code']).toBe('acceptEdits');
      expect(results.codex).toBe('auto');
      expect(results.gemini).toBe('autoEdit');
      expect(results.opencode).toBe('autoEdit');
    });

    it('returns valid PermissionMode values', () => {
      const allTools: AgenticToolName[] = ['claude-code', 'codex', 'gemini', 'opencode'];
      const validModes = [
        // Claude Code native modes
        'default',
        'acceptEdits',
        'bypassPermissions',
        'plan',
        'dontAsk',
        // Gemini native modes
        'autoEdit',
        'yolo',
        // Codex native modes
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
