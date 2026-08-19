/**
 * Gateway Service Types
 *
 * Types for the gateway service that routes messages between
 * messaging platforms (Slack, Discord, etc.) and Agor sessions.
 */

import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexSandboxMode,
  PersistedAgenticToolName,
} from './agentic-tool';
import type { AgenticToolConfigurationReference } from './agentic-tool-preset';
import type { BranchID, SessionID, TaskID, UserID, UUID } from './id';
import type { ScheduleID } from './schedule';
import type { PermissionMode, Session } from './session';
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

/** Durable identity for one provider-delivered inbound gateway event. */
export type GatewayInboundEventID = UUID;

// ============================================================================
// Enums
// ============================================================================

/** Supported messaging platform types */
export type ChannelType =
  | 'slack'
  | 'discord'
  | 'whatsapp'
  | 'telegram'
  | 'github'
  | 'teams'
  | 'shortcut';

/** Providers with an explicitly audited PostgreSQL listener ownership contract. */
export const DURABLE_GATEWAY_LISTENER_CHANNEL_TYPES = [
  'slack',
  'github',
  'shortcut',
  'discord',
] as const satisfies readonly ChannelType[];

/** Thread lifecycle status */
export type ThreadStatus = 'active' | 'archived' | 'paused';

/** Internal processing state for a provider event idempotency occurrence. */
export type GatewayInboundEventStatus = 'processing' | 'completed';

/** Sensitive gateway config fields that must be encrypted at rest and redacted in responses. */
export const GATEWAY_SENSITIVE_CONFIG_FIELDS = [
  'bot_token',
  'app_token',
  'signing_secret',
  'private_key',
  'webhook_secret',
  'app_password',
  'api_token',
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
    case 'shortcut':
      // Shortcut is poll-based over the REST API — the API token is always
      // required for an enabled channel (there is no outbound-only mode).
      return ['api_token'];
    case 'discord':
      return ['bot_token'];
    default:
      return [];
  }
}

/** Discord gateway configuration used by both the browser wizard and daemon. */
export interface DiscordGatewayConfig {
  bot_token?: string;
  application_id?: string;
  guild_id?: string;
  allowed_channel_ids?: string[];
  allowed_user_ids?: string[];
  allowed_role_ids?: string[];
  outbound_enabled?: boolean;
  default_outbound_target?: string | null;
}

export interface DiscordConfigValidationResult {
  ok: boolean;
  errors: string[];
}

const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * Validate the non-secret Discord beta configuration without importing any
 * provider SDK. This is intentionally safe to use in the browser and is also
 * the daemon's fail-closed listener eligibility check.
 */
export function validateDiscordConfig(
  raw: Record<string, unknown>,
  options: { requireBotToken?: boolean } = {}
): DiscordConfigValidationResult {
  const errors: string[] = [];
  const requiredSnowflakes: Array<[string, unknown]> = [
    ['application_id', raw.application_id],
    ['guild_id', raw.guild_id],
  ];
  for (const [field, value] of requiredSnowflakes) {
    if (typeof value !== 'string' || !DISCORD_SNOWFLAKE_RE.test(value)) {
      errors.push(`${field} must be a Discord snowflake`);
    }
  }

  const rawAllowedChannelIds = raw.allowed_channel_ids;
  const allowedChannelIds = Array.isArray(rawAllowedChannelIds)
    ? rawAllowedChannelIds.filter((item): item is string => typeof item === 'string')
    : [];
  if (
    !Array.isArray(rawAllowedChannelIds) ||
    allowedChannelIds.length === 0 ||
    rawAllowedChannelIds.some(
      (item) => typeof item !== 'string' || !DISCORD_SNOWFLAKE_RE.test(item)
    )
  ) {
    errors.push('allowed_channel_ids must contain one or more Discord snowflakes');
  }

  if (options.requireBotToken !== false) {
    if (
      typeof raw.bot_token !== 'string' ||
      raw.bot_token.trim() === '' ||
      raw.bot_token === GATEWAY_REDACTED_SENTINEL
    ) {
      errors.push('bot_token is required');
    }
  }

  const validateAllowlist = (field: 'allowed_user_ids' | 'allowed_role_ids') => {
    const value = raw[field];
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      errors.push(`${field} must contain only Discord snowflakes`);
      return;
    }
    if (value.length === 0) return;
    if (value.some((item) => typeof item !== 'string' || !DISCORD_SNOWFLAKE_RE.test(item))) {
      errors.push(`${field} must contain only Discord snowflakes`);
    }
  };
  validateAllowlist('allowed_user_ids');
  validateAllowlist('allowed_role_ids');
  const userAllowlist = Array.isArray(raw.allowed_user_ids) ? raw.allowed_user_ids : [];
  const roleAllowlist = Array.isArray(raw.allowed_role_ids) ? raw.allowed_role_ids : [];
  if (userAllowlist.length === 0 && roleAllowlist.length === 0) {
    errors.push('at least one allowed_user_ids or allowed_role_ids entry is required');
  }

  if (raw.outbound_enabled !== undefined && typeof raw.outbound_enabled !== 'boolean') {
    errors.push('outbound_enabled must be a boolean');
  }
  if (raw.default_outbound_target !== undefined && raw.default_outbound_target !== null) {
    if (typeof raw.default_outbound_target !== 'string') {
      errors.push('default_outbound_target must be channel:<snowflake>');
    } else {
      const match = /^channel:(\d{17,20})$/.exec(raw.default_outbound_target.trim());
      if (!match || !allowedChannelIds.includes(match[1])) {
        errors.push('default_outbound_target must target an allowed channel');
      }
    }
  }

  return { ok: errors.length === 0, errors };
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
 * `capability` names the thing that failed (e.g. `api_token`, `bot_token`, or
 * `channel_access`). The optional Slack fields preserve verbatim
 * `missing_scope` detail when that connector can provide it.
 */
export interface GatewayConnectionTestFailure {
  capability: string;
  reason: string;
  slackError?: string;
  needed?: string;
  provided?: string;
}

/** Granular channel permissions reported by providers that can inspect them. */
export interface GatewayConnectionTestPermissionDetails {
  view: boolean;
  send: boolean;
  readHistory: boolean;
  sendInThreads: boolean;
}

/** Access result for one configured provider channel. */
export interface GatewayConnectionTestChannelAccess {
  channelId: string;
  ok: boolean;
  permissions?: GatewayConnectionTestPermissionDetails;
}

/**
 * Result of a best-effort gateway connector connection probe.
 *
 * Probes exercise real platform calls but cannot prove everything about a
 * working installation. `notVerifiable` enumerates what green does NOT
 * guarantee; connector-specific optional fields carry richer details.
 */
export interface GatewayConnectionTestResult {
  ok: boolean;
  team?: { id: string; name: string };
  bot?: { userId: string; name: string };
  appTokenValid?: boolean;
  channelAccess?: GatewayConnectionTestChannelAccess[];
  failures: GatewayConnectionTestFailure[];
  notVerifiable: string[];
}

/** @deprecated Use {@link GatewayConnectionTestFailure}. */
export type SlackTestFailure = GatewayConnectionTestFailure;

/** @deprecated Use {@link GatewayConnectionTestResult}. */
export type SlackTestResult = GatewayConnectionTestResult;

/**
 * Identity of the Slack app behind a channel's bot token, resolved server-side
 * via `auth.test` → `bots.info` (which only needs the baseline `users:read`
 * scope). Fields are null when resolution fails — never an error — so callers
 * can degrade to a generic Slack link. Never carries token material.
 */
export interface SlackAppInfo {
  appId: string | null;
  teamId: string | null;
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

interface GatewayAgenticConfigBase {
  agent: AgenticToolName;
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

type ReferencedGatewayAgenticConfig = {
  /** Live preset/default reference. */
  presetId: AgenticToolConfigurationReference;
  modelConfig?: never;
  permissionMode?: never;
  codexSandboxMode?: never;
  codexApprovalPolicy?: never;
  codexNetworkAccess?: never;
};

type InlineGatewayAgenticConfig = {
  presetId?: never;
  modelConfig?: DefaultModelConfig;
  permissionMode?: PermissionMode;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: boolean;
};

export type GatewayAgenticConfig = GatewayAgenticConfigBase &
  (ReferencedGatewayAgenticConfig | InlineGatewayAgenticConfig);

/** Storage-facing gateway configuration, including readable removed identifiers. */
export type PersistedGatewayAgenticConfig = GatewayAgenticConfigBase & {
  agent: PersistedAgenticToolName;
  presetId?: AgenticToolConfigurationReference;
  modelConfig?: DefaultModelConfig | NonNullable<Session['model_config']>;
  permissionMode?: PermissionMode;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: boolean;
};

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
  agentic_config: PersistedGatewayAgenticConfig | null; // Session creation settings
  /** MCP servers attached independently of the agentic-tool configuration. */
  mcp_server_ids?: string[];
  enabled: boolean;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  last_message_at: string | null;
}

/**
 * Public create DTO.
 *
 * Runtime-owned identity, audit, secret, and activity fields are deliberately
 * omitted, and persisted legacy tools remain read-only. The minimum channel
 * definition is required instead of relying on repository placeholder values.
 */
export interface GatewayChannelCreateData {
  name: string;
  channel_type: ChannelType;
  target_branch_id: BranchID;
  agor_user_id?: UserID;
  config: Record<string, unknown>;
  agentic_config?: GatewayAgenticConfig | null;
  mcp_server_ids?: string[];
  enabled?: boolean;
}

/** Public partial-update DTO. PUT-style replacement is intentionally unsupported. */
export type GatewayChannelPatchData = Partial<GatewayChannelCreateData>;

type ExhaustiveWriteFields<T, Fields extends readonly (keyof T)[]> =
  Exclude<keyof T, Fields[number]> extends never ? Fields : never;

const GATEWAY_CHANNEL_WRITE_FIELD_VALUES = [
  'name',
  'channel_type',
  'target_branch_id',
  'agor_user_id',
  'config',
  'agentic_config',
  'mcp_server_ids',
  'enabled',
] as const;

/** Canonical, compile-time-exhaustive allowlist for gateway creates and patches. */
export const GATEWAY_CHANNEL_WRITE_FIELDS: ExhaustiveWriteFields<
  GatewayChannelCreateData & GatewayChannelPatchData,
  typeof GATEWAY_CHANNEL_WRITE_FIELD_VALUES
> = GATEWAY_CHANNEL_WRITE_FIELD_VALUES;

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

/** Durable admission of one proactive seed into the session-creation path. */
export interface GatewayOutboundReplyAdmission {
  message: GatewayOutboundMessage;
  sessionId: SessionID;
  /** True only for the transaction that first reserved the session ID. */
  admitted: boolean;
}

/**
 * Durable provider-event occurrence used to deduplicate listener redelivery.
 *
 * The processing token is an internal fence and is never exposed through a
 * public service. Provider payloads and credentials are deliberately not
 * stored here; connectors recover them from the provider using their durable
 * channel checkpoint.
 */
export interface GatewayInboundEvent {
  id: GatewayInboundEventID;
  gateway_channel_id: GatewayChannelID;
  provider_event_id: string;
  thread_id: string;
  /** Provider acknowledgement/reply coordinates recorded after preparation. */
  delivery_metadata: Record<string, unknown> | null;
  status: GatewayInboundEventStatus;
  processing_token: string;
  processing_expires_at: string;
  session_id: SessionID | null;
  task_id: TaskID | null;
  received_at: string;
  completed_at: string | null;
}
