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
 */

import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexSandboxMode,
  PermissionMode,
} from '../types';
import { getDefaultPermissionMode } from '../types/session.js';

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
    case 'copilot':
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
 * Codex sub-config derived from a unified PermissionMode. Used as the
 * single source of truth for default sandbox / approval / network
 * settings across the daemon resolver, executor fallback, and UI flows.
 *
 * `networkAccess` is yoked to `approvalPolicy === 'never'`: the "trust the
 * sandbox" mode is the only one we treat as permissive enough to enable
 * outbound network by default. Restrictive / asking modes keep it off so
 * users who intentionally tighten approvals don't get network on top.
 */
export interface CodexPermissionDefaults {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  networkAccess: boolean;
}

/**
 * Convert a unified PermissionMode to a Codex sub-config (sandbox + approval
 * + network). The mapping table lives here so the daemon resolver, executor
 * fallback, and every UI surface that needs to display "what would happen
 * if this session ran now" all agree on the answer.
 */
export function mapToCodexPermissionConfig(mode: PermissionMode): CodexPermissionDefaults {
  // First map to Codex-compatible mode
  const codexMode = mapPermissionMode(mode, 'codex');

  switch (codexMode) {
    case 'ask':
      return { sandboxMode: 'read-only', approvalPolicy: 'untrusted', networkAccess: false };
    case 'auto':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'on-request', networkAccess: false };
    case 'on-failure':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'on-failure', networkAccess: false };
    case 'allow-all':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccess: true };
    default:
      return { sandboxMode: 'read-only', approvalPolicy: 'untrusted', networkAccess: false };
  }
}

/**
 * Codex sub-config for the system default permission mode. Convenience
 * wrapper for the common "I have no source mode in hand — give me what a
 * brand-new session would get" case.
 */
export function getDefaultCodexPermissionConfig(): CodexPermissionDefaults {
  return mapToCodexPermissionConfig(getDefaultPermissionMode('codex'));
}
