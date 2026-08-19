import {
  ApplicationFlags,
  ApplicationIntegrationType,
  GatewayIntentBits,
  OAuth2Scopes,
  PermissionFlagsBits,
} from 'discord-api-types/v10';

import type { DiscordSnowflake } from '../../types/gateway';
import { isDiscordSnowflake } from './discord-config';

const DISCORD_APPLICATION_FLAGS_MAX = 0x7fffffff;
const DISCORD_APPLICATION_INTEGRATION_CONFIG_MAX_BYTES = 16 * 1_024;

/** Launch receives guild/thread messages and the bounded catch-up bodies only. */
export const DISCORD_GATEWAY_INTENTS =
  GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent;

/** Narrow launch permissions; Administrator and Mention Everyone are absent. */
export const DISCORD_LAUNCH_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.CreatePublicThreads |
  PermissionFlagsBits.SendMessagesInThreads;

export const DISCORD_LAUNCH_PERMISSIONS_DECIMAL = DISCORD_LAUNCH_PERMISSIONS.toString(10);

export const DISCORD_LAUNCH_PERMISSION_NAMES = [
  'View Channel',
  'Send Messages',
  'Attach Files',
  'Read Message History',
  'Create Public Threads',
  'Send Messages in Threads',
] as const;

export const DISCORD_GATEWAY_INTENT_NAMES = [
  'Guilds',
  'Guild Messages',
  'Message Content (privileged)',
] as const;

export interface DiscordRecommendedApplicationSettings {
  integration_types_config: Record<
    string,
    { oauth2_install_params: { scopes: string[]; permissions: string } }
  >;
}

export interface DiscordApplicationSettingsPatch extends DiscordRecommendedApplicationSettings {
  flags: number;
}

export interface DiscordApplicationSettingsSummary {
  applicationId: DiscordSnowflake;
  installUrl: string;
  messageContentAccess: true;
  guildInstallDefaults: true;
  intentNames: readonly string[];
  permissionNames: readonly string[];
  permissions: string;
}

/** Browser-safe preview/body for the reviewed application-defaults patch. */
export function buildDiscordRecommendedApplicationSettings(): DiscordRecommendedApplicationSettings {
  return {
    integration_types_config: {
      [String(ApplicationIntegrationType.GuildInstall)]: {
        oauth2_install_params: {
          scopes: [OAuth2Scopes.Bot],
          permissions: DISCORD_LAUNCH_PERMISSIONS_DECIMAL,
        },
      },
    },
  };
}

function cloneIntegrationTypesConfig(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Discord application integration settings have an invalid shape');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Discord application integration settings are not JSON-serializable');
  }
  if (
    new TextEncoder().encode(serialized).byteLength >
    DISCORD_APPLICATION_INTEGRATION_CONFIG_MAX_BYTES
  ) {
    throw new Error('Discord application integration settings exceed the safe merge bound');
  }
  const cloned = JSON.parse(serialized) as unknown;
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new Error('Discord application integration settings have an invalid shape');
  }
  return cloned as Record<string, unknown>;
}

/**
 * Build the only reviewed application mutation.
 *
 * Unrelated flags, installation contexts, and context-specific keys survive;
 * only the Guild Install OAuth defaults are replaced with the exact launch
 * bot scope and permission set.
 */
export function buildDiscordApplicationSettingsPatch(
  application: unknown
): DiscordApplicationSettingsPatch {
  if (!application || typeof application !== 'object' || Array.isArray(application)) {
    throw new Error('Discord returned an invalid application');
  }
  const raw = application as Record<string, unknown>;
  const current = cloneIntegrationTypesConfig(raw.integration_types_config);
  const guildKey = String(ApplicationIntegrationType.GuildInstall);
  const existingGuild = current[guildKey];
  if (
    existingGuild !== undefined &&
    (!existingGuild || typeof existingGuild !== 'object' || Array.isArray(existingGuild))
  ) {
    throw new Error('Discord returned invalid Guild Install settings');
  }
  return {
    flags: addDiscordMessageContentLimitedFlag(raw.flags as number),
    integration_types_config: {
      ...current,
      [guildKey]: {
        ...((existingGuild as Record<string, unknown> | undefined) ?? {}),
        oauth2_install_params: {
          scopes: [OAuth2Scopes.Bot],
          permissions: DISCORD_LAUNCH_PERMISSIONS_DECIMAL,
        },
      },
    } as DiscordRecommendedApplicationSettings['integration_types_config'],
  };
}

/** Read-only drift check used by Test connection; never mutates the application. */
export function discordGuildInstallDefaultsMatch(application: unknown): boolean {
  if (!application || typeof application !== 'object') return false;
  const integrationTypes = (application as Record<string, unknown>).integration_types_config;
  if (!integrationTypes || typeof integrationTypes !== 'object') return false;
  const guildInstall = (integrationTypes as Record<string, unknown>)[
    String(ApplicationIntegrationType.GuildInstall)
  ];
  if (!guildInstall || typeof guildInstall !== 'object') return false;
  const params = (guildInstall as Record<string, unknown>).oauth2_install_params;
  if (!params || typeof params !== 'object') return false;
  const scopes = (params as Record<string, unknown>).scopes;
  const permissions = (params as Record<string, unknown>).permissions;
  return (
    Array.isArray(scopes) &&
    scopes.length === 1 &&
    scopes[0] === OAuth2Scopes.Bot &&
    permissions === DISCORD_LAUNCH_PERMISSIONS_DECIMAL
  );
}

/** Preserve unrelated application flags while requesting limited Message Content. */
export function addDiscordMessageContentLimitedFlag(currentFlags: number): number {
  if (
    !Number.isSafeInteger(currentFlags) ||
    currentFlags < 0 ||
    currentFlags > DISCORD_APPLICATION_FLAGS_MAX
  ) {
    throw new Error('Discord application flags must be a non-negative safe integer');
  }
  return currentFlags | ApplicationFlags.GatewayMessageContentLimited;
}

/** Probe succeeds for either limited access or Discord-approved full access. */
export function hasDiscordMessageContentAccess(flags: unknown): boolean {
  if (!Number.isSafeInteger(flags) || (flags as number) < 0) return false;
  return (
    ((flags as number) & ApplicationFlags.GatewayMessageContentLimited) !== 0 ||
    ((flags as number) & ApplicationFlags.GatewayMessageContent) !== 0
  );
}

export function buildDiscordInstallUrl(
  applicationId: DiscordSnowflake,
  guildId: DiscordSnowflake
): string {
  if (!isDiscordSnowflake(applicationId) || !isDiscordSnowflake(guildId)) {
    throw new Error('Discord install URL requires canonical application and guild Snowflakes');
  }
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', applicationId);
  url.searchParams.set('scope', OAuth2Scopes.Bot);
  url.searchParams.set('permissions', DISCORD_LAUNCH_PERMISSIONS_DECIMAL);
  url.searchParams.set('guild_id', guildId);
  url.searchParams.set('disable_guild_select', 'true');
  return url.toString();
}

/** Validate a PATCH response and reduce it to a content-free setup summary. */
export function summarizeDiscordApplicationSettings(
  application: unknown,
  expectedApplicationId: DiscordSnowflake,
  guildId: DiscordSnowflake
): DiscordApplicationSettingsSummary {
  if (!application || typeof application !== 'object' || Array.isArray(application)) {
    throw new Error('Discord returned an invalid application settings response');
  }
  const raw = application as Record<string, unknown>;
  if (raw.id !== expectedApplicationId) {
    throw new Error('Discord returned an unexpected application identity');
  }
  // Validate the response flag shape independently of the access check so a
  // malformed provider value never passes through bitwise coercion.
  addDiscordMessageContentLimitedFlag(raw.flags as number);
  if (!hasDiscordMessageContentAccess(raw.flags)) {
    throw new Error('Discord did not enable Message Content access');
  }
  if (!discordGuildInstallDefaultsMatch(raw)) {
    throw new Error('Discord did not apply the reviewed Guild Install defaults');
  }
  return {
    applicationId: expectedApplicationId,
    installUrl: buildDiscordInstallUrl(expectedApplicationId, guildId),
    messageContentAccess: true,
    guildInstallDefaults: true,
    intentNames: DISCORD_GATEWAY_INTENT_NAMES,
    permissionNames: DISCORD_LAUNCH_PERMISSION_NAMES,
    permissions: DISCORD_LAUNCH_PERMISSIONS_DECIMAL,
  };
}
