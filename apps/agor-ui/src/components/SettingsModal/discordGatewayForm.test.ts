import {
  DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES,
  DISCORD_BOT_TOKEN_MAX_BYTES,
  DISCORD_USER_MAP_MAX_ENTRIES,
} from '@agor/core/gateway/discord-setup';
import { GATEWAY_REDACTED_SENTINEL } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  DISCORD_GATEWAY_FORM_DEFAULTS,
  discordConfigToFormValues,
  extractDiscordGatewayConfig,
  validateDiscordAllowedParentIds,
  validateDiscordUserMapRows,
} from './discordGatewayForm';

const AGOR_USER_A = '01990b8e-7ef3-7000-8000-000000000001';
const AGOR_USER_B = '01990b8e-7ef3-7000-8000-000000000002';

function alignedValues(): Record<string, unknown> {
  return {
    discord_application_id: '123456789012345678',
    discord_guild_id: '223456789012345678',
    discord_allowed_channel_ids: ['323456789012345678'],
    align_discord_users: true,
    discord_user_map: [{ discordUserId: '423456789012345678', agorUserId: AGOR_USER_A }],
    discord_bot_token: 'secret',
  };
}

describe('Discord gateway form extraction', () => {
  it('uses the launch defaults and emits only the strict launch config', () => {
    expect(DISCORD_GATEWAY_FORM_DEFAULTS).toEqual({
      enabled: false,
      align_discord_users: true,
      ingest_files: false,
      discord_thread_history: true,
    });

    expect(extractDiscordGatewayConfig(alignedValues(), new Set([AGOR_USER_A]))).toEqual({
      bot_token: 'secret',
      application_id: '123456789012345678',
      guild_id: '223456789012345678',
      allowed_channel_ids: ['323456789012345678'],
      align_discord_users: true,
      user_map: { '423456789012345678': AGOR_USER_A },
      ingest_files: false,
      thread_mode: 'public_thread_per_summon',
      agent_tools: {
        thread_history: true,
        channel_history: false,
        reactions: false,
        file_upload: false,
        file_download: false,
      },
      enable_dms: false,
    });
  });

  it('never round-trips the redacted token and preserves edit defaults', () => {
    const config = extractDiscordGatewayConfig({
      ...alignedValues(),
      discord_bot_token: GATEWAY_REDACTED_SENTINEL,
      ingest_files: true,
      discord_thread_history: false,
    });
    expect(config).not.toHaveProperty('bot_token');
    expect(discordConfigToFormValues(config)).toMatchObject({
      align_discord_users: true,
      ingest_files: true,
      discord_thread_history: false,
      discord_user_map: [{ discordUserId: '423456789012345678', agorUserId: AGOR_USER_A }],
    });
  });

  it('requires Run as user to be a current-tenant canonical user when alignment is off', () => {
    const values = {
      ...alignedValues(),
      align_discord_users: false,
      agor_user_id: AGOR_USER_A,
    };
    expect(extractDiscordGatewayConfig(values, new Set([AGOR_USER_A]))).not.toHaveProperty(
      'user_map'
    );
    expect(() => extractDiscordGatewayConfig(values, new Set([AGOR_USER_B]))).toThrow(
      /not available in this tenant/i
    );
    expect(() => extractDiscordGatewayConfig({ ...values, agor_user_id: 'short' })).toThrow(
      /canonical Run as user/i
    );
  });

  it('enforces Snowflake uniqueness and launch cardinality bounds', () => {
    expect(() =>
      validateDiscordAllowedParentIds(['323456789012345678', '323456789012345678'])
    ).toThrow(/unique/i);
    expect(() =>
      validateDiscordAllowedParentIds(
        Array.from({ length: DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES + 1 }, (_, index) =>
          String(323456789012345678n + BigInt(index))
        )
      )
    ).toThrow(/at most/i);

    const tooManyMappings = Array.from(
      { length: DISCORD_USER_MAP_MAX_ENTRIES + 1 },
      (_, index) => ({
        discordUserId: String(423456789012345678n + BigInt(index)),
        agorUserId: AGOR_USER_A,
      })
    );
    expect(() => validateDiscordUserMapRows(tooManyMappings)).toThrow(/at most/i);
  });

  it('rejects a foreign alignment user and an oversized bot token', () => {
    expect(() => extractDiscordGatewayConfig(alignedValues(), new Set([AGOR_USER_B]))).toThrow(
      /not available in this tenant/i
    );
    expect(() =>
      extractDiscordGatewayConfig({
        ...alignedValues(),
        discord_bot_token: 'x'.repeat(DISCORD_BOT_TOKEN_MAX_BYTES + 1),
      })
    ).toThrow(/at most/i);
  });
});
