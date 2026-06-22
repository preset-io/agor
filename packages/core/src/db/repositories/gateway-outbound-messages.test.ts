import type { BranchID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { GatewayOutboundMessageRepository } from './gateway-outbound-messages';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

async function seedGateway(db: Database) {
  const users = new UsersRepository(db);
  const user = await users.create({
    user_id: generateId() as UUID,
    email: 'outbound@example.com',
    name: 'Outbound User',
    role: 'member',
  });

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
    created_by: user.user_id as UUID,
  });

  const channelRepo = new GatewayChannelRepository(db);
  const channel = await channelRepo.create({
    name: 'Slack Outbound',
    created_by: user.user_id,
    target_branch_id: branch.branch_id as UUID,
    agor_user_id: user.user_id,
    channel_type: 'slack',
    config: {
      bot_token: 'xoxb-secret',
      outbound_enabled: true,
      default_outbound_target: 'channel:C123',
      allowed_outbound_targets: ['channel:C123'],
    },
  });

  return { user, branch, channel };
}

describe('GatewayOutboundMessageRepository', () => {
  dbTest('creates and finds unconsumed seed by channel/thread', async ({ db }) => {
    const { user, branch, channel } = await seedGateway(db);
    const repo = new GatewayOutboundMessageRepository(db);

    const seed = await repo.create({
      gateway_channel_id: channel.id,
      channel_type: 'slack',
      platform_channel_id: 'C123',
      platform_message_id: '171234.000100',
      platform_thread_id: 'C123-171234.000100',
      platform_permalink: 'https://slack.example/archives/C123/p171234000100',
      target_branch_id: branch.branch_id,
      emitted_by_user_id: user.user_id,
      message_text: 'Hello from Agor',
      message_preview: 'Hello from Agor',
      metadata: { purpose: 'test' },
    });

    const found = await repo.findUnconsumedByChannelAndThread(channel.id, 'C123-171234.000100');
    expect(found).toMatchObject({
      id: seed.id,
      gateway_channel_id: channel.id,
      channel_type: 'slack',
      platform_thread_id: 'C123-171234.000100',
      consumed_at: null,
      message_preview: 'Hello from Agor',
    });
  });
});
