import {
  type DiscordAgentToolsConfig,
  type DiscordGatewayConfig,
  type DiscordSnowflake,
  GATEWAY_REDACTED_SENTINEL,
  resolveDiscordAgentTools,
} from '../../types/gateway';
import { isCanonicalFullUuid } from '../../types/id';

const DISCORD_SNOWFLAKE_MAX = (1n << 64n) - 1n;
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** Launch bounds keep setup, probe, and reconciliation work predictably finite. */
export const DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES = 100;
export const DISCORD_USER_MAP_MAX_ENTRIES = 1_000;
export const DISCORD_BOT_TOKEN_MAX_BYTES = 512;
export const DISCORD_GATEWAY_CONFIG_MAX_BYTES = 128 * 1_024;

const DISCORD_CONFIG_FIELDS = new Set([
  'bot_token',
  'application_id',
  'guild_id',
  'allowed_channel_ids',
  'align_discord_users',
  'user_map',
  'ingest_files',
  'thread_mode',
  'agent_tools',
  'enable_dms',
]);

const DISCORD_AGENT_TOOL_FIELDS = new Set([
  'thread_history',
  'channel_history',
  'reactions',
  'file_upload',
  'file_download',
]);

export interface ParseDiscordGatewayConfigOptions {
  /** Enabled channels require the bot secret; disabled drafts do not. */
  enabled?: boolean;
  /** Required when User alignment is disabled (the channel's Run as user). */
  agorUserId?: unknown;
  /** Provider-only connector construction does not own the channel user field. */
  requireRunAsUser?: boolean;
}

export class DiscordGatewayConfigError extends Error {
  constructor(message: string) {
    super(`Invalid Discord gateway config: ${message}`);
    this.name = 'DiscordGatewayConfigError';
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** True only for canonical, positive unsigned 64-bit decimal Snowflakes. */
export function isDiscordSnowflake(value: unknown): value is DiscordSnowflake {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) return false;
  try {
    return BigInt(value) <= DISCORD_SNOWFLAKE_MAX;
  } catch {
    return false;
  }
}

/** Compare Snowflakes without coercing them through an unsafe JS number. */
export function compareDiscordSnowflakes(
  a: DiscordSnowflake | undefined,
  b: DiscordSnowflake | undefined
): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const left = BigInt(a);
  const right = BigInt(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Lowest possible Discord Snowflake at a provider timestamp boundary. */
export function discordSnowflakeLowerBound(timestampMs: number): DiscordSnowflake {
  if (!Number.isSafeInteger(timestampMs) || BigInt(timestampMs) < DISCORD_EPOCH_MS) {
    throw new Error('Invalid Discord Snowflake timestamp boundary');
  }
  const value = (BigInt(timestampMs) - DISCORD_EPOCH_MS) << 22n;
  if (value <= 0n || value > DISCORD_SNOWFLAKE_MAX) {
    throw new Error('Discord Snowflake timestamp boundary is out of range');
  }
  return value.toString();
}

/** Exclusive REST `after` cursor immediately before one known Snowflake. */
export function discordSnowflakePredecessor(value: DiscordSnowflake): DiscordSnowflake {
  if (!isDiscordSnowflake(value)) throw new Error('Invalid Discord Snowflake');
  const predecessor = BigInt(value) - 1n;
  if (predecessor <= 0n) throw new Error('Discord Snowflake has no positive predecessor');
  return predecessor.toString();
}

function requireSnowflake(value: unknown, label: string): DiscordSnowflake {
  if (!isDiscordSnowflake(value)) {
    throw new DiscordGatewayConfigError(`${label} must be a canonical Discord Snowflake`);
  }
  return value;
}

function parseAgentTools(value: unknown): DiscordAgentToolsConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DiscordGatewayConfigError('agent_tools must be an object');
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !DISCORD_AGENT_TOOL_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new DiscordGatewayConfigError(`unsupported agent_tools field ${unknown[0]}`);
  }
  for (const [key, enabled] of Object.entries(raw)) {
    if (typeof enabled !== 'boolean') {
      throw new DiscordGatewayConfigError(`agent_tools.${key} must be a boolean`);
    }
  }
  return resolveDiscordAgentTools(raw);
}

/**
 * Validate and normalize the narrow launch configuration.
 *
 * This is intentionally strict: an unknown behavior flag must not silently
 * widen the bot's Discord visibility or capabilities. The returned object
 * always persists the alignment and thread-mode defaults explicitly.
 */
export function parseDiscordGatewayConfig(
  value: unknown,
  options: ParseDiscordGatewayConfigOptions = {}
): DiscordGatewayConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DiscordGatewayConfigError('config must be an object');
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new DiscordGatewayConfigError('config must be JSON-serializable');
  }
  if (typeof serialized !== 'string') {
    throw new DiscordGatewayConfigError('config must be JSON-serializable');
  }
  if (utf8Bytes(serialized) > DISCORD_GATEWAY_CONFIG_MAX_BYTES) {
    throw new DiscordGatewayConfigError(
      `config must be at most ${DISCORD_GATEWAY_CONFIG_MAX_BYTES} bytes`
    );
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !DISCORD_CONFIG_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new DiscordGatewayConfigError(`unsupported field ${unknown[0]}`);
  }

  const applicationId = requireSnowflake(raw.application_id, 'application_id');
  const guildId = requireSnowflake(raw.guild_id, 'guild_id');
  if (!Array.isArray(raw.allowed_channel_ids) || raw.allowed_channel_ids.length === 0) {
    throw new DiscordGatewayConfigError('allowed_channel_ids must be a non-empty array');
  }
  if (raw.allowed_channel_ids.length > DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES) {
    throw new DiscordGatewayConfigError(
      `allowed_channel_ids supports at most ${DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES} entries`
    );
  }
  const allowedChannelIds = raw.allowed_channel_ids.map((id, index) =>
    requireSnowflake(id, `allowed_channel_ids[${index}]`)
  );
  const uniqueAllowedChannelIds = [...new Set(allowedChannelIds)];

  if (raw.align_discord_users !== undefined && typeof raw.align_discord_users !== 'boolean') {
    throw new DiscordGatewayConfigError('align_discord_users must be a boolean');
  }
  const alignDiscordUsers = raw.align_discord_users ?? true;

  let userMap: Record<DiscordSnowflake, import('../../types/id').UserID> | undefined;
  if (raw.user_map !== undefined) {
    if (!raw.user_map || typeof raw.user_map !== 'object' || Array.isArray(raw.user_map)) {
      throw new DiscordGatewayConfigError('user_map must be an object');
    }
    const userMapEntries = Object.entries(raw.user_map as Record<string, unknown>);
    if (userMapEntries.length > DISCORD_USER_MAP_MAX_ENTRIES) {
      throw new DiscordGatewayConfigError(
        `user_map supports at most ${DISCORD_USER_MAP_MAX_ENTRIES} entries`
      );
    }
    userMap = {};
    for (const [discordUserId, agorUserId] of userMapEntries) {
      requireSnowflake(discordUserId, 'user_map key');
      if (!isCanonicalFullUuid(agorUserId)) {
        throw new DiscordGatewayConfigError('user_map values must be canonical Agor user IDs');
      }
      userMap[discordUserId] = agorUserId;
    }
  }
  if (alignDiscordUsers && (!userMap || Object.keys(userMap).length === 0)) {
    throw new DiscordGatewayConfigError('User alignment requires a non-empty user_map');
  }
  if (
    !alignDiscordUsers &&
    options.requireRunAsUser !== false &&
    !isCanonicalFullUuid(options.agorUserId)
  ) {
    throw new DiscordGatewayConfigError('Run as user is required when User alignment is off');
  }

  if (raw.thread_mode !== undefined && raw.thread_mode !== 'public_thread_per_summon') {
    throw new DiscordGatewayConfigError(
      'thread_mode must be public_thread_per_summon for Discord launch'
    );
  }
  if (raw.enable_dms !== undefined && raw.enable_dms !== false) {
    throw new DiscordGatewayConfigError('Discord DMs are not supported at launch');
  }
  if (raw.ingest_files !== undefined && typeof raw.ingest_files !== 'boolean') {
    throw new DiscordGatewayConfigError('ingest_files must be a boolean');
  }

  const tokenCandidate = typeof raw.bot_token === 'string' ? raw.bot_token.trim() : undefined;
  const botToken = tokenCandidate === GATEWAY_REDACTED_SENTINEL ? undefined : tokenCandidate;
  if (botToken && utf8Bytes(botToken) > DISCORD_BOT_TOKEN_MAX_BYTES) {
    throw new DiscordGatewayConfigError(
      `bot_token must be at most ${DISCORD_BOT_TOKEN_MAX_BYTES} bytes`
    );
  }
  if (options.enabled && (!botToken || botToken === GATEWAY_REDACTED_SENTINEL)) {
    throw new DiscordGatewayConfigError('bot_token is required when the channel is enabled');
  }

  const agentTools = parseAgentTools(raw.agent_tools);
  return {
    ...(botToken ? { bot_token: botToken } : {}),
    application_id: applicationId,
    guild_id: guildId,
    allowed_channel_ids: uniqueAllowedChannelIds,
    align_discord_users: alignDiscordUsers,
    ...(userMap ? { user_map: userMap } : {}),
    ...(raw.ingest_files !== undefined ? { ingest_files: raw.ingest_files } : {}),
    thread_mode: 'public_thread_per_summon',
    ...(agentTools ? { agent_tools: agentTools } : {}),
    ...(raw.enable_dms === false ? { enable_dms: false as const } : {}),
  };
}
