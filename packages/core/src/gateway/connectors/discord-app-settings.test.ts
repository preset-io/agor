import { ApplicationFlags, PermissionFlagsBits } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';

import {
  addDiscordMessageContentLimitedFlag,
  buildDiscordApplicationSettingsPatch,
  buildDiscordInstallUrl,
  buildDiscordRecommendedApplicationSettings,
  DISCORD_GATEWAY_INTENT_NAMES,
  DISCORD_GATEWAY_INTENTS,
  DISCORD_LAUNCH_PERMISSION_NAMES,
  DISCORD_LAUNCH_PERMISSIONS,
  DISCORD_LAUNCH_PERMISSIONS_DECIMAL,
  discordGuildInstallDefaultsMatch,
  hasDiscordMessageContentAccess,
  summarizeDiscordApplicationSettings,
} from './discord-app-settings';

describe('Discord launch application settings', () => {
  it('derives exact intents and narrow named permissions', () => {
    expect(DISCORD_GATEWAY_INTENTS).toBe(33_281);
    expect(DISCORD_LAUNCH_PERMISSIONS_DECIMAL).toBe('309237746688');
    expect((DISCORD_LAUNCH_PERMISSIONS & PermissionFlagsBits.Administrator) !== 0n).toBe(false);
    expect((DISCORD_LAUNCH_PERMISSIONS & PermissionFlagsBits.MentionEveryone) !== 0n).toBe(false);
  });

  it('derives the Guild Install bot defaults and direct install URL from one permission value', () => {
    const recommended = buildDiscordRecommendedApplicationSettings();
    expect(recommended).toEqual({
      integration_types_config: {
        '0': {
          oauth2_install_params: {
            scopes: ['bot'],
            permissions: '309237746688',
          },
        },
      },
    });
    expect(discordGuildInstallDefaultsMatch(recommended)).toBe(true);
    expect(
      discordGuildInstallDefaultsMatch({
        integration_types_config: {
          '0': { oauth2_install_params: { scopes: ['bot'], permissions: '8' } },
        },
      })
    ).toBe(false);
    const url = new URL(buildDiscordInstallUrl('123456789012345678', '223456789012345678'));
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '123456789012345678',
      scope: 'bot',
      permissions: '309237746688',
      guild_id: '223456789012345678',
      disable_guild_select: 'true',
    });
  });

  it('preserves unrelated flags and accepts limited or approved Message Content access', () => {
    const unrelated = ApplicationFlags.Embedded;
    const patched = addDiscordMessageContentLimitedFlag(unrelated);
    expect((patched & unrelated) !== 0).toBe(true);
    expect(hasDiscordMessageContentAccess(patched)).toBe(true);
    expect(hasDiscordMessageContentAccess(ApplicationFlags.GatewayMessageContent)).toBe(true);
    expect(hasDiscordMessageContentAccess(unrelated)).toBe(false);
  });

  it('merges only reviewed Guild Install defaults and preserves unrelated application state', () => {
    const unrelated = ApplicationFlags.Embedded;
    const patch = buildDiscordApplicationSettingsPatch({
      id: '123456789012345678',
      flags: unrelated,
      integration_types_config: {
        '0': {
          oauth2_install_params: { scopes: ['applications.commands'], permissions: '8' },
          retained_guild_setting: true,
        },
        '1': {
          oauth2_install_params: { scopes: ['applications.commands'], permissions: '0' },
          retained_user_setting: 'yes',
        },
      },
      description: 'must not enter the patch',
      interactions_endpoint_url: 'https://example.invalid/interaction',
      owner: { id: 'not-safe-to-return' },
    });

    expect(Object.keys(patch).sort()).toEqual(['flags', 'integration_types_config']);
    expect(patch.flags & unrelated).toBe(unrelated);
    expect(patch.integration_types_config).toEqual({
      '0': {
        retained_guild_setting: true,
        oauth2_install_params: { scopes: ['bot'], permissions: '309237746688' },
      },
      '1': {
        oauth2_install_params: { scopes: ['applications.commands'], permissions: '0' },
        retained_user_setting: 'yes',
      },
    });
  });

  it('validates the exact application response and returns a content-free summary', () => {
    const settings = buildDiscordApplicationSettingsPatch({ flags: 0 });
    const summary = summarizeDiscordApplicationSettings(
      { id: '123456789012345678', ...settings },
      '123456789012345678',
      '223456789012345678'
    );
    expect(summary).toMatchObject({
      applicationId: '123456789012345678',
      messageContentAccess: true,
      guildInstallDefaults: true,
      permissions: '309237746688',
      intentNames: DISCORD_GATEWAY_INTENT_NAMES,
      permissionNames: DISCORD_LAUNCH_PERMISSION_NAMES,
    });
    expect(summary.installUrl).toContain('guild_id=223456789012345678');
    expect(() =>
      summarizeDiscordApplicationSettings(
        { id: '999456789012345678', ...settings },
        '123456789012345678',
        '223456789012345678'
      )
    ).toThrow(/identity/);
  });

  it('rejects unsafe flag and integration-setting shapes', () => {
    expect(() => buildDiscordApplicationSettingsPatch({ flags: 2 ** 31 })).toThrow(/flags/);
    expect(() =>
      buildDiscordApplicationSettingsPatch({ flags: 0, integration_types_config: [] })
    ).toThrow(/shape/);
    expect(() =>
      buildDiscordApplicationSettingsPatch({
        flags: 0,
        integration_types_config: { '0': 'invalid' },
      })
    ).toThrow(/Guild Install/);
  });
});
