import {
  DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES,
  DISCORD_BOT_TOKEN_MAX_BYTES,
  DISCORD_USER_MAP_MAX_ENTRIES,
  isDiscordSnowflake,
} from '@agor/core/gateway/discord-setup';
import { GATEWAY_REDACTED_SENTINEL, isCanonicalFullUuid } from '@agor-live/client';

export interface DiscordUserMapRow {
  discordUserId: string;
  agorUserId: string;
}

export const DISCORD_GATEWAY_FORM_DEFAULTS = {
  enabled: false,
  align_discord_users: true,
  ingest_files: false,
  discord_thread_history: true,
} as const;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function discordUserMapToRows(value: unknown): DiscordUserMapRow[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string] =>
        isDiscordSnowflake(entry[0]) && typeof entry[1] === 'string' && !!entry[1]
    )
    .map(([discordUserId, agorUserId]) => ({ discordUserId, agorUserId }));
}

export function validateDiscordUserMapRows(
  value: unknown,
  currentTenantUserIds?: ReadonlySet<string>
): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Add at least one Discord user mapping');
  }
  if (value.length > DISCORD_USER_MAP_MAX_ENTRIES) {
    throw new Error(`User alignment supports at most ${DISCORD_USER_MAP_MAX_ENTRIES} mappings`);
  }
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`User mapping ${index + 1} is invalid`);
    }
    const row = candidate as Record<string, unknown>;
    if (!isDiscordSnowflake(row.discordUserId)) {
      throw new Error(`Discord User ID ${index + 1} must be a Snowflake`);
    }
    if (typeof row.agorUserId !== 'string' || !row.agorUserId) {
      throw new Error(`Choose an Agor user for mapping ${index + 1}`);
    }
    if (!isCanonicalFullUuid(row.agorUserId)) {
      throw new Error(`Agor user ${index + 1} must use a canonical ID`);
    }
    if (currentTenantUserIds && !currentTenantUserIds.has(row.agorUserId)) {
      throw new Error(`Agor user ${index + 1} is not available in this tenant`);
    }
    if (seen.has(row.discordUserId)) throw new Error('Discord User IDs must be unique');
    seen.add(row.discordUserId);
  }
}

export function validateDiscordAllowedParentIds(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Add at least one allowed parent channel ID');
  }
  if (value.length > DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES) {
    throw new Error(
      `Discord supports at most ${DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES} allowed parent channels`
    );
  }
  const unique = new Set<string>();
  for (const candidate of value) {
    if (!isDiscordSnowflake(candidate)) {
      throw new Error('Every allowed parent channel ID must be a Discord Snowflake');
    }
    if (unique.has(candidate)) throw new Error('Allowed parent channel IDs must be unique');
    unique.add(candidate);
  }
}

export function extractDiscordGatewayConfig(
  values: Record<string, unknown>,
  currentTenantUserIds?: ReadonlySet<string>
): Record<string, unknown> {
  if (!isDiscordSnowflake(values.discord_application_id)) {
    throw new Error('Application ID must be a Discord Snowflake');
  }
  if (!isDiscordSnowflake(values.discord_guild_id)) {
    throw new Error('Server ID must be a Discord Snowflake');
  }
  validateDiscordAllowedParentIds(values.discord_allowed_channel_ids);
  const alignUsers = values.align_discord_users !== false;
  const config: Record<string, unknown> = {
    application_id: values.discord_application_id,
    guild_id: values.discord_guild_id,
    allowed_channel_ids: values.discord_allowed_channel_ids,
    align_discord_users: alignUsers,
    ingest_files: values.ingest_files === true,
    thread_mode: 'public_thread_per_summon',
    agent_tools: {
      thread_history: values.discord_thread_history !== false,
      channel_history: false,
      reactions: false,
      file_upload: false,
      file_download: false,
    },
    enable_dms: false,
  };
  if (alignUsers) {
    validateDiscordUserMapRows(values.discord_user_map, currentTenantUserIds);
    config.user_map = Object.fromEntries(
      (values.discord_user_map as DiscordUserMapRow[]).map((row) => [
        row.discordUserId,
        row.agorUserId,
      ])
    );
  } else {
    if (!isCanonicalFullUuid(values.agor_user_id)) {
      throw new Error('Choose a canonical Run as user');
    }
    if (currentTenantUserIds && !currentTenantUserIds.has(values.agor_user_id)) {
      throw new Error('Run as user is not available in this tenant');
    }
  }
  const token = typeof values.discord_bot_token === 'string' ? values.discord_bot_token.trim() : '';
  if (token && token !== GATEWAY_REDACTED_SENTINEL) {
    if (utf8Bytes(token) > DISCORD_BOT_TOKEN_MAX_BYTES) {
      throw new Error(`Bot token must be at most ${DISCORD_BOT_TOKEN_MAX_BYTES} bytes`);
    }
    config.bot_token = token;
  }
  return config;
}

export function discordConfigToFormValues(
  config: Record<string, unknown>
): Record<string, unknown> {
  const tools =
    config.agent_tools && typeof config.agent_tools === 'object'
      ? (config.agent_tools as Record<string, unknown>)
      : {};
  return {
    discord_application_id: config.application_id,
    discord_guild_id: config.guild_id,
    discord_allowed_channel_ids: Array.isArray(config.allowed_channel_ids)
      ? config.allowed_channel_ids
      : [],
    align_discord_users: config.align_discord_users !== false,
    discord_user_map: discordUserMapToRows(config.user_map),
    ingest_files: config.ingest_files === true,
    discord_thread_history: tools.thread_history !== false,
  };
}
