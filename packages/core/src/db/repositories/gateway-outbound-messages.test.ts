import type { BranchID, GatewayInboundEventID, TaskID, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { GatewayOutboundMessageRepository } from './gateway-outbound-messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { ThreadSessionMapRepository } from './thread-session-map';
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

async function seedSession(db: Database, branchId: string, userId: string, sessionId: string) {
  return new SessionRepository(db).create({
    session_id: sessionId as UUID,
    branch_id: branchId as BranchID,
    created_by: userId as UUID,
    status: SessionStatus.IDLE,
    title: 'Outbound reply session',
    description: 'Outbound reply session',
    tasks: [],
  });
}

describe('GatewayOutboundMessageRepository', () => {
  dbTest('admits a seed by canonical thread or provider alias', async ({ db }) => {
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
      metadata: { purpose: 'test', provider_reply_aliases: ['C123-171234.000101'] },
    });

    const admitted = await repo.admitReplySession(channel.id, 'C123-171234.000101');
    expect(admitted).toMatchObject({
      admitted: true,
      message: { id: seed.id, platform_thread_id: 'C123-171234.000100' },
    });
    expect(admitted?.sessionId).toEqual(admitted?.message.metadata?.reply_session_admission_id);
    await seedSession(db, branch.branch_id, user.user_id, admitted!.sessionId);
  });

  dbTest('reserves one stable session for sequential and concurrent replies', async ({ db }) => {
    const { user, branch, channel } = await seedGateway(db);
    const repo = new GatewayOutboundMessageRepository(db);
    const seed = await repo.create({
      gateway_channel_id: channel.id,
      channel_type: 'slack',
      platform_channel_id: 'C123',
      platform_message_id: '171234.000100',
      platform_thread_id: 'C123-171234.000100',
      target_branch_id: branch.branch_id,
      emitted_by_user_id: user.user_id,
      message_text: 'seed',
      message_preview: 'seed',
      metadata: { provider_reply_aliases: ['C123-171234.000101'] },
    });

    const results = await Promise.all([
      repo.admitReplySession(channel.id, 'C123-171234.000100'),
      repo.admitReplySession(channel.id, 'C123-171234.000101'),
    ]);
    expect(new Set(results.map((result) => result?.sessionId)).size).toBe(1);
    expect(results.filter((result) => result?.admitted)).toHaveLength(1);
    const admission = results[0]!;
    await seedSession(db, branch.branch_id, user.user_id, admission.sessionId);
    await repo.completeReplyAdmission(seed.id, admission.sessionId);
    await expect(repo.admitReplySession(channel.id, 'C123-171234.000101')).resolves.toMatchObject({
      admitted: false,
      sessionId: admission.sessionId,
      message: { consumed_by_session_id: admission.sessionId },
    });
  });

  dbTest('merges every outbound reply alias sequentially and concurrently', async ({ db }) => {
    const { user, branch, channel } = await seedGateway(db);
    const firstSession = generateId();
    await seedSession(db, branch.branch_id, user.user_id, firstSession);
    const mapping = await new ThreadSessionMapRepository(db).create({
      channel_id: channel.id,
      thread_id: 'C123-171234.000100',
      session_id: firstSession as never,
      branch_id: branch.branch_id,
      metadata: {},
    });
    const repo = new ThreadSessionMapRepository(db);

    await repo.mergeGatewayReplyAliases(mapping.id, ['C123-171234.000101']);
    await Promise.all([
      repo.mergeGatewayReplyAliases(mapping.id, ['C123-171234.000102']),
      repo.mergeGatewayReplyAliases(mapping.id, ['C123-171234.000103']),
    ]);

    const updated = await repo.findById(mapping.id);
    expect(updated?.metadata).toMatchObject({
      gateway_reply_aliases: expect.arrayContaining([
        'C123-171234.000101',
        'C123-171234.000102',
        'C123-171234.000103',
      ]),
    });
  });

  dbTest('retains every emitted reply alias beyond one hundred chunks', async ({ db }) => {
    const { user, branch, channel } = await seedGateway(db);
    const sessionId = generateId();
    await seedSession(db, branch.branch_id, user.user_id, sessionId);
    const mapping = await new ThreadSessionMapRepository(db).create({
      channel_id: channel.id,
      thread_id: 'C123-171234.000100',
      session_id: sessionId as never,
      branch_id: branch.branch_id,
      metadata: {},
    });
    const aliases = Array.from({ length: 101 }, (_, index) => `C123-171234.${index + 101}`);
    const repo = new ThreadSessionMapRepository(db);

    for (const alias of aliases) {
      await repo.mergeGatewayReplyAliases(mapping.id, [alias]);
    }

    const updated = await repo.findById(mapping.id);
    expect(updated?.metadata?.gateway_reply_aliases).toHaveLength(101);
    expect(updated?.metadata?.gateway_reply_aliases).toEqual(expect.arrayContaining(aliases));
  });

  dbTest(
    'advances the Discord message ID only monotonically after Task admission',
    async ({ db }) => {
      const { user, branch, channel } = await seedGateway(db);
      const sessionId = generateId();
      await seedSession(db, branch.branch_id, user.user_id, sessionId);
      const repo = new ThreadSessionMapRepository(db);
      const mapping = await repo.create({
        channel_id: channel.id,
        thread_id: '900000000000000001',
        session_id: sessionId as never,
        branch_id: branch.branch_id,
        metadata: { discord_thread: { starter_message_id: '900000000000000001' } },
      });

      expect(mapping.discord_last_admitted_message_id).toBeNull();
      await expect(
        repo.advanceDiscordLastAdmittedMessageId(mapping.id, '900000000000000010')
      ).resolves.toBe(true);
      await expect(
        repo.advanceDiscordLastAdmittedMessageId(mapping.id, '900000000000000009')
      ).resolves.toBe(false);
      await expect(
        repo.advanceDiscordLastAdmittedMessageId(mapping.id, '900000000000000011')
      ).resolves.toBe(true);
      await expect(repo.findById(mapping.id)).resolves.toMatchObject({
        discord_last_admitted_message_id: '900000000000000011',
      });
    }
  );

  dbTest('completes seed initial prompt only for its matching event', async ({ db }) => {
    const { user, branch, channel } = await seedGateway(db);
    const sessionId = generateId();
    await seedSession(db, branch.branch_id, user.user_id, sessionId);
    const repo = new ThreadSessionMapRepository(db);
    const mapping = await repo.create({
      channel_id: channel.id,
      thread_id: 'C123-171234.000100',
      session_id: sessionId as never,
      branch_id: branch.branch_id,
      metadata: {
        keep: 'value',
        outbound_seed_initial_prompt_pending: true,
        outbound_seed_initial_event_id: 'event-a',
      },
    });
    const eventA = 'event-a' as GatewayInboundEventID;
    const eventB = 'event-b' as GatewayInboundEventID;
    const taskA = 'task-a' as TaskID;

    await expect(
      repo.completeSeedInitialPrompt(mapping.id, eventB, 'task-b' as TaskID)
    ).resolves.toBe(false);
    expect((await repo.findById(mapping.id))?.metadata).toMatchObject({
      keep: 'value',
      outbound_seed_initial_prompt_pending: true,
      outbound_seed_initial_event_id: eventA,
    });

    await expect(repo.completeSeedInitialPrompt(mapping.id, eventA, taskA)).resolves.toBe(true);
    expect((await repo.findById(mapping.id))?.metadata).toMatchObject({
      keep: 'value',
      outbound_seed_initial_prompt_pending: false,
      outbound_seed_initial_task_id: taskA,
      outbound_seed_initial_event_id: eventA,
    });
    await expect(
      repo.completeSeedInitialPrompt(mapping.id, eventA, 'task-again' as TaskID)
    ).resolves.toBe(false);

    const malformed = await repo.create({
      channel_id: channel.id,
      thread_id: 'C123-171234.000101',
      session_id: sessionId as never,
      branch_id: branch.branch_id,
      metadata: { outbound_seed_initial_prompt_pending: true, outbound_seed_initial_event_id: 42 },
    });
    await expect(repo.completeSeedInitialPrompt(malformed.id, undefined, taskA)).resolves.toBe(
      false
    );
    expect((await repo.findById(malformed.id))?.metadata).toMatchObject({
      outbound_seed_initial_prompt_pending: true,
      outbound_seed_initial_event_id: 42,
    });

    const unbound = await repo.create({
      channel_id: channel.id,
      thread_id: 'C123-171234.000102',
      session_id: sessionId as never,
      branch_id: branch.branch_id,
      metadata: { keep: 'unbound', outbound_seed_initial_prompt_pending: true },
    });
    await expect(repo.completeSeedInitialPrompt(unbound.id, undefined, taskA)).resolves.toBe(true);
    expect((await repo.findById(unbound.id))?.metadata).toMatchObject({
      keep: 'unbound',
      outbound_seed_initial_prompt_pending: false,
      outbound_seed_initial_task_id: taskA,
    });
  });
});
