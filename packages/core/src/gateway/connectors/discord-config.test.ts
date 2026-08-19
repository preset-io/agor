import { describe, expect, it } from 'vitest';

import { DISCORD_AGENT_TOOL_DEFAULTS, GATEWAY_REDACTED_SENTINEL } from '../../types/gateway';
import {
  compareDiscordSnowflakes,
  DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES,
  DISCORD_BOT_TOKEN_MAX_BYTES,
  DISCORD_GATEWAY_CONFIG_MAX_BYTES,
  DISCORD_USER_MAP_MAX_ENTRIES,
  DiscordGatewayConfigError,
  discordSnowflakeLowerBound,
  discordSnowflakePredecessor,
  isDiscordSnowflake,
  parseDiscordGatewayConfig,
} from './discord-config';

const AGOR_USER_ID = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f';

function alignedConfig(overrides: Record<string, unknown> = {}) {
  return {
    application_id: '123456789012345678',
    guild_id: '223456789012345678',
    allowed_channel_ids: ['323456789012345678'],
    align_discord_users: true,
    user_map: { '423456789012345678': AGOR_USER_ID },
    ...overrides,
  };
}

describe('Discord gateway config', () => {
  it('validates canonical unsigned 64-bit Snowflakes without number coercion', () => {
    expect(isDiscordSnowflake('1')).toBe(true);
    expect(isDiscordSnowflake('18446744073709551615')).toBe(true);
    expect(isDiscordSnowflake('18446744073709551616')).toBe(false);
    expect(isDiscordSnowflake('01')).toBe(false);
    expect(isDiscordSnowflake('0')).toBe(false);
    expect(isDiscordSnowflake(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(compareDiscordSnowflakes('9007199254740993', '9007199254740992')).toBe(1);
    const boundary = discordSnowflakeLowerBound(Date.parse('2026-08-18T12:00:00.000Z'));
    const nextBoundary = discordSnowflakeLowerBound(Date.parse('2026-08-18T12:00:00.001Z'));
    expect(BigInt(nextBoundary) - BigInt(boundary)).toBe(1n << 22n);
    expect(discordSnowflakePredecessor('423456789012345678')).toBe('423456789012345677');
    expect(() => discordSnowflakeLowerBound(0)).toThrow(/timestamp boundary/);
  });

  it('normalizes launch defaults and exact User alignment IDs', () => {
    const parsed = parseDiscordGatewayConfig(
      alignedConfig({
        align_discord_users: undefined,
        allowed_channel_ids: ['323456789012345678', '323456789012345678'],
        agent_tools: { reactions: true },
      })
    );

    expect(parsed).toMatchObject({
      align_discord_users: true,
      thread_mode: 'public_thread_per_summon',
      allowed_channel_ids: ['323456789012345678'],
      user_map: { '423456789012345678': AGOR_USER_ID },
      agent_tools: { ...DISCORD_AGENT_TOOL_DEFAULTS, reactions: true },
    });
  });

  it('fails closed for empty alignment maps and requires Run as user in fixed mode', () => {
    expect(() => parseDiscordGatewayConfig(alignedConfig({ user_map: {} }))).toThrow(
      /non-empty user_map/
    );
    expect(() =>
      parseDiscordGatewayConfig(alignedConfig({ align_discord_users: false, user_map: undefined }))
    ).toThrow(/Run as user/);

    expect(
      parseDiscordGatewayConfig(
        alignedConfig({ align_discord_users: false, user_map: undefined }),
        { agorUserId: AGOR_USER_ID }
      ).align_discord_users
    ).toBe(false);
  });

  it('requires only the bot secret at enablement and never includes it in errors', () => {
    expect(() => parseDiscordGatewayConfig(alignedConfig(), { enabled: true })).toThrow(
      /bot_token is required/
    );
    const parsed = parseDiscordGatewayConfig(alignedConfig({ bot_token: '  token-value  ' }), {
      enabled: true,
    });
    expect(parsed.bot_token).toBe('token-value');
    expect(
      parseDiscordGatewayConfig(alignedConfig({ bot_token: GATEWAY_REDACTED_SENTINEL }))
    ).not.toHaveProperty('bot_token');

    let error: unknown;
    try {
      parseDiscordGatewayConfig(
        alignedConfig({ bot_token: 'do-not-print-me', guild_id: 'invalid' }),
        { enabled: true }
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DiscordGatewayConfigError);
    expect(String(error)).not.toContain('do-not-print-me');
  });

  it('rejects empty allowlists, unsupported launch flags, and unknown capabilities', () => {
    expect(() => parseDiscordGatewayConfig(alignedConfig({ allowed_channel_ids: [] }))).toThrow(
      /non-empty array/
    );
    expect(() => parseDiscordGatewayConfig(alignedConfig({ enable_dms: true }))).toThrow(
      /DMs are not supported/
    );
    expect(() => parseDiscordGatewayConfig(alignedConfig({ poll_interval_ms: 1000 }))).toThrow(
      /unsupported field/
    );
    expect(() =>
      parseDiscordGatewayConfig(alignedConfig({ agent_tools: { guild_history: true } }))
    ).toThrow(/unsupported agent_tools field/);
  });

  it('bounds launch setup, probe, and reconciliation cardinalities and bytes', () => {
    const allowed = Array.from({ length: DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES }, (_, index) =>
      String(10_000 + index)
    );
    expect(
      parseDiscordGatewayConfig(alignedConfig({ allowed_channel_ids: allowed })).allowed_channel_ids
    ).toHaveLength(DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES);
    expect(() =>
      parseDiscordGatewayConfig(
        alignedConfig({ allowed_channel_ids: [...allowed, '999999999999999999'] })
      )
    ).toThrow(/allowed_channel_ids supports at most/);

    const userMap = Object.fromEntries(
      Array.from({ length: DISCORD_USER_MAP_MAX_ENTRIES }, (_, index) => [
        String(100_000 + index),
        AGOR_USER_ID,
      ])
    );
    expect(parseDiscordGatewayConfig(alignedConfig({ user_map: userMap })).user_map).toEqual(
      userMap
    );
    expect(() =>
      parseDiscordGatewayConfig(
        alignedConfig({ user_map: { ...userMap, '999999999999999999': AGOR_USER_ID } })
      )
    ).toThrow(/user_map supports at most/);

    expect(
      parseDiscordGatewayConfig(
        alignedConfig({ bot_token: 'x'.repeat(DISCORD_BOT_TOKEN_MAX_BYTES) })
      ).bot_token
    ).toHaveLength(DISCORD_BOT_TOKEN_MAX_BYTES);
    expect(() =>
      parseDiscordGatewayConfig(
        alignedConfig({ bot_token: 'x'.repeat(DISCORD_BOT_TOKEN_MAX_BYTES + 1) })
      )
    ).toThrow(/bot_token must be at most/);
    expect(() =>
      parseDiscordGatewayConfig(
        alignedConfig({ bot_token: 'x'.repeat(DISCORD_GATEWAY_CONFIG_MAX_BYTES) })
      )
    ).toThrow(/config must be at most/);
  });
});
