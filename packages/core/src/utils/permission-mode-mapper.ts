/**
 * Permission Mode Mapper
 *
 * Maps unified PermissionMode values to agent-specific permission configurations.
 * This allows agents to use a consistent permission vocabulary across different tools.
 *
 * See: context/explorations/mcp-session-management.md for full specification
 */

import type { AgenticToolName, PermissionMode } from '../types';

/**
 * Maps a unified PermissionMode to the appropriate agent-specific configuration.
 *
 * Different agentic tools use different permission systems:
 * - Claude Code/Gemini: Single mode string
 * - Codex: Dual config (sandboxMode + approvalPolicy)
 *
 * This function provides graceful fallbacks for invalid/incompatible modes.
 *
 * @param mode - The unified permission mode
 * @param agenticTool - The target agentic tool
 * @returns The mapped permission mode (may differ from input if incompatible)
 */
export function mapPermissionMode(
  mode: PermissionMode,
  agenticTool: AgenticToolName
): PermissionMode {
  switch (agenticTool) {
    case 'claude-code':
    case 'cursor':
    case 'gemini':
      // Claude/Gemini support: default, acceptEdits, bypassPermissions, plan
      // Map Codex-specific modes to closest equivalents
      switch (mode) {
        case 'ask':
          return 'default'; // Codex 'ask' → Claude 'default' (ask for each tool)
        case 'auto':
          return 'acceptEdits'; // Codex 'auto' → Claude 'acceptEdits' (auto-approve safe ops)
        case 'on-failure':
          return 'acceptEdits'; // Codex 'on-failure' → Claude 'acceptEdits' (closest match)
        case 'allow-all':
          return 'bypassPermissions'; // Codex 'allow-all' → Claude 'bypassPermissions'
        default:
          // default, acceptEdits, bypassPermissions, plan - pass through
          return mode;
      }

    case 'codex':
      // Codex supports: ask, auto, on-failure, allow-all
      // Map Claude-specific modes to closest equivalents
      switch (mode) {
        case 'default':
          return 'ask'; // Claude 'default' → Codex 'ask' (ask for each tool)
        case 'acceptEdits':
          return 'auto'; // Claude 'acceptEdits' → Codex 'auto' (auto-approve safe ops)
        case 'bypassPermissions':
          return 'allow-all'; // Claude 'bypassPermissions' → Codex 'allow-all'
        case 'plan':
          return 'ask'; // Claude 'plan' → Codex 'ask' (most restrictive, since plan is Claude-specific)
        default:
          // ask, auto, on-failure, allow-all - pass through
          return mode;
      }

    default:
      // Unknown tool - return mode as-is (graceful degradation)
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
