/**
 * Permission Mode Mapper
 *
 * Each agent now uses its native permission modes directly.
 * This mapper is only needed for cross-agent operations (e.g., spawning a Codex
 * session from a Claude session with equivalent permissions).
 *
 * Native modes by agent:
 * - Claude Code: default, acceptEdits, bypassPermissions, plan, dontAsk
 * - Gemini: default, autoEdit, yolo
 * - Codex: ask, auto, on-failure, allow-all
 *
 * See: context/explorations/mcp-session-management.md for full specification
 */

import type { AgenticToolName, PermissionMode } from '../types';

/**
 * Maps a permission mode when spawning a child session of a different agent type.
 *
 * For same-agent operations, modes pass through unchanged.
 * For cross-agent operations, maps to the closest equivalent in the target agent.
 *
 * @param mode - The source permission mode
 * @param agenticTool - The target agentic tool
 * @returns The mapped permission mode for the target agent
 */
export function mapPermissionMode(
  mode: PermissionMode,
  agenticTool: AgenticToolName
): PermissionMode {
  switch (agenticTool) {
    case 'claude-code':
      // Claude Code native modes: default, acceptEdits, bypassPermissions, plan, dontAsk
      switch (mode) {
        // Native Claude modes - pass through
        case 'default':
        case 'acceptEdits':
        case 'bypassPermissions':
        case 'plan':
        case 'dontAsk':
          return mode;
        // Gemini modes → Claude equivalents
        case 'autoEdit':
          return 'acceptEdits';
        case 'yolo':
          return 'bypassPermissions';
        // Codex modes → Claude equivalents
        case 'ask':
          return 'default';
        case 'auto':
          return 'acceptEdits';
        case 'on-failure':
          return 'acceptEdits';
        case 'allow-all':
          return 'bypassPermissions';
        default:
          return 'acceptEdits'; // Safe default
      }

    case 'gemini':
    case 'opencode':
      // Gemini native modes: default, autoEdit, yolo
      switch (mode) {
        // Native Gemini modes - pass through
        case 'default':
        case 'autoEdit':
        case 'yolo':
          return mode;
        // Claude modes → Gemini equivalents
        case 'acceptEdits':
          return 'autoEdit';
        case 'bypassPermissions':
        case 'dontAsk':
          return 'yolo';
        case 'plan':
          return 'default'; // Plan mode → restrictive
        // Codex modes → Gemini equivalents
        case 'ask':
          return 'default';
        case 'auto':
          return 'autoEdit';
        case 'on-failure':
          return 'autoEdit';
        case 'allow-all':
          return 'yolo';
        default:
          return 'autoEdit'; // Safe default
      }

    case 'codex':
      // Codex native modes: ask, auto, on-failure, allow-all
      switch (mode) {
        // Native Codex modes - pass through
        case 'ask':
        case 'auto':
        case 'on-failure':
        case 'allow-all':
          return mode;
        // Claude modes → Codex equivalents
        case 'default':
          return 'ask';
        case 'acceptEdits':
          return 'auto';
        case 'bypassPermissions':
        case 'dontAsk':
          return 'allow-all';
        case 'plan':
          return 'ask';
        // Gemini modes → Codex equivalents
        case 'autoEdit':
          return 'auto';
        case 'yolo':
          return 'allow-all';
        default:
          return 'auto'; // Safe default
      }

    default:
      // Unknown tool - return mode as-is
      return mode;
  }
}

/**
 * Converts a unified PermissionMode to Codex-specific dual configuration.
 *
 * Codex uses a two-part permission system:
 * - sandboxMode: Controls WHERE Codex can write (filesystem boundaries)
 * - approvalPolicy: Controls WHETHER Codex asks before executing
 *
 * @param mode - The unified permission mode
 * @returns Codex-specific config { sandboxMode, approvalPolicy }
 */
export function mapToCodexPermissionConfig(mode: PermissionMode): {
  sandboxMode: 'read-only' | 'workspace-write';
  approvalPolicy: 'untrusted' | 'on-request' | 'on-failure' | 'never';
} {
  // First map to Codex-compatible mode
  const codexMode = mapPermissionMode(mode, 'codex');

  switch (codexMode) {
    case 'ask':
      return {
        sandboxMode: 'read-only',
        approvalPolicy: 'untrusted', // Ask for everything
      };
    case 'auto':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request', // Auto-approve safe ops, ask for dangerous
      };
    case 'on-failure':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-failure', // Ask only when tools fail
      };
    case 'allow-all':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never', // Never ask
      };
    default:
      // Fallback to safe default (ask for everything)
      return {
        sandboxMode: 'read-only',
        approvalPolicy: 'untrusted',
      };
  }
}
