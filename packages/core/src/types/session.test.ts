/**
 * Tests for session.ts runtime behavior
 *
 * Per-tool defaults:
 * - Claude Code: auto (model classifier approves/denies prompts; unresolved
 *   ones fall through to Agor's UI; MCP tool calls are auto-approved in the
 *   executor via canUseTool)
 * - Codex: allow-all (sandbox workspace-write + approval never +
 *   network-on; MCP elicitation auto-approved via per-server
 *   default_tools_approval_mode in the executor)
 * - Gemini: autoEdit (unchanged — pending separate audit)
 * - OpenCode: autoEdit (unchanged — pending separate audit)
 * - Cursor: bypassPermissions (experimental/autonomous until permission callbacks exist)
 */

import { describe, expect, it } from 'vitest';
import type { AgenticToolName } from './agentic-tool';
import { getDefaultPermissionMode, isSessionPromptable, sessionCanStartTask } from './session';

describe('session promptability helpers', () => {
  it('treats idle sessions as promptable regardless of the attention flag', () => {
    expect(sessionCanStartTask('idle', false)).toBe(true);
    expect(sessionCanStartTask('idle', true)).toBe(true);
    expect(isSessionPromptable({ status: 'idle', ready_for_prompt: false })).toBe(true);
  });

  it('treats failed sessions as promptable only after the terminal task made them ready', () => {
    expect(sessionCanStartTask('failed', true)).toBe(true);
    expect(sessionCanStartTask('failed', false)).toBe(false);
    expect(isSessionPromptable({ status: 'failed', ready_for_prompt: true })).toBe(true);
    expect(isSessionPromptable({ status: 'failed', ready_for_prompt: false })).toBe(false);
  });

  it('does not confuse ready_for_prompt attention state with promptability', () => {
    expect(sessionCanStartTask('timed_out', true)).toBe(false);
    expect(sessionCanStartTask('running', true)).toBe(false);
    expect(isSessionPromptable({ status: 'timed_out', ready_for_prompt: true })).toBe(false);
  });
});

describe('getDefaultPermissionMode', () => {
  it('returns "allow-all" for codex (Agor MCP-heavy default)', () => {
    expect(getDefaultPermissionMode('codex')).toBe('allow-all');
  });

  it('returns "auto" for claude-code (model classifier; unresolved prompts fall through to Agor UI)', () => {
    expect(getDefaultPermissionMode('claude-code')).toBe('auto');
  });

  it('returns "auto" for claude-code-cli (shares the Claude default)', () => {
    expect(getDefaultPermissionMode('claude-code-cli')).toBe('auto');
  });

  it('returns "autoEdit" for gemini (native Gemini mode)', () => {
    expect(getDefaultPermissionMode('gemini')).toBe('autoEdit');
  });

  it('returns "autoEdit" for opencode (uses Gemini-like modes)', () => {
    expect(getDefaultPermissionMode('opencode')).toBe('autoEdit');
  });

  it('returns "bypassPermissions" for cursor (experimental autonomous provider)', () => {
    expect(getDefaultPermissionMode('cursor')).toBe('bypassPermissions');
  });

  it('returns "auto" for any unknown tool (default case)', () => {
    // Type assertion to test default behavior with invalid input
    const unknownTool = 'unknown-tool' as AgenticToolName;
    expect(getDefaultPermissionMode(unknownTool)).toBe('auto');
  });

  describe('permission mode characteristics', () => {
    it('codex maps to sandbox workspace-write + approval never', () => {
      const mode = getDefaultPermissionMode('codex');
      expect(mode).toBe('allow-all');
    });

    it('claude-code uses auto (model classifier; unresolved prompts fall through to Agor UI)', () => {
      const mode = getDefaultPermissionMode('claude-code');
      expect(mode).toBe('auto');
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
      const allTools: AgenticToolName[] = [
        'claude-code',
        'claude-code-cli',
        'codex',
        'gemini',
        'opencode',
        'copilot',
        'cursor',
      ];
      const results: Record<string, string> = {};

      for (const tool of allTools) {
        results[tool] = getDefaultPermissionMode(tool);
      }

      expect(results['claude-code']).toBe('auto');
      expect(results['claude-code-cli']).toBe('auto');
      expect(results.codex).toBe('allow-all');
      expect(results.gemini).toBe('autoEdit');
      expect(results.opencode).toBe('autoEdit');
      expect(results.copilot).toBe('acceptEdits');
      expect(results.cursor).toBe('bypassPermissions');
    });

    it('returns valid PermissionMode values', () => {
      const allTools: AgenticToolName[] = [
        'claude-code',
        'claude-code-cli',
        'codex',
        'gemini',
        'opencode',
        'copilot',
        'cursor',
      ];
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
