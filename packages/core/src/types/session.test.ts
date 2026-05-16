/**
 * Tests for session.ts runtime behavior
 *
 * Defaults are tuned for Agor's MCP-heavy model — the environment-level
 * sandbox is the defense, not per-call prompts:
 * - Claude Code: bypassPermissions (no per-call prompts)
 * - Codex: allow-all (maps to sandbox workspace-write + approval never)
 * - Gemini: autoEdit (unchanged — pending separate audit)
 * - OpenCode: autoEdit (unchanged — pending separate audit)
 */

import { describe, expect, it } from 'vitest';
import type { AgenticToolName } from './agentic-tool';
import { getDefaultPermissionMode } from './session';

describe('getDefaultPermissionMode', () => {
  it('returns "allow-all" for codex (Agor MCP-heavy default)', () => {
    expect(getDefaultPermissionMode('codex')).toBe('allow-all');
  });

  it('returns "bypassPermissions" for claude-code (Agor MCP-heavy default)', () => {
    expect(getDefaultPermissionMode('claude-code')).toBe('bypassPermissions');
  });

  it('returns "autoEdit" for gemini (native Gemini mode)', () => {
    expect(getDefaultPermissionMode('gemini')).toBe('autoEdit');
  });

  it('returns "autoEdit" for opencode (uses Gemini-like modes)', () => {
    expect(getDefaultPermissionMode('opencode')).toBe('autoEdit');
  });

  it('returns "bypassPermissions" for any unknown tool (default case)', () => {
    // Type assertion to test default behavior with invalid input
    const unknownTool = 'unknown-tool' as AgenticToolName;
    expect(getDefaultPermissionMode(unknownTool)).toBe('bypassPermissions');
  });

  describe('permission mode characteristics', () => {
    it('codex maps to sandbox workspace-write + approval never', () => {
      const mode = getDefaultPermissionMode('codex');
      expect(mode).toBe('allow-all');
    });

    it('claude-code uses bypass mode for MCP-heavy sessions', () => {
      const mode = getDefaultPermissionMode('claude-code');
      expect(mode).toBe('bypassPermissions');
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

      expect(results['claude-code']).toBe('bypassPermissions');
      expect(results.codex).toBe('allow-all');
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
