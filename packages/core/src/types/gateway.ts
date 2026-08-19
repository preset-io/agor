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
import type { BranchID, MessageID, SessionID, TaskID, UserID, UUID } from './id';
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

/** Durable provider-action outbox row identifier. */
export type GatewayProviderActionID = UUID;

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
  'discord',
  'github',
  'shortcut',
] as const satisfies readonly ChannelType[];

/** Thread lifecycle status */
export type ThreadStatus = 'active' | 'archived' | 'paused';

/** Internal processing state for a provider event idempotency occurrence. */
export type GatewayInboundEventStatus = 'processing' | 'completed';

/** Narrow durable provider actions. Provider-rendered content is never persisted here. */
export type GatewayProviderActionKind =
  | 'deliver_message'
  | 'discord_progress'
  | 'discord_notice'
  | 'discord_thread_history';

/** Durable lifecycle for one at-least-once provider action. */
export type GatewayProviderActionStatus =
  | 'pending'
  | 'processing'
  | 'retry'
  | 'completed'
  | 'dead_letter'
  | 'canceled';

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
    case 'discord':
      // Discord launch uses one bot token for both Gateway WSS and REST.
      // Disabled drafts may omit it, but there is no enabled outbound-only
      // exception: mention delivery and reconciliation both authenticate as
      // the bot installation.
      return ['bot_token'];
    case 'teams':
      return ['app_password'];
    case 'shortcut':
      // Shortcut is poll-based over the REST API — the API token is always
      // required for an enabled channel (there is no outbound-only mode).
      return ['api_token'];
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
// Discord Configuration
// ============================================================================

/**
 * Discord Snowflakes are opaque unsigned 64-bit decimal strings.
 *
 * Keep them as strings at every boundary: coercing a Snowflake to a JavaScript
 * number loses precision and can route a message to the wrong conversation.
 * Syntax/range validation lives in the browser-safe Discord config helper.
 */
export type DiscordSnowflake = string;

/** Launch-supported Discord thread materialization policy. */
export type DiscordThreadMode = 'public_thread_per_summon';

/**
 * Agent-callable Discord capabilities.
 *
 * Names/defaults deliberately match Slack. At launch only mapped current
 * thread history is enabled; every broader read/write surface remains an
 * independently reviewed capability.
 */
export interface DiscordAgentToolsConfig {
  thread_history?: boolean;
  channel_history?: boolean;
  reactions?: boolean;
  file_upload?: boolean;
  file_download?: boolean;
}

export type DiscordAgentToolCapability = keyof DiscordAgentToolsConfig;

export const DISCORD_AGENT_TOOL_DEFAULTS: Record<DiscordAgentToolCapability, boolean> = {
  thread_history: true,
  channel_history: false,
  reactions: false,
  file_upload: false,
  file_download: false,
};

/** Resolve possibly absent/malformed Discord tool toggles to launch defaults. */
export function resolveDiscordAgentTools(
  raw: unknown
): Record<DiscordAgentToolCapability, boolean> {
  const config =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const resolved = { ...DISCORD_AGENT_TOOL_DEFAULTS };
  for (const capability of Object.keys(resolved) as DiscordAgentToolCapability[]) {
    if (typeof config[capability] === 'boolean') {
      resolved[capability] = config[capability] as boolean;
    }
  }
  return resolved;
}

/**
 * Canonical launch configuration for a dedicated Discord bot installation.
 *
 * The token is the only launch secret and is encrypted/redacted by the shared
 * gateway repository. User alignment maps exact provider IDs to stable Agor
 * user IDs; Discord display names are never authentication inputs.
 */
export interface DiscordGatewayConfig {
  bot_token?: string;
  application_id: DiscordSnowflake;
  guild_id: DiscordSnowflake;
  /** Exact parent guild text/forum channel IDs. Empty never means "all". */
  allowed_channel_ids: DiscordSnowflake[];
  /** User alignment defaults on and fails closed for unmapped Discord users. */
  align_discord_users: boolean;
  user_map?: Record<DiscordSnowflake, UserID>;
  ingest_files?: boolean;
  thread_mode: DiscordThreadMode;
  agent_tools?: DiscordAgentToolsConfig;
  /** Reserved for a separately approved flat-DM routing design. */
  enable_dms?: false;
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

/**
 * Result of a best-effort gateway connector connection probe.
 *
 * Probes exercise real platform calls but cannot prove everything about a
 * working installation. `notVerifiable` enumerates what green does NOT
 * guarantee; connector-specific optional fields carry richer details.
 */
export interface GatewayConnectionTestResult {
  ok: boolean;
  /** Token-authenticated provider identity, present only after exact binding verification. */
  providerInstallationId?: string;
  team?: { id: string; name: string };
  bot?: { userId: string; name: string };
  appTokenValid?: boolean;
  channelAccess?: { channelId: string; ok: boolean }[];
  failures: GatewayConnectionTestFailure[];
  notVerifiable: string[];
}

/** Sanitized result of the reviewed Discord current-application mutation. */
export interface GatewayDiscordApplicationSettingsApplyResult {
  ok: boolean;
  /** PATCH may have succeeded after the setup fence was lost; never authorize from this result. */
  ambiguous: boolean;
  requiresRetest: boolean;
  applicationId: DiscordSnowflake;
  installUrl: string;
  messageContentAccess: boolean;
  guildInstallDefaults: boolean;
  intentNames: readonly string[];
  permissionNames: readonly string[];
  permissions: string;
  code: 'applied' | 'configuration_changed_after_apply';
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
  /** Token-verified system-global provider identity; never accepted from public writes. */
  provider_installation_id: string | null;
  /** Runtime-owned revision for outbound-authorizing provider configuration. */
  provider_config_generation: number;
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
 * Small validated parameters for a canonical-message delivery action.
 *
 * The message body and Discord payload are deliberately absent. The owner
 * reloads and renders the canonical Agor message at execution time.
 */
export interface GatewayDeliverMessageActionParams {
  operation: 'create' | 'edit';
  /** Required only for an idempotent edit of an already-known provider row. */
  provider_message_id?: string;
}

export type GatewayDiscordProgressState = 'queued' | 'working' | 'failed' | 'done';

/**
 * Sanitized desired state for one Discord task activity row.
 *
 * The owner renders fixed product copy. Tool inputs, paths, URLs, user text,
 * and provider payloads are deliberately absent.
 */
export interface GatewayDiscordProgressActionParams {
  state: GatewayDiscordProgressState;
  revision: number;
  tool_name?: string;
  /** Set only when ephemeral display work was converted to durable cleanup. */
  cleanup_reason?: 'activity_expired';
}

/** Fixed, content-free Discord routing outcomes that are safe to render later. */
export type GatewayDiscordNoticeCode =
  | 'alignment_missing'
  | 'alignment_inactive'
  | 'mapped_owner_mismatch'
  | 'branch_access_denied'
  | 'fixed_identity_invalid';

/** No provider/user text or arbitrary payload is permitted in a routing notice. */
export interface GatewayDiscordNoticeActionParams {
  notice_code: GatewayDiscordNoticeCode;
}

/** Bounded, content-free parameters for one same-session Discord history RPC. */
export interface GatewayDiscordThreadHistoryActionParams {
  request_id: UUID;
  initial_message_id: DiscordSnowflake;
  through_message_id: DiscordSnowflake;
  after_message_id?: DiscordSnowflake;
  limit: number;
}

export type GatewayProviderActionParams =
  | GatewayDeliverMessageActionParams
  | GatewayDiscordProgressActionParams
  | GatewayDiscordNoticeActionParams
  | GatewayDiscordThreadHistoryActionParams;

/** One frozen formatter descriptor plus its independently durable Discord row. */
export interface GatewayDiscordDeliveryChunkCheckpoint {
  index: number;
  descriptor_sha256: string;
  provider_message_id?: string;
}

/** The only launch attachment shape: the canonical response as bounded Markdown. */
export interface GatewayDiscordDeliveryOverflowCheckpoint {
  chunk_index: number;
  filename: 'agor-response.md';
  content_sha256: string;
  byte_length: number;
}

/** Content-free operator audit attached only by an explicit repair transition. */
export interface GatewayDiscordDeliveryRepairAudit {
  outcome: 'coordinates_recorded' | 'abandoned';
  operator_user_id: UserID;
  repaired_at: string;
}

/**
 * Frozen, bounded Discord delivery execution state.
 *
 * Rendered chunks and attachment bytes never enter the outbox. Hashes make a
 * formatter/source change after a partial external side effect fail closed.
 */
export interface GatewayDiscordDeliveryExecutionMetadata {
  kind: 'discord_delivery';
  formatter_version: number;
  source_sha256: string;
  chunks: GatewayDiscordDeliveryChunkCheckpoint[];
  overflow_attachment?: GatewayDiscordDeliveryOverflowCheckpoint;
  repair?: GatewayDiscordDeliveryRepairAudit;
}

export type GatewayProviderActionExecutionMetadata = GatewayDiscordDeliveryExecutionMetadata;

/** Action-specific sanitized result coordinates; never provider content or errors. */
export type GatewayProviderActionResultMetadata =
  | {
      kind: 'deliver_message';
      provider_message_id: string;
    }
  | {
      kind: 'discord_progress';
      outcome: 'upserted';
      provider_message_id: string;
    }
  | {
      kind: 'discord_progress';
      outcome: 'cleaned' | 'noop';
      reason?: 'activity_expired';
    }
  | {
      kind: 'discord_notice';
      provider_message_id: string;
    }
  | {
      kind: 'discord_thread_history';
      upload_ref: string;
      sha256: string;
      byte_length: number;
      message_count: number;
      has_more: boolean;
      next_message_id?: DiscordSnowflake;
    };

/**
 * Tenant-owned provider-action outbox row.
 *
 * Listener ownership is snapshotted only while the action is claimed. The
 * durable authorization binding is provider installation + config generation,
 * so valid pending finals survive a healthy listener takeover.
 */
export interface GatewayProviderAction {
  id: GatewayProviderActionID;
  gateway_channel_id: GatewayChannelID;
  channel_type: ChannelType;
  provider_installation_id: string;
  provider_config_generation: number;
  kind: GatewayProviderActionKind;
  idempotency_key: string;
  thread_session_map_id: ThreadSessionMapID | null;
  session_id: SessionID | null;
  task_id: TaskID | null;
  message_id: MessageID | null;
  gateway_inbound_event_id: GatewayInboundEventID | null;
  params: GatewayProviderActionParams;
  status: GatewayProviderActionStatus;
  attempts: number;
  not_before: string;
  /** DB-issued expiry for display work; terminal cleanup/finals never set it. */
  drop_after: string | null;
  claim_token: string | null;
  claim_generation: number;
  claim_expires_at: string | null;
  claim_listener_token: string | null;
  claim_listener_generation: number | null;
  claim_instance_id: string | null;
  claim_boot_id: string | null;
  last_error_code: string | null;
  execution_metadata: GatewayProviderActionExecutionMetadata | null;
  result_metadata: GatewayProviderActionResultMetadata | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  dead_lettered_at: string | null;
  canceled_at: string | null;
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
