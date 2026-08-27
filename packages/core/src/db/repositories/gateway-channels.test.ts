/**
 * GatewayChannelRepository Tests
 *
 * Covers the created_by requirement — the contract that the
 * injectCreatedBy() hook must satisfy before calling create().
 */

import {
  type BranchID,
  GATEWAY_REDACTED_SENTINEL,
  getRequiredSecretFields,
  type UUID,
} from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { buildDiscordSetupArtifact } from '../../gateway/connectors/discord-setup';
import { generateId } from '../../lib/ids';
import {
  DEFAULT_DISCORD_CATCH_UP,
  isDiscordSnowflake,
  MAX_DISCORD_CATCH_UP,
  MIN_DISCORD_CATCH_UP,
  validateDiscordConfig,
  withDiscordConfigDefaults,
} from '../../types/gateway';
import type { Database } from '../client';
import { ownedDbTest as dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { RepoRepository } from './repos';

async function seedBranch(db: Database) {
  const repoRepo = new RepoRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId() as UUID,
    slug: 'test/repo',
    name: 'test-repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/home/user/.agor/repos/test-repo',
    default_branch: 'main',
  });

  const branchRepo = new BranchRepository(db);
  const branch = await branchRepo.create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'main',
    ref: 'refs/heads/main',
    branch_unique_id: 1,
    path: '/home/user/.agor/worktrees/test/repo/main',
    created_by: 'test-user' as UUID,
  });

  return branch;
}

describe('GatewayChannelRepository', () => {
  dbTest('create throws when created_by is missing', async ({ db }) => {
    const repo = new GatewayChannelRepository(db);
    await expect(repo.create({ name: 'Test Channel' })).rejects.toThrow(
      'GatewayChannel must have a created_by'
    );
  });

  dbTest('create stamps created_by on the returned channel', async ({ db }) => {
    const branch = await seedBranch(db);
    const repo = new GatewayChannelRepository(db);
    const userId = generateId() as UUID;

    const channel = await repo.create({
      name: 'Test Channel',
      created_by: userId,
      target_branch_id: branch.branch_id as UUID,
      config: { bot_token: 'xoxb-test', app_token: 'xapp-test' },
      mcp_server_ids: ['mcp-one'],
    });

    expect(channel.created_by).toBe(userId);
    expect(channel.name).toBe('Test Channel');
    expect(channel.id).toBeDefined();
    expect(channel.mcp_server_ids).toEqual(['mcp-one']);
  });

  describe('enabled requires secrets invariant', () => {
    dbTest(
      'accepts a complete secret-free Discord setup artifact before verified enablement',
      async ({ db }) => {
        const branch = await seedBranch(db);
        const repo = new GatewayChannelRepository(db);
        const artifact = buildDiscordSetupArtifact({
          applicationId: '666666666666666666',
          guildId: '222222222222222222',
          messageContentAcknowledged: true,
          allowedChannelIds: ['333333333333333333'],
          allowedUserIds: ['444444444444444444'],
          agorUserId: generateId() as UUID,
        });
        expect(artifact.validation.ok).toBe(true);

        const draft = await repo.create({
          name: 'Complete Discord draft',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'discord',
          enabled: false,
          agor_user_id: artifact.draft.agorUserId as UUID,
          config: artifact.draft.config,
        });
        expect(draft.enabled).toBe(false);
        expect(draft.config.bot_token).toBeUndefined();

        const withSecret = await repo.update(draft.id, {
          config: { bot_token: 'discord-write-only-secret' },
        });
        const changedDuringProbe = await repo.update(withSecret.id, {
          config: { thread_auto_archive_minutes: 4320 as const },
        });
        await expect(
          repo.updateWithVerifiedDiscordInstallation(
            changedDuringProbe.id,
            { enabled: true },
            '666666666666666666',
            withSecret.provider_config_generation
          )
        ).rejects.toThrow(/verification became stale/i);
        const enabled = await repo.updateWithVerifiedDiscordInstallation(
          changedDuringProbe.id,
          { enabled: true },
          '666666666666666666',
          changedDuringProbe.provider_config_generation
        );
        expect(enabled.enabled).toBe(true);
        expect(enabled.provider_installation_id).toBe('666666666666666666');
        expect(enabled.config.bot_token).toBe('discord-write-only-secret');
      }
    );

    dbTest('creates a disabled channel without secrets', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      const channel = await repo.create({
        name: 'Draft Slack',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: false,
      });

      expect(channel.enabled).toBe(false);
      expect(channel.config.bot_token).toBeUndefined();
    });

    dbTest(
      'allows an incomplete disabled Discord draft but requires a fixed user when enabled',
      async ({ db }) => {
        const branch = await seedBranch(db);
        const repo = new GatewayChannelRepository(db);
        const draft = await repo.create({
          name: 'Draft Discord',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'discord',
          enabled: false,
        });

        const configuredDraft = await repo.update(draft.id, {
          config: {
            bot_token: 'discord-token',
            application_id: '666666666666666666',
            guild_id: '222222222222222222',
            allowed_channel_ids: ['333333333333333333'],
            allowed_user_ids: ['444444444444444444'],
            allowed_role_ids: [],
            message_content_enabled: true,
            thread_mode: 'public_thread_per_summon',
            align_discord_users: false,
            files: false,
            agent_tools: [],
          },
        });

        await expect(repo.update(configuredDraft.id, { enabled: true })).rejects.toThrow(
          'verified Discord application binding is required'
        );

        const enabled = await repo.updateWithVerifiedDiscordInstallation(
          configuredDraft.id,
          { enabled: true, agor_user_id: generateId() as UUID },
          '666666666666666666',
          configuredDraft.provider_config_generation
        );
        expect(enabled.enabled).toBe(true);
        expect(enabled.agor_user_id).toBeDefined();
      }
    );

    dbTest('rejects an enabled channel created without secrets', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      await expect(
        repo.create({
          name: 'Enabled Slack',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'slack',
          enabled: true,
        })
      ).rejects.toThrow('missing required secret(s) bot_token');
    });

    dbTest('rejects enabling a disabled token-less channel', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      const draft = await repo.create({
        name: 'Draft Slack',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: false,
      });

      await expect(repo.update(draft.id, { enabled: true })).rejects.toThrow(
        'missing required secret(s) bot_token'
      );
    });

    dbTest('enables a draft after its secrets are supplied', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      const draft = await repo.create({
        name: 'Draft Slack',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: false,
      });

      // Unconfigured Slack defaults to inbound, so it needs app_token too.
      const withToken = await repo.update(draft.id, {
        config: { bot_token: 'xoxb-token', app_token: 'xapp-token' },
      });
      expect(withToken.enabled).toBe(false);

      const enabled = await repo.update(draft.id, { enabled: true });
      expect(enabled.enabled).toBe(true);
      expect(enabled.config.bot_token).toBe('xoxb-token');
      expect(enabled.config.app_token).toBe('xapp-token');
    });

    dbTest('enables a channel whose stored tokens are preserved via sentinel', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      const draft = await repo.create({
        name: 'Draft Slack',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: false,
        config: { bot_token: 'xoxb-stored', app_token: 'xapp-stored' },
      });

      const enabled = await repo.update(draft.id, {
        enabled: true,
        config: { bot_token: GATEWAY_REDACTED_SENTINEL, app_token: GATEWAY_REDACTED_SENTINEL },
      });

      expect(enabled.enabled).toBe(true);
      expect(enabled.config.bot_token).toBe('xoxb-stored');
      expect(enabled.config.app_token).toBe('xapp-stored');
    });

    dbTest('rejects enabling a token-less channel with the redaction sentinel', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      const draft = await repo.create({
        name: 'Draft Slack',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: false,
      });

      await expect(
        repo.update(draft.id, {
          enabled: true,
          config: { bot_token: GATEWAY_REDACTED_SENTINEL },
        })
      ).rejects.toThrow('missing required secret(s) bot_token');
    });

    dbTest('rejects an enabled channel created with the redaction sentinel', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      await expect(
        repo.create({
          name: 'Enabled Slack',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'slack',
          enabled: true,
          config: { bot_token: GATEWAY_REDACTED_SENTINEL },
        })
      ).rejects.toThrow('missing required secret(s) bot_token');
    });

    dbTest('rejects an enabled Socket Mode channel missing app_token', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      // Socket Mode (inbound) needs app_token for the WebSocket handshake.
      await expect(
        repo.create({
          name: 'Inbound Slack',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'slack',
          enabled: true,
          config: { connection_mode: 'socket', bot_token: 'xoxb-token' },
        })
      ).rejects.toThrow('missing required secret(s) app_token');
    });

    dbTest('enables an outbound-only Slack channel with only bot_token', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      // Outbound-only channels post via chat.postMessage and never listen, so
      // they legitimately need no app_token (no connection_mode set).
      const channel = await repo.create({
        name: 'Outbound Slack',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: true,
        config: { bot_token: 'xoxb-token', outbound_enabled: true },
      });

      expect(channel.enabled).toBe(true);
      expect(channel.config.bot_token).toBe('xoxb-token');
      expect(channel.config.app_token).toBeUndefined();
    });

    dbTest(
      'rejects an enabled outbound channel that also opts into inbound surfaces',
      async ({ db }) => {
        const branch = await seedBranch(db);
        const repo = new GatewayChannelRepository(db);

        // outbound_enabled alone waives app_token, but an inbound surface flag
        // (enable_channels) means the channel must LISTEN — which needs app_token.
        await expect(
          repo.create({
            name: 'Outbound+inbound Slack',
            created_by: generateId() as UUID,
            target_branch_id: branch.branch_id as UUID,
            channel_type: 'slack',
            enabled: true,
            config: { bot_token: 'xoxb-token', outbound_enabled: true, enable_channels: true },
          })
        ).rejects.toThrow('missing required secret(s) app_token');
      }
    );
  });

  describe('getRequiredSecretFields', () => {
    it('requires app_token unless the channel explicitly opts into outbound-only', () => {
      // app_token is required for any inbound/Socket-Mode channel (needs it to
      // listen) AND for unconfigured channels (default to inbound). It is NOT
      // required only for EXPLICIT outbound-only (outbound_enabled and not
      // Socket Mode) — a socket+outbound channel is still inbound.
      expect(getRequiredSecretFields('slack', { outbound_enabled: true })).toEqual(['bot_token']);
      expect(getRequiredSecretFields('slack', {})).toEqual(['bot_token', 'app_token']);
      expect(getRequiredSecretFields('slack', { connection_mode: 'socket' })).toEqual([
        'bot_token',
        'app_token',
      ]);
      expect(
        getRequiredSecretFields('slack', { outbound_enabled: true, connection_mode: 'socket' })
      ).toEqual(['bot_token', 'app_token']);
      // An inbound surface flag (public/private/group-DM listening) forces
      // app_token even when outbound is also enabled — the channel still listens.
      expect(
        getRequiredSecretFields('slack', { outbound_enabled: true, enable_channels: true })
      ).toEqual(['bot_token', 'app_token']);
      expect(getRequiredSecretFields('discord', {})).toEqual(['bot_token']);
    });
  });

  describe('Discord beta configuration', () => {
    const discordConfig = {
      bot_token: 'discord-secret',
      application_id: '111111111111111111',
      guild_id: '222222222222222222',
      allowed_channel_ids: ['333333333333333333'],
      allowed_user_ids: ['444444444444444444'],
      allowed_role_ids: [],
      message_content_enabled: true,
      thread_mode: 'public_thread_per_summon' as const,
      thread_auto_archive_minutes: 1440 as const,
      align_discord_users: false,
      catch_up: { ...DEFAULT_DISCORD_CATCH_UP },
      files: false as const,
      agent_tools: [] as never[],
    };

    it('shares browser-safe structural validation with the daemon', () => {
      const withoutToken: Record<string, unknown> = { ...discordConfig, bot_token: undefined };
      expect(validateDiscordConfig(withoutToken)).toEqual({
        ok: false,
        errors: ['bot_token is required'],
      });
      expect(validateDiscordConfig({ ...discordConfig, bot_token: 'discord-secret' })).toEqual({
        ok: true,
        errors: [],
      });
      expect(
        validateDiscordConfig(
          {
            ...discordConfig,
            bot_token: 'discord-secret',
            default_outbound_target: 'channel:999999999999999999',
          },
          { requireBotToken: true }
        ).errors
      ).toContain('default_outbound_target must target an allowed channel');
      expect(isDiscordSnowflake('18446744073709551615')).toBe(true);
      expect(isDiscordSnowflake('18446744073709551616')).toBe(false);
      expect(isDiscordSnowflake('011111111111111111')).toBe(false);
      expect(
        validateDiscordConfig({
          ...discordConfig,
          catch_up: { ...discordConfig.catch_up, max_pages: MAX_DISCORD_CATCH_UP.max_pages + 1 },
        }).errors
      ).toContain(
        `catch_up.max_pages must be an integer between ${MIN_DISCORD_CATCH_UP.max_pages} and ${MAX_DISCORD_CATCH_UP.max_pages}`
      );
    });

    dbTest('requires a complete allowlisted Discord configuration when enabled', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);
      await expect(
        repo.create({
          name: 'Invalid Discord',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'discord',
          config: { bot_token: 'discord-secret' },
        })
      ).rejects.toThrow('invalid configuration');
    });

    dbTest(
      'uses a global verified-installation uniqueness conflict without disclosure',
      async ({ db }) => {
        const branch = await seedBranch(db);
        const repo = new GatewayChannelRepository(db);
        await repo.create({
          name: 'Discord one',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'discord',
          agor_user_id: generateId() as UUID,
          provider_installation_id: discordConfig.application_id,
          config: discordConfig,
        });
        await expect(
          repo.create({
            name: 'Discord two',
            created_by: generateId() as UUID,
            target_branch_id: branch.branch_id as UUID,
            channel_type: 'discord',
            agor_user_id: generateId() as UUID,
            provider_installation_id: discordConfig.application_id,
            config: discordConfig,
          })
        ).rejects.toThrow('this Discord application is already enabled');
        await expect(
          repo.create({
            name: 'Discord three',
            created_by: generateId() as UUID,
            target_branch_id: branch.branch_id as UUID,
            channel_type: 'discord',
            agor_user_id: generateId() as UUID,
            provider_installation_id: discordConfig.application_id,
            config: discordConfig,
          })
        ).rejects.not.toThrow(/111111111111111111|tenant_id|channel_id/);
      }
    );

    dbTest('enforces aligned-versus-fixed identity with no fallback', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);
      const aligned = await repo.create({
        name: 'Discord aligned',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'discord',
        agor_user_id: null,
        provider_installation_id: '222222222222222222',
        config: {
          ...discordConfig,
          application_id: '222222222222222222',
          align_discord_users: true,
          user_map: { '444444444444444444': 'user@example.com' },
        },
      });
      expect(aligned.agor_user_id).toBeNull();
      await expect(
        repo.create({
          name: 'Discord invalid alignment',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'discord',
          agor_user_id: generateId() as UUID,
          provider_installation_id: '333333333333333333',
          config: {
            ...discordConfig,
            application_id: '333333333333333333',
            align_discord_users: true,
            user_map: { '444444444444444444': 'user@example.com' },
          },
        })
      ).rejects.toThrow('aligned identity cannot use a fixed agor_user_id');
      await expect(
        repo.create({
          name: 'Discord invalid fixed identity',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'discord',
          agor_user_id: null,
          provider_installation_id: discordConfig.application_id,
          config: discordConfig,
        })
      ).rejects.toThrow('fixed identity requires agor_user_id');
    });

    dbTest('increments authority generation but not on activity updates', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);
      const channel = await repo.create({
        name: 'Discord generation',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'discord',
        agor_user_id: generateId() as UUID,
        provider_installation_id: discordConfig.application_id,
        config: discordConfig,
      });
      expect(channel.provider_config_generation).toBe(1);
      const renamed = await repo.update(channel.id, { name: 'Discord renamed' });
      expect(renamed.provider_config_generation).toBe(1);
      await repo.updateLastMessage(channel.id);
      const touched = await repo.findById(channel.id);
      expect(touched?.provider_config_generation).toBe(1);
      const claim = await repo.claimListener({
        channelId: channel.id,
        claimToken: 'generation-test-claim',
        leaseDurationMs: 30_000,
        instanceId: 'generation-test-instance',
        bootId: 'generation-test-boot',
      });
      expect(claim.outcome).toBe('claimed');
      await repo.saveListenerCheckpoint(channel.id, 'generation-test-claim', { sequence: 1 });
      expect((await repo.findById(channel.id))?.provider_config_generation).toBe(1);
      await expect(
        repo.update(channel.id, {
          config: { allowed_channel_ids: ['555555555555555555'] },
        })
      ).rejects.toThrow('verified Discord application binding is required');
      expect(await repo.findById(channel.id)).toMatchObject({
        provider_installation_id: discordConfig.application_id,
        provider_config_generation: 1,
      });
      const disabled = await repo.update(channel.id, { enabled: false });
      expect(disabled.provider_config_generation).toBe(2);
      const rotated = await repo.update(channel.id, { config: { bot_token: 'new-token' } });
      expect(rotated.provider_installation_id).toBeNull();
      expect(rotated.provider_config_generation).toBe(3);
    });

    it('rejects unsupported capability requests and empty allowlists', () => {
      expect(
        validateDiscordConfig({
          ...discordConfig,
          allowed_user_ids: [],
          allowed_role_ids: [],
          files: true,
          agent_tools: ['history'],
        }).errors
      ).toEqual(
        expect.arrayContaining([
          'at least one allowed_user_ids or allowed_role_ids entry is required',
          'files must be false',
          'agent_tools must be an empty array',
        ])
      );
      expect(validateDiscordConfig({ ...discordConfig, user_map: {} }).errors).toContain(
        'user_map is only allowed when align_discord_users is true'
      );
      expect(
        withDiscordConfigDefaults({
          ...discordConfig,
          catch_up: undefined,
          files: undefined,
          agent_tools: undefined,
        })
      ).toMatchObject({
        catch_up: DEFAULT_DISCORD_CATCH_UP,
        files: false,
        agent_tools: [],
      });
    });

    dbTest('keeps legacy invalid Discord drafts inert', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);
      const draft = await repo.create({
        name: 'Legacy Discord draft',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'discord',
        enabled: false,
      });
      expect(draft.enabled).toBe(false);
      expect(draft.config).toEqual({});
    });
  });
});
