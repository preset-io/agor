import type { UUID } from '@agor/core/types';
import { expect } from 'vitest';

import { generateId } from '../../lib/ids';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { ThreadSessionMapRepository } from './thread-session-map';

dbTest(
  'countActiveDiscordProgress is channel-scoped, strict, terminal-aware, and capped',
  async ({ db }) => {
    const owner = generateId() as UUID;
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: 'discord-presence/repo',
      name: 'discord-presence',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/discord-presence.git',
      local_path: '/tmp/discord-presence',
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: 'main',
      ref: 'main',
      branch_unique_id: 919_000,
      path: '/tmp/discord-presence/main',
      created_by: owner,
    });
    const channels = new GatewayChannelRepository(db);
    const channel = await channels.create({
      id: generateId(),
      name: 'presence',
      channel_type: 'discord',
      created_by: owner,
      agor_user_id: owner,
      target_branch_id: branch.branch_id,
      channel_key: generateId(),
      enabled: false,
      config: {},
    });
    const otherChannel = await channels.create({
      id: generateId(),
      name: 'other presence',
      channel_type: 'discord',
      created_by: owner,
      agor_user_id: owner,
      target_branch_id: branch.branch_id,
      channel_key: generateId(),
      enabled: false,
      config: {},
    });
    const mappings = new ThreadSessionMapRepository(db);
    let threadSequence = 0;
    async function add(
      targetChannelId: typeof channel.id,
      state: string,
      status: 'active' | 'archived' = 'active',
      valid = true
    ) {
      const session = await new SessionRepository(db).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'claude-code',
        created_by: owner,
      });
      threadSequence += 1;
      return mappings.create({
        id: generateId(),
        channel_id: targetChannelId,
        thread_id: `discord:9234567890123456${String(threadSequence).padStart(2, '0')}`,
        session_id: session.session_id,
        branch_id: branch.branch_id,
        status,
        metadata: {
          discord_progress_task_id: valid ? generateId() : 'not-a-task',
          discord_progress_revision: 1,
          discord_progress_state: state,
        },
      });
    }
    await add(channel.id, 'queued');
    await add(channel.id, 'working');
    await add(channel.id, 'done');
    await add(channel.id, 'failed');
    await add(channel.id, 'working', 'archived');
    await add(channel.id, 'working', 'active', false);
    await add(otherChannel.id, 'working');

    expect(await mappings.countActiveDiscordProgress(channel.id)).toBe(2);
    expect(await mappings.countActiveDiscordProgress(channel.id, 1)).toBe(1);
    await expect(mappings.countActiveDiscordProgress(channel.id, 0)).rejects.toThrow(/display cap/);
  }
);

dbTest('atomic metadata delivery updates preserve unrelated provider state', async ({ db }) => {
  const owner = generateId() as UUID;
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: 'atomic-thread-map/repo',
    name: 'atomic-thread-map',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/atomic-thread-map.git',
    local_path: '/tmp/atomic-thread-map',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'main',
    ref: 'main',
    branch_unique_id: 919_001,
    path: '/tmp/atomic-thread-map/main',
    created_by: owner,
  });
  const channel = await new GatewayChannelRepository(db).create({
    id: generateId(),
    name: 'atomic mappings',
    channel_type: 'discord',
    created_by: owner,
    agor_user_id: owner,
    target_branch_id: branch.branch_id,
    channel_key: generateId(),
    enabled: false,
    config: {},
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'claude-code',
    created_by: owner,
  });
  const mappings = new ThreadSessionMapRepository(db);
  const mapping = await mappings.create({
    id: generateId(),
    channel_id: channel.id,
    thread_id: 'discord:423456789012345678',
    session_id: session.session_id,
    branch_id: branch.branch_id,
    status: 'active',
    metadata: { concurrent_provider_key: 'retained' },
  });

  const delivered = await mappings.updateMetadataAtomic(mapping.id, (metadata) => ({
    ...metadata,
    discord_last_delivered_message_id: '623456789012345678',
  }));
  expect(delivered.metadata).toMatchObject({
    concurrent_provider_key: 'retained',
    discord_last_delivered_message_id: '623456789012345678',
  });

  const duplicate = await mappings.create({
    id: generateId(),
    channel_id: channel.id,
    thread_id: 'discord:423456789012345679',
    session_id: session.session_id,
    branch_id: branch.branch_id,
    status: 'active',
  });
  expect(await mappings.findActiveBySessionBounded(session.session_id)).toHaveLength(2);
  await mappings.update(duplicate.id, { status: 'archived' });
  expect(await mappings.findActiveBySessionBounded(session.session_id)).toEqual([
    expect.objectContaining({ id: mapping.id, status: 'active' }),
  ]);
});
