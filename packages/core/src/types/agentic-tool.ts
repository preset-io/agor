// src/types/agentic-tool.ts

import type { AgenticToolID } from './id';

/**
 * Agentic coding tool names
 *
 * These are the external agentic CLI/IDE tools that connect to Agor:
 * - claude-code: Anthropic's Claude Code CLI
 * - codex: OpenAI's Codex CLI
 * - gemini: Google's Gemini Code Assist
 * - opencode: Open-source terminal-based AI assistant with 75+ LLM providers
 *
 * Not to be confused with "execution tools" (Bash, Write, Read, etc.)
 * which are the primitives that agentic tools use to perform work.
 */
export type AgenticToolName = 'claude-code' | 'codex' | 'gemini' | 'opencode';

/**
 * Agentic tool metadata for UI display
 *
 * Represents a configured agentic coding tool with installation status,
 * version info, and UI metadata (icon, description).
 */
export interface AgenticTool {
  /** Unique agentic tool configuration identifier (UUIDv7) */
  id: AgenticToolID;

  name: AgenticToolName;
  icon: string;
  installed: boolean;
  version?: string;
  description?: string;
  installable: boolean;
}

// ============================================================================
// Permission Types
// ============================================================================

/**
 * Claude Code permission modes (via Claude Agent SDK)
 *
 * Unified permission model - single mode controls tool approval behavior.
 * SDK 0.1.55+ includes 'dontAsk' mode for backward compatibility.
 */
export type ClaudeCodePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk';

/**
 * Gemini permission modes (via Gemini CLI SDK)
 *
 * Unified permission model - single mode controls tool approval behavior.
 */
export type GeminiPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/**
 * OpenCode permission modes (via OpenCode server SDK)
 *
 * Unified permission model - single mode controls tool approval behavior.
 * OpenCode auto-approves permissions during automation, so modes primarily affect
 * interactive prompting when user is present.
 */
export type OpenCodePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/**
 * Codex permission modes (legacy - now split into sandboxMode + approvalPolicy)
 *
 * Codex uses a DUAL permission model with two independent settings:
 * 1. sandboxMode - WHERE the agent can write (filesystem boundaries)
 * 2. approvalPolicy - WHETHER the agent asks before executing
 */
export type CodexPermissionMode = 'ask' | 'auto' | 'on-failure' | 'allow-all';

/**
 * Codex sandbox mode - controls WHERE agent can write (filesystem boundaries)
 *
 * - read-only: No filesystem writes allowed
 * - workspace-write: Write to workspace files only, blocks .git/ and system paths
 * - danger-full-access: Full filesystem access including .git/ and system paths
 */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * Codex approval policy - controls WHETHER agent asks before executing
 *
 * - untrusted: Ask for every operation
 * - on-request: Model decides when to ask (recommended)
 * - on-failure: Only ask when operations fail
 * - never: Auto-approve everything
 */
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'on-failure' | 'never';

/**
 * Codex network access mode - controls network connectivity
 *
 * Network access is only available when sandboxMode = 'workspace-write'.
 * Configured via [sandbox_workspace_write].network_access in config.toml.
 *
 * - disabled: No network access (default, most secure)
 * - enabled: Full outbound HTTP/HTTPS access (security risk - prompt injection, data exfiltration)
 *
 * Note: The 'web_search' tool is separate and controlled by the --search CLI flag.
 * This setting enables ALL network requests, not just web search.
 *
 * Security Warning: Enabling network access exposes your environment to:
 * - Prompt injection attacks
 * - Data exfiltration of code/secrets
 * - Inclusion of malware or vulnerable dependencies
 */
export type CodexNetworkAccess = boolean;
