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
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
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
    });

    expect(channel.created_by).toBe(userId);
    expect(channel.name).toBe('Test Channel');
    expect(channel.id).toBeDefined();
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
    });
  });
});
