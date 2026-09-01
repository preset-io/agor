import { describe, expect, it } from 'vitest';
import { getGatewayCredentialPresentation } from '../../types/gateway';
import {
  buildDiscordSetupArtifact,
  DISCORD_MINIMUM_BOT_PERMISSION_BITMASK,
  evaluateDiscordConnectionVerification,
  validateDiscordSetup,
} from './discord-setup';

const decisions = {
  applicationId: '111111111111111111',
  guildId: '222222222222222222',
  messageContentAcknowledged: true,
  allowedChannelIds: ['333333333333333333'],
  allowedUserIds: ['444444444444444444'],
  agorUserId: '00000000-0000-4000-8000-000000000001',
};

describe('Discord setup artifact', () => {
  it('is complete, secret-free, and provides the exact invite contract', () => {
    const artifact = buildDiscordSetupArtifact(decisions);
    expect(artifact.validation.ok).toBe(true);
    expect(artifact.draft.enabled).toBe(false);
    expect(artifact.draft.config.bot_token).toBeUndefined();
    expect(artifact.permissions.bitmask).toBe(DISCORD_MINIMUM_BOT_PERMISSION_BITMASK);
    expect(artifact.botInviteUrl).toContain(
      `permissions=${DISCORD_MINIMUM_BOT_PERMISSION_BITMASK}`
    );
    expect(artifact.messageContent.required).toBe(true);
    expect(artifact.draft.config.catch_up).toBeTruthy();
  });

  it('requires a parent, author allowlist, and fixed or mapped identity', () => {
    const invalid = validateDiscordSetup(
      {
        application_id: decisions.applicationId,
        guild_id: decisions.guildId,
        allowed_channel_ids: [],
        allowed_user_ids: [],
        allowed_role_ids: [],
        message_content_enabled: true,
        thread_mode: 'public_thread_per_summon',
        align_discord_users: false,
      },
      undefined
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join('; ')).toMatch(
      /allowed_channel|allow(ed)?_user|fixed Discord identity/i
    );
  });

  it('rejects a fixed identity alongside a mapped identity', () => {
    const artifact = buildDiscordSetupArtifact({
      ...decisions,
      alignUsers: true,
      userMap: { '444444444444444444': 'person@example.com' },
    });
    expect(artifact.validation.ok).toBe(false);
    expect(artifact.validation.errors).toContain(
      'aligned Discord identity cannot include agor_user_id'
    );
  });

  it('keeps provider-specific credential labels without changing Slack prefixes', () => {
    const discord = getGatewayCredentialPresentation('discord', 'bot_token');
    expect(discord.label).toBe('Discord bot token');
    expect(discord.prefix).toBeUndefined();
    expect(getGatewayCredentialPresentation('slack', 'bot_token')).toMatchObject({
      label: 'Bot token',
      prefix: 'xoxb-',
    });
    expect(getGatewayCredentialPresentation('slack', 'app_token').prefix).toBe('xapp-');
  });

  it('requires an explicit Message Content acknowledgement', () => {
    expect(
      validateDiscordSetup(
        {
          ...buildDiscordSetupArtifact({ ...decisions, messageContentAcknowledged: false }).draft
            .config,
          message_content_enabled: false,
        },
        decisions.agorUserId
      ).errors
    ).toContain('message_content_enabled must be true');
  });
});

describe('Discord connection verification', () => {
  const applicationId = '111111111111111111';
  const verified = {
    ok: true,
    bot: { userId: applicationId, name: 'Agor' },
    verifiedInstallationId: applicationId,
    verification: { status: 'verified', warnings: [] },
    failures: [],
    notVerifiable: [],
  };

  it.each([
    ['absent result', undefined],
    ['primitive result', 'verified'],
    ['absent verification', { ...verified, verification: undefined }],
    ['malformed verification', { ...verified, verification: 'verified' }],
    ['malformed warnings', { ...verified, verification: { status: 'verified', warnings: [1] } }],
    ['warning status', { ...verified, verification: { status: 'warning', warnings: ['unknown'] } }],
    [
      'nonempty warnings',
      { ...verified, verification: { status: 'verified', warnings: ['unknown'] } },
    ],
    ['malformed failures', { ...verified, failures: {} }],
    ['nonempty failures', { ...verified, failures: [{ capability: 'bot', reason: 'failed' }] }],
    ['ok false', { ...verified, ok: false }],
    ['missing bot identity', { ...verified, bot: undefined }],
    ['wrong bot identity', { ...verified, bot: { userId: '999999999999999999' } }],
    ['missing installation identity', { ...verified, verifiedInstallationId: undefined }],
    ['wrong installation identity', { ...verified, verifiedInstallationId: '999999999999999999' }],
  ])('fails closed for %s', (_label, result) => {
    expect(evaluateDiscordConnectionVerification(result, applicationId).verified).toBe(false);
  });

  it('accepts only the exact verified application identity', () => {
    expect(evaluateDiscordConnectionVerification(verified, applicationId)).toEqual({
      verified: true,
      installationId: applicationId,
    });
  });
});
