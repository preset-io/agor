/**
 * Browser-safe Discord setup artifact. This is deliberately free of provider
 * SDK imports so the MCP tool and the UI render the same contract.
 */
import {
  DEFAULT_DISCORD_CATCH_UP,
  type DiscordConfigValidationResult,
  validateDiscordConfig,
  withDiscordConfigDefaults,
} from '../../types/gateway';

export interface DiscordVerificationFailure {
  reason: string;
  warnings: string[];
}

export type DiscordConnectionVerification =
  | { verified: true; installationId: string }
  | { verified: false; failure: DiscordVerificationFailure };

/**
 * Evaluate the provider-owned Discord probe result before it can authorize an
 * enabled channel. Runtime provider data is unknown here on purpose: every
 * missing or malformed field fails closed at this single browser-safe seam.
 */
export function evaluateDiscordConnectionVerification(
  result: unknown,
  expectedApplicationId: unknown
): DiscordConnectionVerification {
  const failure = (reason: string, warnings: string[] = []): DiscordConnectionVerification => ({
    verified: false,
    failure: { reason, warnings },
  });

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return failure('Discord verification returned a malformed result');
  }
  if (typeof expectedApplicationId !== 'string' || expectedApplicationId.length === 0) {
    return failure('Discord application identity is missing from the configuration');
  }

  const candidate = result as Record<string, unknown>;
  if (candidate.ok !== true) return failure('Discord verification did not succeed');
  if (!Array.isArray(candidate.failures)) {
    return failure('Discord verification returned malformed failures');
  }
  if (candidate.failures.length !== 0) {
    return failure('Discord verification reported failures');
  }

  const verification = candidate.verification;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    return failure('Discord verification did not return a verification result');
  }
  const status = (verification as Record<string, unknown>).status;
  const warnings = (verification as Record<string, unknown>).warnings;
  if (!Array.isArray(warnings)) {
    return failure('Discord verification returned a malformed or unverified status');
  }
  if (!warnings.every((warning) => typeof warning === 'string')) {
    return failure('Discord verification returned malformed warnings');
  }
  if (status === 'warning' && warnings.length > 0) {
    return failure(`Discord verification returned warnings: ${warnings.join('; ')}`, warnings);
  }
  if (status !== 'verified') {
    return failure('Discord verification returned a malformed or unverified status');
  }
  if (warnings.length !== 0) {
    return failure(`Discord verification returned warnings: ${warnings.join('; ')}`, warnings);
  }

  const bot = candidate.bot;
  if (!bot || typeof bot !== 'object' || Array.isArray(bot)) {
    return failure('Discord verification did not return a bot identity');
  }
  const botUserId = (bot as Record<string, unknown>).userId;
  const installationId = candidate.verifiedInstallationId;
  if (botUserId !== expectedApplicationId || installationId !== expectedApplicationId) {
    return failure('Discord application identity could not be verified');
  }

  return { verified: true, installationId: expectedApplicationId };
}

export const DISCORD_DEVELOPER_PORTAL_URL = 'https://discord.com/developers/applications';
export const DISCORD_MINIMUM_BOT_PERMISSION_BITMASK = '309237713920';
export const DISCORD_MINIMUM_BOT_PERMISSION_NAMES = [
  'View Channel',
  'Send Messages',
  'Read Message History',
  'Create Public Threads',
  'Send Messages in Threads',
] as const;
export const DISCORD_REQUIRED_GATEWAY_INTENTS = [
  'Guilds',
  'Guild Messages',
  'Message Content',
] as const;

export interface DiscordSetupDecisions {
  applicationId: string;
  guildId: string;
  /** Explicit operator acknowledgement of the privileged Message Content intent. */
  messageContentAcknowledged: boolean;
  /** The first entry is the required parent channel for the setup. */
  allowedChannelIds: string[];
  allowedUserIds?: string[];
  allowedRoleIds?: string[];
  agorUserId?: string | null;
  alignUsers?: boolean;
  userMap?: Record<string, string>;
  outboundEnabled?: boolean;
  defaultOutboundTarget?: string | null;
  catchUp?: Record<string, unknown>;
  threadAutoArchiveMinutes?: number;
}

export interface DiscordSetupArtifact {
  provider: 'discord';
  developerPortal: {
    url: string;
    guidance: readonly string[];
  };
  permissions: {
    bitmask: string;
    names: readonly string[];
  };
  botInviteUrl: string;
  messageContent: {
    required: true;
    instruction: string;
  };
  /** Secret-free, config-complete payload for a disabled draft. */
  draft: {
    channelType: 'discord';
    enabled: false;
    agorUserId: string | null;
    config: Record<string, unknown>;
  };
  validation: DiscordConfigValidationResult;
}

export function discordBotInviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot%20applications.commands&permissions=${DISCORD_MINIMUM_BOT_PERMISSION_BITMASK}`;
}

/** Canonical setup validation, including the fixed-vs-mapped identity rule. */
export function validateDiscordSetup(
  config: Record<string, unknown>,
  agorUserId: string | null | undefined
): DiscordConfigValidationResult {
  const result = validateDiscordConfig(config, { requireBotToken: false });
  const aligned = config.align_discord_users === true;
  if (aligned && agorUserId) {
    result.errors.push('aligned Discord identity cannot include agor_user_id');
  }
  if (!aligned && !agorUserId?.trim()) {
    result.errors.push('fixed Discord identity requires agor_user_id');
  }
  return { ok: result.errors.length === 0, errors: result.errors };
}

export function buildDiscordSetupArtifact(decisions: DiscordSetupDecisions): DiscordSetupArtifact {
  const config = withDiscordConfigDefaults({
    application_id: decisions.applicationId,
    guild_id: decisions.guildId,
    allowed_channel_ids: decisions.allowedChannelIds,
    allowed_user_ids: decisions.allowedUserIds ?? [],
    allowed_role_ids: decisions.allowedRoleIds ?? [],
    message_content_enabled: decisions.messageContentAcknowledged,
    thread_mode: 'public_thread_per_summon',
    thread_auto_archive_minutes: decisions.threadAutoArchiveMinutes ?? 1440,
    align_discord_users: decisions.alignUsers ?? false,
    ...(decisions.userMap ? { user_map: decisions.userMap } : {}),
    outbound_enabled: decisions.outboundEnabled ?? false,
    default_outbound_target: decisions.defaultOutboundTarget ?? null,
    catch_up: { ...DEFAULT_DISCORD_CATCH_UP, ...(decisions.catchUp ?? {}) },
  });
  const validation = validateDiscordSetup(config, decisions.agorUserId);
  return {
    provider: 'discord',
    developerPortal: {
      url: DISCORD_DEVELOPER_PORTAL_URL,
      guidance: [
        'Create an application and bot, then copy the Application ID and target Guild ID.',
        `Enable Gateway Intents: ${DISCORD_REQUIRED_GATEWAY_INTENTS.join(', ')} (Message Content is privileged).`,
        'Invite the bot only to the target guild and the configured public parent channel.',
      ],
    },
    permissions: {
      bitmask: DISCORD_MINIMUM_BOT_PERMISSION_BITMASK,
      names: DISCORD_MINIMUM_BOT_PERMISSION_NAMES,
    },
    botInviteUrl: discordBotInviteUrl(decisions.applicationId),
    messageContent: {
      required: true,
      instruction:
        'In Developer Portal → Bot → Privileged Gateway Intents, enable and acknowledge Message Content before probing.',
    },
    draft: {
      channelType: 'discord',
      enabled: false,
      agorUserId: decisions.agorUserId ?? null,
      config,
    },
    validation,
  };
}
