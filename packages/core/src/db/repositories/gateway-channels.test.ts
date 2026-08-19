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
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { update } from '../database-wrapper';
import { gatewayChannels } from '../schema';
import { dbTest } from '../test-helpers';
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
    created_by: generateId() as UUID,
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

    dbTest('refuses to enable a Discord draft on SQLite even with a bot token', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);
      const draft = await repo.create({
        name: 'Draft Discord',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'discord',
        enabled: false,
        config: {},
      });

      await expect(repo.update(draft.id, { enabled: true })).rejects.toThrow(
        'PostgreSQL is required'
      );
      await expect(
        repo.update(draft.id, {
          enabled: true,
          config: { bot_token: 'discord-bot-token' },
        })
      ).rejects.toThrow('PostgreSQL is required');
      expect((await repo.findById(draft.id))?.enabled).toBe(false);
    });
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

  describe('verified provider installation identity', () => {
    dbTest('rejects Discord provider probe ownership on SQLite', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);
      const channel = await repo.create({
        name: 'Disabled Discord probe',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'discord',
        enabled: false,
        config: {
          bot_token: 'discord-token',
          application_id: '123456789012345678',
        },
      });
      await expect(
        repo.claimProviderProbe({
          channelId: channel.id,
          claimToken: 'probe-token',
          leaseDurationMs: 30_000,
        })
      ).rejects.toThrow(/require PostgreSQL/);
      await expect(repo.providerProbeClaimIsCurrent(channel.id, 'probe-token', 1, 1)).resolves.toBe(
        false
      );
      await expect(
        repo.renewProviderProbe({
          channelId: channel.id,
          claimToken: 'probe-token',
          generation: 1,
          providerConfigGeneration: 1,
          leaseDurationMs: 30_000,
        })
      ).rejects.toThrow(/require PostgreSQL/);
    });

    dbTest('refuses enablement while a persisted Discord probe lease is live', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);
      const channel = await repo.create({
        name: 'Disabled Discord probe',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'discord',
        enabled: false,
        config: {
          bot_token: 'discord-token',
          application_id: '123456789012345678',
        },
      });
      // SQLite cannot acquire a product probe claim. Seed only the parity
      // columns to exercise the dialect-independent update guard.
      await update(db, gatewayChannels)
        .set({
          provider_probe_claim_token: 'probe-token',
          provider_probe_lease_expires_at: new Date(Date.now() + 60_000),
          provider_probe_generation: 1,
          provider_probe_config_generation: channel.provider_config_generation,
        })
        .where(eq(gatewayChannels.id, channel.id))
        .run();

      await expect(repo.update(channel.id, { enabled: true })).rejects.toThrow(
        'Discord connection test is in progress'
      );
    });

    dbTest(
      'claims only the exact stored token/application pair and clears on credential change',
      async ({ db }) => {
        const branch = await seedBranch(db);
        const repo = new GatewayChannelRepository(db);
        const channel = await repo.create({
          name: 'Discord installation',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'discord',
          enabled: false,
          provider_installation_id: '123456789012345678',
          config: {
            bot_token: 'discord-token-a',
            application_id: '123456789012345678',
          },
        });

        expect(channel.provider_installation_id).toBeNull();
        expect(channel.provider_config_generation).toBe(1);

        expect(
          await repo.claimProviderInstallationIdentity({
            channelId: channel.id,
            channelType: 'discord',
            providerInstallationId: '123456789012345678',
            expectedConfig: {
              bot_token: 'stale-token',
              application_id: '123456789012345678',
            },
          })
        ).toBe(false);
        expect((await repo.findById(channel.id))?.provider_installation_id).toBeNull();

        expect(
          await repo.claimProviderInstallationIdentity({
            channelId: channel.id,
            channelType: 'discord',
            providerInstallationId: '123456789012345678',
            expectedConfig: {
              bot_token: 'discord-token-a',
              application_id: '123456789012345678',
            },
          })
        ).toBe(true);
        expect((await repo.findById(channel.id))?.provider_installation_id).toBe(
          '123456789012345678'
        );
        expect((await repo.findById(channel.id))?.provider_config_generation).toBe(2);
        expect(
          await repo.claimProviderInstallationIdentity({
            channelId: channel.id,
            channelType: 'discord',
            providerInstallationId: '123456789012345678',
            expectedConfig: {
              bot_token: 'discord-token-a',
              application_id: '123456789012345678',
            },
          })
        ).toBe(true);
        expect((await repo.findById(channel.id))?.provider_config_generation).toBe(2);

        const renamed = await repo.update(channel.id, { name: 'Renamed installation' });
        expect(renamed.provider_config_generation).toBe(2);

        const changed = await repo.update(channel.id, {
          config: { bot_token: 'discord-token-b' },
        });
        expect(changed.provider_installation_id).toBeNull();
        expect(changed.provider_config_generation).toBe(3);
        const redactedReplay = await repo.update(channel.id, {
          config: { bot_token: GATEWAY_REDACTED_SENTINEL },
        });
        expect(redactedReplay.provider_config_generation).toBe(3);
        await expect(repo.update(channel.id, { enabled: true })).rejects.toThrow(
          'PostgreSQL is required'
        );
        expect((await repo.findById(channel.id))?.provider_config_generation).toBe(3);
      }
    );

    dbTest('returns a generic conflict for a duplicate provider installation', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);
      const config = {
        bot_token: 'shared-token',
        application_id: '223456789012345678',
      };
      const first = await repo.create({
        name: 'First Discord installation',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'discord',
        enabled: false,
        config,
      });
      const second = await repo.create({
        name: 'Second Discord installation',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'discord',
        enabled: false,
        config,
      });
      const claim = (channelId: typeof first.id) =>
        repo.claimProviderInstallationIdentity({
          channelId,
          channelType: 'discord',
          providerInstallationId: '223456789012345678',
          expectedConfig: config,
        });

      await expect(claim(first.id)).resolves.toBe(true);
      await expect(claim(second.id)).rejects.toThrow('Provider installation is already connected');
    });
  });
});
