/**
 * Gateway Service Types
 *
 * Types for the gateway service that routes messages between
 * messaging platforms (Slack, Discord, etc.) and Agor sessions.
 */

import type { AgenticToolName, CodexApprovalPolicy, CodexSandboxMode } from './agentic-tool';
import type { BranchID, SessionID, TaskID, UserID, UUID } from './id';
import type { ScheduleID } from './schedule';
import type { PermissionMode } from './session';
import type { DefaultModelConfig } from './user';

// ============================================================================
// ID Types
// ============================================================================

/** Gateway channel identifier */
export type GatewayChannelID = UUID;

/** Thread-session mapping identifier */
export type ThreadSessionMapID = UUID;

/** Gateway outbound seed/audit message identifier */
export type GatewayOutboundMessageID = UUID;

// ============================================================================
// Enums
// ============================================================================

/** Supported messaging platform types */
export type ChannelType = 'slack' | 'discord' | 'whatsapp' | 'telegram' | 'github' | 'teams';

/** Thread lifecycle status */
export type ThreadStatus = 'active' | 'archived' | 'paused';

/** Sensitive gateway config fields that must be encrypted at rest and redacted in responses. */
export const GATEWAY_SENSITIVE_CONFIG_FIELDS = [
  'bot_token',
  'app_token',
  'signing_secret',
  'private_key',
  'webhook_secret',
  'app_password',
] as const;

/** Sentinel value used by gateway APIs/tools to represent a redacted secret. */
export const GATEWAY_REDACTED_SENTINEL = '••••••••';

/**
 * Secrets that MUST be present for a channel of the given type to function.
 *
 * This is the single source of truth for the "enabled requires secrets"
 * invariant: an enabled channel can never exist without these values. It is
 * consumed by the create schema (reject enabled creates that omit them), the
 * repository enable-time guard (assert on every write path), and the token
 * widget. Browser-safe and dependency-free so both the UI and the daemon can
 * import it.
 *
 * A disabled ("draft") channel may legally omit all of these — the guard only
 * fires once the channel becomes enabled.
 */
export function getRequiredSecretFields(
  channelType: ChannelType,
  config: Record<string, unknown>
): string[] {
  switch (channelType) {
    case 'slack': {
      // Slack needs an app_token whenever the channel LISTENS (Socket Mode):
      // an explicit socket connection, or any inbound surface flag. Only a
      // purely outbound channel (sends, never listens) may omit it.
      const wantsInbound =
        config.connection_mode === 'socket' ||
        config.enable_channels === true ||
        config.enable_groups === true ||
        config.enable_mpim === true;
      const outboundOnly = config.outbound_enabled === true && !wantsInbound;
      return outboundOnly ? ['bot_token'] : ['bot_token', 'app_token'];
    }
    case 'github':
      return ['private_key'];
    case 'teams':
      return ['app_password'];
    default:
      return [];
  }
}

// ============================================================================
// Agent Tool Capabilities
// ============================================================================

/**
 * Per-channel toggles for agent-callable gateway MCP tools, stored at
 * `config.agent_tools` on Slack gateway channels.
 *
 * Each key is one capability that maps 1:1 to an MCP tool: the toggle gates
 * the tool at call time AND drives the Slack OAuth scopes the manifest
 * requests (see `SLACK_AGENT_TOOL_SCOPES` in the manifest generator), so
 * tool-gating and scopes can never drift. Extending the model is one seam:
 * add a key here, a default below, and its scope list in the manifest map.
 *
 * Browser-safe and dependency-free so both the UI and the daemon can import it.
 */
export interface SlackAgentToolsConfig {
  /** Read mapped Slack thread history (agor_gateway_slack_thread_history_get). */
  thread_history?: boolean;
  /** Read whole-channel Slack history (agor_gateway_slack_channel_history_get). */
  channel_history?: boolean;
  /** Add/remove emoji reactions (agor_gateway_slack_reaction_add / _remove). */
  reactions?: boolean;
  /** Upload a file/image to a channel or thread (agor_gateway_slack_file_upload). */
  file_upload?: boolean;
  /** Download a Slack file into the upload area by id (agor_gateway_slack_file_download). */
  file_download?: boolean;
}

export type SlackAgentToolCapability = keyof SlackAgentToolsConfig;

/**
 * Defaults applied when a capability is absent from `config.agent_tools`
 * (including channels created before the capability model existed):
 *
 * - `thread_history` defaults ON — the thread-history tool shipped ungated,
 *   so absent config must keep it working on existing channels.
 * - `channel_history` defaults OFF — reading arbitrary channel history is a
 *   broader data surface than the mapped thread and needs Slack scopes the
 *   installed app may not hold, so it requires explicit opt-in.
 * - `reactions` and `file_upload` default OFF — both add write scopes
 *   (`reactions:write`, `files:write`) the installed app may not hold, so
 *   they require explicit opt-in.
 * - `file_download` defaults OFF — it lets agents pull workspace file content
 *   on demand and adds the `files:read` scope the installed app may not hold,
 *   so it requires explicit opt-in.
 */
export const SLACK_AGENT_TOOL_DEFAULTS: Record<SlackAgentToolCapability, boolean> = {
  thread_history: true,
  channel_history: false,
  reactions: false,
  file_upload: false,
  file_download: false,
};

/**
 * Resolve a channel's `config.agent_tools` value (possibly absent or
 * malformed) into a fully-populated capability map with defaults applied.
 */
export function resolveSlackAgentTools(raw: unknown): Record<SlackAgentToolCapability, boolean> {
  const config =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const resolved = { ...SLACK_AGENT_TOOL_DEFAULTS };
  for (const capability of Object.keys(resolved) as SlackAgentToolCapability[]) {
    if (typeof config[capability] === 'boolean') {
      resolved[capability] = config[capability] as boolean;
    }
  }
  return resolved;
}

// ============================================================================
// Connection Probe Results
// ============================================================================

/**
 * A single capability that a connection probe could not establish.
 *
 * `capability` names the thing that failed (e.g. `bot_token`, `app_token`,
 * `channel_access`). `needed`/`provided` carry Slack's verbatim
 * `missing_scope` detail when present so the UI can tell the operator exactly
 * which OAuth scope to add rather than a generic "permission denied".
 */
export interface SlackTestFailure {
  capability: string;
  reason: string;
  slackError?: string;
  needed?: string;
  provided?: string;
}

/**
 * Result of a best-effort Slack connection probe.
 *
 * The probe exercises real Slack API calls (bot token auth, app-token Socket
 * Mode handshake, sampled channel access) but cannot prove everything about a
 * working installation — `notVerifiable` enumerates what green does NOT
 * guarantee so the result is never read as "fully verified".
 */
export interface SlackTestResult {
  ok: boolean;
  team?: { id: string; name: string };
  bot?: { userId: string; name: string };
  appTokenValid?: boolean;
  channelAccess?: { channelId: string; ok: boolean }[];
  failures: SlackTestFailure[];
  notVerifiable: string[];
}

// ============================================================================
// Agentic Tool Configuration
// ============================================================================

/**
 * Agentic tool configuration for gateway channels.
 *
 * Reuses existing types from agentic-tool.ts and user.ts to stay DRY.
 * When a channel has agentic_config, sessions created via that channel
 * use these settings. Falls back to user defaults when not set.
 */
/**
 * A single gateway-level environment variable with override behavior.
 *
 * - `forceOverride: false` (default) — fallback only; used when the user
 *   hasn't defined this key at the user level.
 * - `forceOverride: true` — always applied, even if the user has their own value.
 */
export interface GatewayEnvVar {
  key: string;
  value: string;
  forceOverride: boolean;
}

export interface GatewayAgenticConfig {
  agent: AgenticToolName;
  /** Live preset reference. Remaining runtime fields are ignored when present. */
  presetId?: import('./agentic-tool-preset').AgenticToolPresetID;
  modelConfig?: DefaultModelConfig;
  permissionMode?: PermissionMode;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: boolean;
  /**
   * Gateway-level environment variables (e.g., service account tokens).
   *
   * Each entry specifies a key, value, and override mode:
   * - Fallback (`forceOverride: false`) — merged BEFORE user env vars so user
   *   values take precedence when both exist.
   * - Force override (`forceOverride: true`) — merged AFTER user env vars so
   *   the channel value always wins.
   */
  envVars?: GatewayEnvVar[];
}

// ============================================================================
// Core Interfaces
// ============================================================================

/**
 * Gateway Channel - A registered messaging platform integration
 *
 * Users create channels to connect messaging platforms (Slack, Discord, etc.)
 * to Agor. Each channel targets a specific branch and routes messages
 * to/from sessions within that branch.
 */
export interface GatewayChannel {
  id: GatewayChannelID;
  created_by: string;
  name: string;
  channel_type: ChannelType;
  target_branch_id: BranchID;
  agor_user_id: UserID;
  channel_key: string; // UUID — the auth secret for inbound webhooks
  config: Record<string, unknown>; // Platform credentials (encrypted at rest)
  agentic_config: GatewayAgenticConfig | null; // Session creation settings
  /** MCP servers attached independently of the agentic-tool configuration. */
  mcp_server_ids?: string[];
  enabled: boolean;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  last_message_at: string | null;
}

/**
 * Thread-Session Mapping - Links a platform thread to an Agor session
 *
 * Each thread in a messaging platform maps 1:1 to an Agor session.
 * The gateway service manages these mappings for routing.
 */
export interface ThreadSessionMap {
  id: ThreadSessionMapID;
  channel_id: GatewayChannelID;
  thread_id: string; // Platform-specific (e.g., "C123456-1707340800.123456")
  session_id: SessionID;
  branch_id: BranchID;
  created_at: string;
  last_message_at: string;
  status: ThreadStatus;
  metadata: Record<string, unknown> | null;
}

/**
 * Gateway outbound message - durable seed/audit record for proactive emits.
 *
 * These rows intentionally do not imply a thread-session mapping. The mapping is
 * created only when a human replies to the seeded external thread.
 */
export interface GatewayOutboundMessage {
  id: GatewayOutboundMessageID;
  gateway_channel_id: GatewayChannelID;
  channel_type: ChannelType;

  platform_channel_id: string;
  platform_message_id: string;
  platform_thread_id: string;
  platform_permalink: string | null;

  target_branch_id: BranchID;
  emitted_by_user_id: UserID;
  emitted_by_session_id: SessionID | null;
  emitted_by_task_id: TaskID | null;
  emitted_by_schedule_id: ScheduleID | null;

  message_text: string;
  message_preview: string;
  metadata: Record<string, unknown> | null;
  consumed_by_session_id: SessionID | null;
  consumed_at: string | null;

  created_at: string;
  updated_at: string;
}
