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
import { isCanonicalUuidV7 } from './id';
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

/** Durable identity for one Discord assistant-message delivery attempt. */
export type DiscordMessageDeliveryID = UUID;

/** Durable identity for one Teams assistant-message delivery intent. */
export type TeamsMessageDeliveryID = UUID;

/** Durable identity for one encrypted Teams conversation address. */
export type TeamsConversationAddressID = UUID;

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
export type GatewayInboundEventStatus = 'pending' | 'processing' | 'completed' | 'dead_letter';

export type DiscordMessageDeliveryStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'canceled'
  | 'dead_letter';

/** Bounded, content-free receipt for one Discord delivery chunk. */
export interface DiscordMessageDeliveryChunkReceipt {
  chunk_index: number;
  nonce: string;
  provider_message_id: string;
  reply_aliases: string[];
}

export interface DiscordMessageDelivery {
  delivery_id: DiscordMessageDeliveryID;
  message_id: UUID;
  gateway_channel_id: GatewayChannelID;
  thread_session_map_id: ThreadSessionMapID;
  provider_installation_id: string;
  provider_config_generation: number;
  status: DiscordMessageDeliveryStatus;
  attempt_count: number;
  next_attempt_at: string;
  claim_token: string | null;
  claim_expires_at: string | null;
  claim_generation: number;
  /** Chunk whose provider effect may have started but lacks a durable receipt. */
  ambiguous_chunk_index: number | null;
  /** Durable fence timestamp written before the nonce-protected provider call. */
  effect_started_at: string | null;
  /** Recovery must remain retryable until this persisted instant. */
  effect_recovery_grace_until: string | null;
  chunk_receipts: DiscordMessageDeliveryChunkReceipt[];
  reply_aliases: string[];
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  canceled_at: string | null;
  dead_lettered_at: string | null;
}

export type TeamsMessageDeliveryStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'canceled'
  | 'ambiguous'
  | 'dead_letter';

/** Narrow durable intent for one Teams assistant message. */
export interface TeamsMessageDelivery {
  delivery_id: TeamsMessageDeliveryID;
  message_id: UUID;
  gateway_channel_id: GatewayChannelID;
  thread_session_map_id: ThreadSessionMapID;
  provider_installation_id: string;
  provider_config_generation: number;
  status: TeamsMessageDeliveryStatus;
  attempt_count: number;
  next_attempt_at: string;
  claim_token: string | null;
  claim_expires_at: string | null;
  claim_generation: number;
  effect_started_at: string | null;
  last_error_code: string | null;
  provider_message_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  canceled_at: string | null;
  dead_lettered_at: string | null;
}

/** Encrypted, refreshed Bot Framework conversation address. */
export interface TeamsConversationAddress {
  address_id: TeamsConversationAddressID;
  gateway_channel_id: GatewayChannelID;
  thread_id: string;
  conversation_id: string;
  root_message_id: string | null;
  encrypted_address: string;
  verified_app_id: string;
  verified_tenant_id: string;
  provider_config_generation: number;
  refreshed_at: string;
  expires_at: string | null;
}

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

/** Canonical Teams gateway configuration. Legacy per-port fields are ignored. */
export type TeamsUserMap = Record<string, UserID>;

export interface TeamsGatewayConfig {
  app_id?: string;
  app_password?: string;
  microsoft_tenant_id?: string;
  allowed_team_ids?: string[];
  allowed_channel_ids?: string[];
  allowed_user_aad_object_ids?: string[];
  /** AAD object ID → tenant-owned immutable Agor User ID. */
  user_map?: TeamsUserMap;
  require_mention?: boolean;
  allow_thread_replies_without_mention?: boolean;
  catch_up?: TeamsCatchUpConfig;
  outbound_enabled?: boolean;
  /** Accepted during migration only; no runtime effect. */
  tenant_id?: string;
  webhook_port?: number;
  webhook_path?: string;
}

export interface TeamsCatchUpConfig {
  mode: 'off' | 'best_effort';
  max_messages: number;
  max_prompt_bytes: number;
  request_timeout_ms: number;
}

export const DEFAULT_TEAMS_CATCH_UP: TeamsCatchUpConfig = {
  mode: 'best_effort',
  max_messages: 50,
  max_prompt_bytes: 16 * 1024,
  request_timeout_ms: 2_000,
};

export const MIN_TEAMS_CATCH_UP: TeamsCatchUpConfig = {
  mode: 'off',
  max_messages: 1,
  max_prompt_bytes: 1,
  request_timeout_ms: 1,
};

export const MAX_TEAMS_CATCH_UP: TeamsCatchUpConfig = {
  mode: 'best_effort',
  max_messages: 100,
  max_prompt_bytes: 64 * 1024,
  request_timeout_ms: 5_000,
};

export interface TeamsConfigValidationResult {
  ok: boolean;
  errors: string[];
}

function isTeamsRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTeamsId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,256}$/.test(value.trim());
}

function validateTeamsList(
  raw: Record<string, unknown>,
  field: 'allowed_team_ids' | 'allowed_channel_ids' | 'allowed_user_aad_object_ids',
  errors: string[]
): void {
  const value = raw[field];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => !isTeamsId(item))) {
    errors.push(`${field} must contain only nonempty Teams identifiers`);
  }
}

/** Validate Teams AAD object ID mappings to canonical tenant-owned User IDs. */
export function validateTeamsUserMap(value: unknown): TeamsConfigValidationResult {
  if (value === undefined) return { ok: true, errors: [] };
  if (!isTeamsRecord(value)) {
    return {
      ok: false,
      errors: ['user_map must map Teams AAD object IDs to full lowercase UUIDv7 Agor User IDs'],
    };
  }
  for (const [aadId, userId] of Object.entries(value)) {
    if (!isTeamsId(aadId) || !isCanonicalUuidV7(userId)) {
      return {
        ok: false,
        errors: ['user_map must map Teams AAD object IDs to full lowercase UUIDv7 Agor User IDs'],
      };
    }
  }
  return { ok: true, errors: [] };
}

/** Apply safe defaults without importing a provider SDK. */
export function withTeamsConfigDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const catchUp = isTeamsRecord(raw.catch_up)
    ? { ...DEFAULT_TEAMS_CATCH_UP, ...raw.catch_up }
    : { ...DEFAULT_TEAMS_CATCH_UP };
  return {
    ...raw,
    require_mention: raw.require_mention ?? true,
    allow_thread_replies_without_mention: raw.allow_thread_replies_without_mention ?? true,
    catch_up: catchUp,
    outbound_enabled: raw.outbound_enabled ?? true,
  };
}

/** Validate the non-secret, canonical Teams configuration at every write path. */
export function validateTeamsConfig(
  raw: Record<string, unknown>,
  options: { requireAppPassword?: boolean } = {}
): TeamsConfigValidationResult {
  const errors: string[] = [];
  if (
    typeof raw.app_id !== 'string' ||
    !raw.app_id.trim() ||
    raw.app_id === GATEWAY_REDACTED_SENTINEL
  ) {
    errors.push('app_id is required');
  }
  if (typeof raw.microsoft_tenant_id !== 'string' || !raw.microsoft_tenant_id.trim()) {
    errors.push('microsoft_tenant_id is required');
  }
  if (
    options.requireAppPassword !== false &&
    (typeof raw.app_password !== 'string' ||
      !raw.app_password.trim() ||
      raw.app_password === GATEWAY_REDACTED_SENTINEL)
  ) {
    errors.push('app_password is required');
  }
  for (const field of [
    'allowed_team_ids',
    'allowed_channel_ids',
    'allowed_user_aad_object_ids',
  ] as const) {
    validateTeamsList(raw, field, errors);
  }
  errors.push(...validateTeamsUserMap(raw.user_map).errors);
  if (typeof raw.require_mention !== 'boolean') errors.push('require_mention must be a boolean');
  if (typeof raw.allow_thread_replies_without_mention !== 'boolean') {
    errors.push('allow_thread_replies_without_mention must be a boolean');
  }
  if (typeof raw.outbound_enabled !== 'boolean') errors.push('outbound_enabled must be a boolean');
  if (!isTeamsRecord(raw.catch_up)) {
    errors.push('catch_up must be an object');
  } else {
    const mode = raw.catch_up.mode;
    if (mode !== 'off' && mode !== 'best_effort')
      errors.push('catch_up.mode must be off or best_effort');
    for (const key of ['max_messages', 'max_prompt_bytes', 'request_timeout_ms'] as const) {
      const value = raw.catch_up[key];
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < MIN_TEAMS_CATCH_UP[key] ||
        value > MAX_TEAMS_CATCH_UP[key]
      ) {
        errors.push(`catch_up.${key} must be a bounded integer`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Discord gateway configuration used by both the browser wizard and daemon. */
export interface DiscordGatewayConfig {
  bot_token?: string;
  application_id?: string;
  guild_id?: string;
  allowed_channel_ids?: string[];
  allowed_user_ids?: string[];
  allowed_role_ids?: string[];
  message_content_enabled?: boolean;
  thread_mode?: 'public_thread_per_summon';
  thread_auto_archive_minutes?: 60 | 1440 | 4320 | 10080;
  align_discord_users?: boolean;
  user_map?: Record<string, string>;
  catch_up?: DiscordCatchUpConfig;
  files?: false;
  agent_tools?: never[];
  outbound_enabled?: boolean;
  default_outbound_target?: string | null;
}

/**
 * Provider coordinates for a verified Discord public thread.
 *
 * These are deliberately structured instead of being encoded into the
 * legacy `discord:thread:<parent>:<thread>` mapping identity.  The provider
 * thread Snowflake remains the canonical mapping key; this object is the
 * durable proof that the key belongs to the configured public surface.
 */
export interface DiscordThreadCoordinates {
  guild_id: string;
  parent_channel_id: string;
  thread_channel_id: string;
  starter_message_id: string;
}

export function isDiscordThreadCoordinates(value: unknown): value is DiscordThreadCoordinates {
  if (!isRecord(value)) return false;
  return (
    isDiscordSnowflake(value.guild_id) &&
    isDiscordSnowflake(value.parent_channel_id) &&
    isDiscordSnowflake(value.thread_channel_id) &&
    isDiscordSnowflake(value.starter_message_id)
  );
}

/** Bounded, provider-independent controls for a future Discord catch-up pass. */
export interface DiscordCatchUpConfig {
  max_pages: number;
  max_messages: number;
  max_prompt_bytes: number;
  request_timeout_ms: number;
  rate_limit_max_retries: number;
  rate_limit_max_total_delay_ms: number;
}

export const DEFAULT_DISCORD_CATCH_UP: DiscordCatchUpConfig = {
  max_pages: 5,
  max_messages: 200,
  max_prompt_bytes: 32 * 1024,
  request_timeout_ms: 30_000,
  rate_limit_max_retries: 2,
  rate_limit_max_total_delay_ms: 10_000,
};

export const MIN_DISCORD_CATCH_UP: DiscordCatchUpConfig = {
  max_pages: 1,
  max_messages: 1,
  max_prompt_bytes: 1,
  request_timeout_ms: 1,
  rate_limit_max_retries: 0,
  rate_limit_max_total_delay_ms: 0,
};

export const MAX_DISCORD_CATCH_UP: DiscordCatchUpConfig = {
  max_pages: 10,
  max_messages: 500,
  max_prompt_bytes: 128 * 1024,
  request_timeout_ms: 60_000,
  rate_limit_max_retries: 5,
  rate_limit_max_total_delay_ms: 30_000,
};

export interface DiscordConfigValidationResult {
  ok: boolean;
  errors: string[];
}

const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;
const MAX_DISCORD_SNOWFLAKE = 18_446_744_073_709_551_615n;

/** Discord snowflakes are unsigned 64-bit decimal identifiers. */
export function isDiscordSnowflake(value: unknown): value is string {
  if (typeof value !== 'string' || !DISCORD_SNOWFLAKE_RE.test(value)) return false;
  if (value.startsWith('0')) return false;
  try {
    return BigInt(value) <= MAX_DISCORD_SNOWFLAKE;
  } catch {
    return false;
  }
}

/** Compare two already-validated Discord Snowflakes without losing precision. */
export function compareDiscordSnowflakes(a: string, b: string): number {
  if (!isDiscordSnowflake(a) || !isDiscordSnowflake(b)) {
    throw new Error('Discord Snowflake comparison requires canonical Snowflakes');
  }
  const left = BigInt(a);
  const right = BigInt(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateCatchUpConfig(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    errors.push('catch_up must be an object');
    return;
  }
  for (const key of Object.keys(DEFAULT_DISCORD_CATCH_UP) as Array<keyof DiscordCatchUpConfig>) {
    const value = raw[key];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < MIN_DISCORD_CATCH_UP[key] ||
      value > MAX_DISCORD_CATCH_UP[key]
    ) {
      errors.push(
        `catch_up.${key} must be an integer between ${MIN_DISCORD_CATCH_UP[key]} and ${MAX_DISCORD_CATCH_UP[key]}`
      );
    }
  }
}

/** Fill only non-authority defaults; Message Content and identity stay explicit. */
export function withDiscordConfigDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const catchUp = isRecord(raw.catch_up)
    ? { ...DEFAULT_DISCORD_CATCH_UP, ...raw.catch_up }
    : { ...DEFAULT_DISCORD_CATCH_UP };
  return {
    ...raw,
    catch_up: catchUp,
    files: raw.files ?? false,
    agent_tools: raw.agent_tools ?? [],
  };
}

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
    if (!isDiscordSnowflake(value)) {
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
    rawAllowedChannelIds.some((item) => !isDiscordSnowflake(item))
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
    if (value.some((item) => !isDiscordSnowflake(item))) {
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

  if (raw.message_content_enabled !== true) {
    errors.push('message_content_enabled must be true');
  }
  if (raw.thread_mode !== 'public_thread_per_summon') {
    errors.push('thread_mode must be public_thread_per_summon');
  }
  if (
    raw.thread_auto_archive_minutes !== undefined &&
    ![60, 1440, 4320, 10080].includes(raw.thread_auto_archive_minutes as number)
  ) {
    errors.push('thread_auto_archive_minutes must be one of 60, 1440, 4320, or 10080');
  }
  if (typeof raw.align_discord_users !== 'boolean') {
    errors.push('align_discord_users must be a boolean');
  }
  if (raw.user_map !== undefined) {
    if (!isRecord(raw.user_map)) {
      errors.push('user_map must map Discord user snowflakes to Agor emails');
    } else {
      const entries = Object.entries(raw.user_map);
      if (raw.align_discord_users === true && entries.length === 0) {
        errors.push('user_map must contain at least one entry when align_discord_users is true');
      }
      for (const [discordUserId, email] of entries) {
        if (!isDiscordSnowflake(discordUserId) || typeof email !== 'string' || !email.trim()) {
          errors.push('user_map must map Discord user snowflakes to nonempty Agor emails');
          break;
        }
      }
      if (raw.align_discord_users === false) {
        errors.push('user_map is only allowed when align_discord_users is true');
      }
    }
  } else if (raw.align_discord_users === true) {
    errors.push('user_map must contain at least one entry when align_discord_users is true');
  }

  validateCatchUpConfig(raw.catch_up, errors);
  if (raw.files !== undefined && raw.files !== false) {
    errors.push('files must be false');
  }
  if (
    raw.agent_tools !== undefined &&
    (!Array.isArray(raw.agent_tools) || raw.agent_tools.length > 0)
  ) {
    errors.push('agent_tools must be an empty array');
  }

  if (raw.outbound_enabled !== undefined && typeof raw.outbound_enabled !== 'boolean') {
    errors.push('outbound_enabled must be a boolean');
  }
  if (raw.default_outbound_target !== undefined && raw.default_outbound_target !== null) {
    if (typeof raw.default_outbound_target !== 'string') {
      errors.push('default_outbound_target must be channel:<snowflake>');
    } else {
      const match = /^channel:(\d{17,20})$/.exec(raw.default_outbound_target.trim());
      if (!match || !isDiscordSnowflake(match[1]) || !allowedChannelIds.includes(match[1])) {
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
  createPublicThreads: boolean;
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
  /** Provider-owned identity verified by the connector; never client supplied. */
  verifiedInstallationId?: string;
  appTokenValid?: boolean;
  channelAccess?: GatewayConnectionTestChannelAccess[];
  /** Provider verification state. Discord uses `warning` when a required
   * capability could not be determined; warnings never authorize enablement. */
  verification?: {
    status: 'verified' | 'warning';
    warnings: string[];
  };
  failures: GatewayConnectionTestFailure[];
  notVerifiable: string[];
}

export interface GatewayCredentialPresentation {
  label: string;
  placeholder: string;
  hint?: string;
  /** Optional provider-specific prefix for light client-side validation. */
  prefix?: string;
}

/** Browser-safe provider-aware presentation for write-only gateway secrets. */
export function getGatewayCredentialPresentation(
  channelType: ChannelType,
  field: string
): GatewayCredentialPresentation {
  if (channelType === 'discord' && field === 'bot_token') {
    return {
      label: 'Discord bot token',
      placeholder: 'Discord bot token',
      hint: 'Discord bot token from Developer Portal → Bot. It is never returned.',
    };
  }
  if (channelType === 'slack' && field === 'bot_token') {
    return {
      label: 'Bot token',
      placeholder: 'xoxb-…',
      hint: 'Slack bot token, starts with xoxb-',
      prefix: 'xoxb-',
    };
  }
  if (channelType === 'slack' && field === 'app_token') {
    return {
      label: 'App-level token',
      placeholder: 'xapp-…',
      hint: 'Slack app-level token for Socket Mode, starts with xapp-',
      prefix: 'xapp-',
    };
  }
  const fallback: Record<string, GatewayCredentialPresentation> = {
    private_key: {
      label: 'Private key',
      placeholder: '-----BEGIN PRIVATE KEY-----',
      hint: 'GitHub App private key (PEM)',
    },
    app_password: {
      label: 'App password',
      placeholder: 'Teams app password',
      hint: 'Microsoft Teams app password',
    },
    signing_secret: { label: 'Signing secret', placeholder: 'Signing secret' },
    webhook_secret: { label: 'Webhook secret', placeholder: 'Webhook secret' },
  };
  return fallback[field] ?? { label: field, placeholder: `Enter ${field}` };
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
  /** Nullable for explicitly aligned Discord identity mode. */
  agor_user_id: UserID | null;
  /** Verified token-owned provider identity, materialized server-side. */
  provider_installation_id: string | null;
  /** Authority-bearing provider config generation. */
  provider_config_generation: number;
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
  agor_user_id?: UserID | null;
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

/** Merge one public config patch with the decrypted stored configuration. */
export function mergeGatewayChannelConfigPatch(
  currentConfig: Record<string, unknown>,
  patchConfig: Record<string, unknown> | undefined,
  channelType: ChannelType,
  enabled: boolean
): Record<string, unknown> {
  const merged = { ...currentConfig, ...(patchConfig ?? {}) };
  for (const field of GATEWAY_SENSITIVE_CONFIG_FIELDS) {
    const updateValue = patchConfig?.[field];
    if ((!updateValue || updateValue === GATEWAY_REDACTED_SENTINEL) && currentConfig[field]) {
      merged[field] = currentConfig[field];
    }
  }
  if (channelType === 'discord' && enabled) return withDiscordConfigDefaults(merged);
  if (channelType === 'teams' && enabled) return withTeamsConfigDefaults(merged);
  return merged;
}

/** A Teams app password rotation keeps the provider authority unchanged. */
export function isTeamsCredentialOnlyConfigPatch(patch: {
  config?: Record<string, unknown>;
}): boolean {
  if (Object.keys(patch).length !== 1 || !patch.config || Array.isArray(patch.config)) return false;
  const keys = Object.keys(patch.config);
  return keys.length === 1 && keys[0] === 'app_password';
}

/** Fields that change the provider authority generation and binding. */
export function isGatewayProviderAuthorityPatch(patch: {
  enabled?: boolean;
  config?: Record<string, unknown>;
  channel_type?: ChannelType;
  agor_user_id?: UserID | null;
}): boolean {
  return (
    patch.enabled !== undefined ||
    patch.config !== undefined ||
    patch.channel_type !== undefined ||
    patch.agor_user_id !== undefined
  );
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
  /** Last Discord message ID whose mention Task was durably admitted. */
  discord_last_admitted_message_id: string | null;
  /** Last Teams activity ID whose mention Task was durably admitted. */
  teams_last_admitted_activity_id: string | null;
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
  /** Encrypted normalized payload, populated only for verified HTTP ingress. */
  payload_encrypted: string | null;
  payload_expires_at: string | null;
  provider_config_generation: number;
  verified_app_id: string | null;
  verified_tenant_id: string | null;
  attempt_count: number;
  next_attempt_at: string;
  last_error_code: string | null;
  session_id: SessionID | null;
  task_id: TaskID | null;
  received_at: string;
  completed_at: string | null;
}
