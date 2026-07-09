// src/types/agentic-tool.ts

import type { AgenticToolID } from './id';

/**
 * The set of credential env-var names the resolver knows how to look up.
 * Kept as an explicit union so callers can't accidentally use an unrelated var.
 * Lives in types (not config) so it is accessible to the browser bundle and
 * executor without creating a circular config→types dependency.
 */
export type ApiKeyName =
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_AUTH_TOKEN'
  | 'CLAUDE_CODE_OAUTH_TOKEN'
  | 'OPENAI_API_KEY'
  | 'GEMINI_API_KEY'
  | 'COPILOT_GITHUB_TOKEN'
  | 'CURSOR_API_KEY';

/**
 * Agentic coding tool names
 *
 * These are the external agentic CLI/IDE tools that connect to Agor:
 * - claude-code: Anthropic's Claude Code via the Agent SDK (API-key path).
 *   Renaming to 'claude-agent-sdk' is staged for a follow-up commit; the
 *   string value stays 'claude-code' for backward compatibility with
 *   existing DB rows until a coordinated DB+UI migration ships.
 * - claude-code-cli: The `claude` shell binary running interactively in a
 *   Zellij pane, JSONL-tailed by the daemon. Subscription-auth friendly.
 *   See docs/internal/claude-code-cli-integration-analysis-2026-05-14.md.
 * - codex: OpenAI's Codex CLI
 * - gemini: Google's Gemini Code Assist
 * - opencode: Open-source terminal-based AI assistant with 75+ LLM providers
 * - copilot: GitHub Copilot's agentic runtime via @github/copilot-sdk
 * - cursor: Cursor's agentic runtime via @cursor/sdk (experimental)
 *
 * Not to be confused with "execution tools" (Bash, Write, Read, etc.)
 * which are the primitives that agentic tools use to perform work.
 */
export type AgenticToolName =
  | 'claude-code'
  | 'claude-code-cli'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'copilot'
  | 'cursor';

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
 * 'auto' uses a model classifier to approve/deny permission prompts; anything
 * it doesn't auto-resolve still falls through to Agor's canUseTool UI.
 */
export type ClaudeCodePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'auto'
  | 'dontAsk';

/**
 * Gemini permission modes (via Gemini CLI SDK)
 *
 * Native SDK ApprovalMode values:
 * - default: Prompt for each tool use (ApprovalMode.DEFAULT)
 * - autoEdit: Auto-approve file edits only (ApprovalMode.AUTO_EDIT)
 * - yolo: Auto-approve all operations (ApprovalMode.YOLO)
 */
export type GeminiPermissionMode = 'default' | 'autoEdit' | 'yolo';

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

/**
 * Copilot permission modes (via @github/copilot-sdk)
 *
 * Maps to onPermissionRequest callback behavior:
 * - default: Proxy all permission requests to Agor UI for user approval
 * - acceptEdits: Auto-approve read/write operations, ask for shell/MCP
 * - bypassPermissions: Auto-approve everything (equivalent to approveAll helper)
 */
export type CopilotPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/**
 * Cursor permission modes (via @cursor/sdk, experimental).
 *
 * Cursor SDK does not currently expose a blocking Agor-style permission callback,
 * so these mirror the autonomous-provider modes until a richer policy surface exists.
 */
export type CursorPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

// ============================================================================
// Tool Capabilities (static, shared between backend and UI)
// ============================================================================

/**
 * Static capability flags for agentic tools.
 * Used by the UI to show/hide features based on what a tool supports.
 * Mirrors the runtime ToolCapabilities in the executor but is available
 * without instantiating a tool.
 */
export interface AgenticToolCapabilities {
  /** Can fork sessions (branch conversation at a decision point) */
  supportsSessionFork: boolean;
  /** Can spawn child sessions for subsessions */
  supportsChildSpawn: boolean;
  /** Can import historical sessions from tool's storage */
  supportsSessionImport: boolean;
  /** Supports stateless filesystem mode (session state serialized to DB) */
  supportsStatelessFsMode: boolean;
}

/**
 * Static capability map for all agentic tools.
 * Source of truth for what each tool supports — avoids scattered `if (tool === 'codex')` checks.
 */
/**
 * Tri-state outcome of a credential check.
 * - `authenticated`: a working credential was positively confirmed.
 * - `unauthenticated`: positively proven to have NO working credential
 *   (empty native auth, absent auth file, provider 401/403 on a present key).
 * - `unknown`: could not determine — transport error, provider timeout/5xx, or
 *   a credential class the check cannot resolve. Callers must FAIL SAFE and treat
 *   this as "possibly connected" (never surface a "not connected" state).
 */
export type AuthCheckStatus = 'authenticated' | 'unauthenticated' | 'unknown';

/**
 * Auth check result — shared type for ITool.isAuthenticated and the daemon /check-auth service.
 *
 * `authenticated` is a DERIVED convenience equal to `status === 'authenticated'`,
 * kept so presence-only consumers keep compiling; consumers that must distinguish
 * "couldn't verify" from "no auth" read `status`.
 */
export interface AuthCheckResult {
  status: AuthCheckStatus;
  authenticated: boolean;
  method: 'api-key' | 'oauth' | 'native' | 'none';
  hint?: string;
}

/**
 * Canonical mapping from AgenticToolName to the env-var name that holds its primary API key.
 * Tools that authenticate without a key (opencode) are intentionally absent.
 *
 * Single source of truth — used by the daemon check-auth service, the executor tool registry,
 * and the onboarding wizard's API-key step.
 */
export const TOOL_API_KEY_NAMES: Partial<Record<AgenticToolName, ApiKeyName>> = {
  'claude-code': 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  copilot: 'COPILOT_GITHUB_TOKEN',
  cursor: 'CURSOR_API_KEY',
};

export const AGENTIC_TOOL_CAPABILITIES: Record<AgenticToolName, AgenticToolCapabilities> = {
  'claude-code': {
    supportsSessionFork: true,
    supportsChildSpawn: true,
    supportsSessionImport: true,
    supportsStatelessFsMode: true,
  },
  'claude-code-cli': {
    // First-class CLI flag: `claude --resume <id> --fork-session`
    supportsSessionFork: true,
    // New `claude --session-id <new uuid>` in a fresh Zellij pane
    supportsChildSpawn: true,
    // v1: false. The on-disk JSONL is ingestable but the "adopt existing
    // session" UI flow is deferred to v2 (see analysis doc § Phased delivery).
    supportsSessionImport: false,
    // CLI sessions live in long-running PTYs; state is on disk in the JSONL,
    // not a serializable filesystem snapshot the daemon manages.
    supportsStatelessFsMode: false,
  },
  codex: {
    supportsSessionFork: true,
    supportsChildSpawn: true,
    supportsSessionImport: false,
    supportsStatelessFsMode: true,
  },
  gemini: {
    supportsSessionFork: false,
    supportsChildSpawn: true,
    supportsSessionImport: false,
    supportsStatelessFsMode: false,
  },
  opencode: {
    supportsSessionFork: false,
    supportsChildSpawn: true,
    supportsSessionImport: false,
    supportsStatelessFsMode: false,
  },
  copilot: {
    supportsSessionFork: false,
    supportsChildSpawn: true,
    supportsSessionImport: false,
    supportsStatelessFsMode: false,
  },
  cursor: {
    supportsSessionFork: false,
    supportsChildSpawn: true,
    supportsSessionImport: false,
    supportsStatelessFsMode: false,
  },
};
