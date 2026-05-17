/**
 * Tests for session.ts runtime behavior
 *
 * Per-tool defaults:
 * - Claude Code: acceptEdits (auto-accept edits; Bash still asks; MCP
 *   tool calls are auto-approved in the executor via canUseTool)
 * - Codex: allow-all (sandbox workspace-write + approval never +
 *   network-on; MCP elicitation auto-approved via per-server
 *   default_tools_approval_mode in the executor)
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

  it('returns "acceptEdits" for claude-code (auto-edit; Bash asks; MCP auto-approved in executor)', () => {
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
    it('codex maps to sandbox workspace-write + approval never', () => {
      const mode = getDefaultPermissionMode('codex');
      expect(mode).toBe('allow-all');
    });

    it('claude-code uses acceptEdits (auto-edit; Bash asks; MCP auto-approved in executor)', () => {
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

      expect(results['claude-code']).toBe('acceptEdits');
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
