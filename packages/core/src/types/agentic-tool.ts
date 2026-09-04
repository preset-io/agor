// src/types/agentic-tool.ts

import type { AgenticToolID, UUID } from './id';
import type { EffortLevel } from './session';

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
 * - codex: OpenAI's Codex CLI
 * - gemini: Google's Gemini Code Assist
 * - opencode: Open-source terminal-based AI assistant with 75+ LLM providers
 * - copilot: GitHub Copilot's agentic runtime via @github/copilot-sdk
 * - cursor: Cursor's agentic runtime via @cursor/sdk (experimental)
 * - workload: Agor's built-in deterministic, provider-free workload runner
 *
 * Not to be confused with "execution tools" (Bash, Write, Read, etc.)
 * which are the primitives that agentic tools use to perform work.
 */
export const AGENTIC_TOOL_NAMES = [
  'claude-code',
  'codex',
  'gemini',
  'opencode',
  'copilot',
  'cursor',
  'workload',
] as const;

export type AgenticToolName = (typeof AGENTIC_TOOL_NAMES)[number];

/** Built-in tools ship with Agor and do not require an optional provider package. */
export const BUILT_IN_AGENTIC_TOOL_NAMES = [
  'workload',
] as const satisfies readonly AgenticToolName[];
export type BuiltInAgenticToolName = (typeof BUILT_IN_AGENTIC_TOOL_NAMES)[number];

export function isBuiltInAgenticToolName(value: AgenticToolName): value is BuiltInAgenticToolName {
  return (BUILT_IN_AGENTIC_TOOL_NAMES as readonly AgenticToolName[]).includes(value);
}

/** Default used only while a user has not chosen a primary agentic tool. */
export const DEFAULT_AGENTIC_TOOL_NAME: AgenticToolName = 'claude-code';

/**
 * Removed tool identifiers that may still exist on persisted historical rows.
 *
 * They are intentionally excluded from {@link AgenticToolName}: no creation,
 * configuration, or executor boundary may accept them. Session/task/message
 * readers use {@link PersistedAgenticToolName} so history remains attributable
 * without reinterpreting it as another runtime.
 */
export const LEGACY_AGENTIC_TOOL_NAMES = ['claude-code-cli'] as const;
export type LegacyAgenticToolName = (typeof LEGACY_AGENTIC_TOOL_NAMES)[number];

/**
 * Every identifier that may be encountered while reading persisted history.
 *
 * Runtime/input schemas must use {@link AGENTIC_TOOL_NAMES}; storage/query
 * schemas use this tuple so historical attribution remains readable without
 * making removed tools executable again.
 */
export const PERSISTED_AGENTIC_TOOL_NAMES = [
  ...AGENTIC_TOOL_NAMES,
  ...LEGACY_AGENTIC_TOOL_NAMES,
] as const;
export type PersistedAgenticToolName = (typeof PERSISTED_AGENTIC_TOOL_NAMES)[number];

export function isAgenticToolName(value: unknown): value is AgenticToolName {
  return typeof value === 'string' && (AGENTIC_TOOL_NAMES as readonly string[]).includes(value);
}

export function isLegacyAgenticToolName(value: unknown): value is LegacyAgenticToolName {
  return (
    typeof value === 'string' && (LEGACY_AGENTIC_TOOL_NAMES as readonly string[]).includes(value)
  );
}

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
  /**
   * Whether the tool's SDK/config home can be reliably relocated to an
   * Agor-chosen directory via environment variable(s), so its persisted state
   * (transcripts, history, config, skills, plugins) lands wherever Agor points
   * it. Derived from the presence of a per-tool env-var mapping — see
   * {@link AgenticToolIntegration.configHomeOverride}; `false` when no reliable
   * relocation mechanism exists (e.g. cursor, whose relocation is confirmed
   * broken upstream). Non-sensitive: this type is browser-bundled.
   */
  supportsConfigHomeOverride: boolean;
  /**
   * Supported reasoning-effort overrides. Absent when the runtime has no
   * effort control.
   */
  reasoningEffortLevels?: readonly EffortLevel[];
  /**
   * Effective effort when Agor does not store an override. Absent means the
   * underlying runtime owns the default.
   */
  defaultReasoningEffort?: EffortLevel;
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
 * Result of importing a Codex `auth.json` via the daemon's `/codex-auth/import`
 * endpoint. Carries ONLY non-secret metadata — token material stays on the
 * daemon/filesystem side and never transits back to callers.
 */
export interface CodexAuthImportResult {
  status: 'authenticated';
  /** Whether the imported file carries ChatGPT login tokens or a bare API key. */
  authMode: 'chatgpt' | 'api_key';
  /** ChatGPT plan type parsed from the id_token claims (e.g. "plus", "pro"), when present. */
  planType?: string;
  hint?: string;
}

/**
 * Result of removing a Codex login via the daemon's `/codex-auth/logout`
 * endpoint. Delete-only and Agor-scoped: it removes the login from THIS server
 * (deletes auth.json + clears the stored method) and does NOT revoke the OAuth
 * tokens — the account stays signed in on other machines.
 */
export interface CodexAuthLogoutResult {
  status: 'removed';
}

/** Durable identity for one Codex device-sign-in attempt. */
export type CodexDeviceAuthAttemptID = UUID & { readonly __entity: 'CodexDeviceAuthAttempt' };

/**
 * Internal PostgreSQL lifecycle for a Codex device-sign-in attempt. Public
 * callers see the smaller {@link CodexDeviceAuthPhase} projection below.
 */
export type CodexDeviceAuthAttemptStatus =
  | 'starting'
  | 'pending'
  | 'exchanging'
  | 'persisting'
  | 'succeeded'
  | 'unavailable'
  | 'denied'
  | 'failed'
  | 'ambiguous'
  | 'expired'
  | 'superseded'
  | 'cancelled';

/**
 * Secret material sealed at rest for a durable Codex device-sign-in attempt.
 * The database row binds this envelope to its exact tenant, user, attempt, and
 * monotonic generation. It must never be logged, returned wholesale, or sent
 * through realtime/Redis.
 */
export interface CodexDeviceAuthSealedMaterial {
  version: 1;
  attemptId: CodexDeviceAuthAttemptID;
  tenantId: string;
  userId: string;
  attemptGeneration: number;
  delegatedHomeKey: string | null;
  codexHome?: string;
  deviceAuthId?: string;
  userCode?: string;
}

/**
 * Result of removing a Claude subscription login via the daemon's
 * `/claude-auth/logout` endpoint. Delete-only and Agor-scoped: it removes the
 * managed `~/.claude/.credentials.json` from THIS server and clears the stored
 * token + auth method; it does NOT revoke the OAuth tokens, so the account stays
 * signed in elsewhere.
 */
export interface ClaudeAuthLogoutResult {
  status: 'removed';
}

/**
 * Lifecycle of a ChatGPT device-code sign-in attempt driven by the daemon's
 * `/codex-auth/device` endpoints.
 * - `idle`: no attempt exists for this user.
 * - `pending`: a code was issued; the daemon is polling for approval.
 * - `success`: tokens were exchanged and persisted to the user's Codex home.
 * - `expired`: the code's 15-minute window elapsed without approval.
 * - `unavailable`: OpenAI's server refused to issue a code — device-code
 *   authorization is disabled for this account/workspace (a common, first-class
 *   state, not an edge case).
 * - `error`: the attempt failed for another reason; start a fresh one.
 */
export type CodexDeviceAuthPhase =
  | 'idle'
  | 'pending'
  | 'success'
  | 'expired'
  | 'unavailable'
  | 'error';

/**
 * Non-secret status of a device-code sign-in attempt. The user code and
 * verification URL are meant to be displayed; tokens never appear here.
 */
export interface CodexDeviceAuthStatus {
  phase: CodexDeviceAuthPhase;
  /** Opaque attempt identity used to keep reconnect/status behavior deterministic. */
  attemptId?: CodexDeviceAuthAttemptID;
  /** One-time code the user enters on the verification page (pending only). */
  userCode?: string;
  /** Page where the user approves the code (pending only). */
  verificationUrl?: string;
  /** ISO timestamp when the pending code stops working. */
  expiresAt?: string;
  /** ChatGPT plan type parsed from the id_token after success, when present. */
  planType?: string;
  hint?: string;
}

/**
 * Lifecycle of a Claude subscription OAuth sign-in driven by the daemon's
 * `/claude-auth/oauth` endpoint.
 *
 * Unlike Codex, Anthropic exposes no device-authorization endpoint, so the
 * daemon cannot poll for approval: the user approves in the browser and copies
 * a `CODE#STATE` string back to Agor. The code travels user→Agor (the reverse
 * of Codex), which is why there is an `awaiting_code` phase and no poll loop.
 * See `context/explorations/claude-code-oauth-signin.md`.
 *
 * - `idle`: no attempt exists for this user.
 * - `awaiting_code`: an authorize URL was issued; the daemon is waiting for the
 *   user to approve and paste the `CODE#STATE` back.
 * - `exchanging`: a pasted code was accepted and reserved the attempt; the
 *   daemon is exchanging it and writing credentials. Blocks a concurrent submit.
 * - `success`: the code was exchanged and `~/.claude/.credentials.json` written.
 * - `expired`: the daemon-side PKCE/state freshness window elapsed unused.
 * - `error`: the attempt failed for another reason; start a fresh one.
 */
export type ClaudeOAuthPhase =
  | 'idle'
  | 'awaiting_code'
  | 'exchanging'
  | 'success'
  | 'expired'
  | 'error';

/**
 * Non-secret status of a Claude OAuth sign-in attempt. The authorize URL is
 * meant to be displayed; tokens and the PKCE verifier never appear here.
 */
export interface ClaudeOAuthStatus {
  phase: ClaudeOAuthPhase;
  /** Authorize page the user opens to approve (awaiting_code only). */
  verificationUrl?: string;
  /** ISO timestamp when the daemon-side attempt stops accepting a code. */
  expiresAt?: string;
  /** Subscription type parsed from the token response after success, when present. */
  subscriptionType?: string;
  hint?: string;
  /**
   * Identifies the attempt to the client that started it, so a reconnect landing
   * on another replica can submit against the same attempt. Safe to expose: it
   * is not the OAuth `state` capability, of which only a SHA-256 fingerprint is
   * stored.
   */
  attemptId?: string;
}

/**
 * Identifier of one durable Claude OAuth sign-in attempt.
 *
 * Echoed to the initiating client for status reads and resumption. Like the MCP
 * attempt id it is deliberately NOT the OAuth `state`: the durable row keeps
 * only a fingerprint of that high-entropy one-time value.
 */
export type ClaudeOAuthAttemptID = UUID & { readonly __brand: 'ClaudeOAuthAttemptID' };

/** Durable lifecycle of a Claude subscription OAuth attempt. */
export type ClaudeOAuthAttemptStatus =
  | 'pending'
  | 'exchanging'
  | 'persisting'
  | 'succeeded'
  | 'failed'
  | 'ambiguous'
  | 'expired';

/**
 * Sealed exchange material for a Claude OAuth attempt.
 *
 * Only ever produced/consumed inside the daemon's OAuth authority, sealed with
 * the deployment master secret and AAD-bound to the row it belongs to. The PKCE
 * verifier lives here; raw OAuth `state` is never persisted, even encrypted.
 */
export interface ClaudeOAuthSealedMaterial {
  version: 1;
  attemptId: ClaudeOAuthAttemptID;
  tenantId: string;
  userId: string;
  attemptGeneration: number;
  /** PKCE verifier used only for the one-shot provider exchange. */
  codeVerifier: string;
  /**
   * Execution home the credential must land in, fixed when the attempt started.
   * Re-resolved and compared before the write so a mid-flow identity change
   * cannot redirect the credential to a different home.
   */
  delegatedHomeKey: string | null;
  /** Canonical exact tenant/user `.claude` directory used by the contained HA writer. */
  claudeConfigDir?: string;
}
