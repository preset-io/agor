import {
  GatewayChannelRepository,
  generateId,
  SessionRepository,
  TaskRepository,
  ThreadSessionMapRepository,
} from '@agor/core/db';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, vi } from 'vitest';
import { dbTest, setTestBranchUserRole } from '../../../../packages/core/src/db/test-helpers';
import { gatewayCommandFixture as fixture } from '../../test/gateway-command-fixture.js';

describe('gateway command atomic admission', () => {
  afterEach(() => vi.restoreAllMocks());
  dbTest(
    'plain stop refuses a populated queue without changing the active task or queue',
    async ({ db }) => {
      const f = await fixture(db);
      const result = await f.commands.execute({ ...f.input, command: 'stop' });
      expect(result.receipt).toMatchObject({ outcome: 'queue_not_empty', queued_count: 3 });
      expect(await f.tasks.findById(f.seed.active.task_id)).toEqual(f.seed.active);
      expect(await f.commands.snapshot(f.input.sessionId)).toEqual(f.input.expected);
    }
  );

  dbTest('empty-queue stop claims termination; skip preserves queued tasks', async ({ db }) => {
    const f = await fixture(db);
    const skip = await f.commands.execute({ ...f.input, command: 'skip' });
    expect(skip.receipt).toMatchObject({
      outcome: 'requested',
      task_id: f.seed.active.task_id,
      cancelled_count: 0,
    });
    expect((await f.tasks.findById(f.seed.active.task_id))?.status).toBe(TaskStatus.STOPPING);
    expect(await f.tasks.findQueued(f.input.sessionId)).toHaveLength(3);
    await f.tasks.mutateQueued(f.input.sessionId, { cancel: f.input.expected.queued_task_ids });
    const stop = await f.commands.execute({
      ...f.input,
      command: 'stop',
      providerEventId: generateId(),
      expected: await f.commands.snapshot(f.input.sessionId),
    });
    expect(stop.receipt.outcome).toBe('requested');
  });

  dbTest(
    'clear commits cancellation and termination together and never clears new work on replay',
    async ({ db }) => {
      const f = await fixture(db);
      const first = await f.commands.execute(f.input);
      expect(first.receipt).toMatchObject({ outcome: 'requested', cancelled_count: 3 });
      expect(first.removed).toHaveLength(3);
      expect((await f.tasks.findById(f.seed.active.task_id))?.status).toBe(TaskStatus.STOPPING);
      const newlyQueued = await f.tasks.createPending({
        session_id: f.input.sessionId,
        created_by: f.seed.owner.user_id,
        full_prompt: 'later',
        status: TaskStatus.QUEUED,
      });
      const replay = await f.commands.execute({
        ...f.input,
        expected: await f.commands.snapshot(f.input.sessionId),
      });
      expect(replay.receipt).toEqual(first.receipt);
      expect(replay.removed).toEqual([]);
      expect(replay.claimed).toBeNull();
      expect((await f.tasks.findQueued(f.input.sessionId)).map((t) => t.task_id)).toEqual([
        newlyQueued.task_id,
      ]);
    }
  );

  dbTest('stale task or queue snapshots produce no partial effects', async ({ db }) => {
    const f = await fixture(db);
    for (const expected of [
      { ...f.input.expected, task_id: generateId() },
      { ...f.input.expected, queued_task_ids: [...f.input.expected.queued_task_ids].reverse() },
      { ...f.input.expected, queued_task_ids: [] },
    ]) {
      const result = await f.commands.execute({
        ...f.input,
        expected,
        providerEventId: generateId(),
      });
      expect(result.receipt.outcome).toBe('condition_changed');
      expect(await f.commands.snapshot(f.input.sessionId)).toEqual(f.input.expected);
      expect(await f.tasks.findById(f.seed.active.task_id)).toEqual(f.seed.active);
    }
  });

  dbTest(
    'a collaborator who owns the session may skip but cannot partially stop-clear, even with an empty queue',
    async ({ db }) => {
      const f = await fixture(db);
      await setTestBranchUserRole(
        db,
        f.seed.branch.branch_id,
        f.seed.stranger.user_id,
        'collaborator'
      );
      await new SessionRepository(db).update(f.input.sessionId, {
        created_by: f.seed.stranger.user_id,
      });
      const denied = await f.commands.execute({ ...f.input, userId: f.seed.stranger.user_id });
      expect(denied.receipt.outcome).toBe('denied');
      expect(await f.tasks.findById(f.seed.active.task_id)).toEqual(f.seed.active);
      expect(await f.tasks.findQueued(f.input.sessionId)).toHaveLength(3);
      await f.tasks.mutateQueued(f.input.sessionId, { cancel: f.input.expected.queued_task_ids });
      const expected = await f.commands.snapshot(f.input.sessionId);
      expect(
        (await f.commands.execute({ ...f.input, userId: f.seed.stranger.user_id, expected }))
          .receipt.outcome
      ).toBe('denied');
      expect(
        (
          await f.commands.execute({
            ...f.input,
            userId: f.seed.stranger.user_id,
            expected,
            command: 'skip',
          })
        ).receipt.outcome
      ).toBe('requested');
    }
  );

  dbTest(
    'idle commands never wake the queue; clear may remove it without touching session state',
    async ({ db }) => {
      const f = await fixture(db);
      await f.tasks.update(f.seed.active.task_id, { status: TaskStatus.COMPLETED });
      await new SessionRepository(db).update(f.input.sessionId, {
        status: SessionStatus.IDLE,
        ready_for_prompt: false,
      });
      const before = await new SessionRepository(db).findById(f.input.sessionId);
      const expected = await f.commands.snapshot(f.input.sessionId);
      const skip = await f.commands.execute({ ...f.input, command: 'skip', expected });
      expect(skip.receipt.outcome).toBe('idle');
      expect(await f.tasks.findQueued(f.input.sessionId)).toHaveLength(3);
      const clear = await f.commands.execute({
        ...f.input,
        expected,
        providerEventId: generateId(),
      });
      expect(clear.receipt).toMatchObject({ outcome: 'idle', cancelled_count: 3 });
      expect(await new SessionRepository(db).findById(f.input.sessionId)).toEqual(before);
    }
  );

  dbTest('replayed skip never targets the successor task', async ({ db }) => {
    const f = await fixture(db);
    const input = { ...f.input, command: 'skip' as const };
    const first = await f.commands.execute(input);
    const token = generateId();
    await f.tasks.claimTerminationCoordination({
      taskId: f.seed.active.task_id,
      claimToken: token,
      leaseDurationMs: 60_000,
      instanceId: 'test',
      bootId: 'test',
    });
    await f.tasks.settleTermination({
      taskId: f.seed.active.task_id,
      outcome: 'verified_absent',
      coordinationToken: token,
    });
    await new SessionRepository(db).update(f.input.sessionId, {
      status: SessionStatus.IDLE,
      ready_for_prompt: true,
    });
    const next = f.seed.queued[0];
    await f.tasks.claimDispatchAndProjectSession(next.task_id, TaskStatus.QUEUED, {
      status: TaskStatus.DISPATCHING,
    });
    const replay = await f.commands.execute({
      ...input,
      expected: await f.commands.snapshot(f.input.sessionId),
    });
    expect(replay.receipt.task_id).toBe(first.receipt.task_id);
    expect(replay.claimed).toBeNull();
    expect((await f.tasks.findById(next.task_id))?.status).toBe(TaskStatus.DISPATCHING);
  });
});

describe('gateway command race fences', () => {
  dbTest('an enqueue after an empty-queue observation prevents plain stop', async ({ db }) => {
    const f = await fixture(db);
    await f.tasks.mutateQueued(f.input.sessionId, { cancel: f.input.expected.queued_task_ids });
    const expected = await f.commands.snapshot(f.input.sessionId);
    await f.tasks.createPending({
      session_id: f.input.sessionId,
      created_by: f.input.userId,
      full_prompt: 'arrived during request',
      status: TaskStatus.QUEUED,
    });
    const result = await f.commands.execute({ ...f.input, command: 'stop', expected });
    expect(result.receipt).toMatchObject({ outcome: 'queue_not_empty', queued_count: 1 });
    expect(await f.tasks.findById(f.seed.active.task_id)).toEqual(f.seed.active);
  });

  dbTest(
    'completion and successor dispatch after the snapshot cannot stop or clear the new turn',
    async ({ db }) => {
      const f = await fixture(db);
      await f.tasks.update(f.seed.active.task_id, { status: TaskStatus.COMPLETED });
      await new SessionRepository(db).update(f.input.sessionId, {
        status: SessionStatus.IDLE,
        ready_for_prompt: true,
      });
      const next = f.seed.queued[0];
      await f.tasks.claimDispatchAndProjectSession(next.task_id, TaskStatus.QUEUED, {
        status: TaskStatus.DISPATCHING,
      });
      const result = await f.commands.execute(f.input);
      expect(result.receipt.outcome).toBe('condition_changed');
      expect((await f.tasks.findById(next.task_id))?.status).toBe(TaskStatus.DISPATCHING);
      expect(await f.tasks.findQueued(f.input.sessionId)).toHaveLength(2);
    }
  );

  dbTest('a failed termination claim rolls cancellation and its receipt back', async ({ db }) => {
    const f = await fixture(db);
    const claim = vi
      .spyOn(TaskRepository.prototype, 'claimTermination')
      .mockRejectedValueOnce(new Error('injected failure'));
    try {
      await expect(f.commands.execute(f.input)).rejects.toThrow('injected failure');
      expect(await f.tasks.findQueued(f.input.sessionId)).toHaveLength(3);
      expect(await f.tasks.findById(f.seed.active.task_id)).toEqual(f.seed.active);
    } finally {
      claim.mockRestore();
    }
    expect((await f.commands.execute(f.input)).removed).toHaveLength(3);
  });

  dbTest(
    'missing provider identity fails closed without cancelling or stopping',
    async ({ db }) => {
      const f = await fixture(db);
      await expect(f.commands.execute({ ...f.input, providerEventId: undefined })).rejects.toThrow(
        'provider occurrence'
      );
      expect(await f.tasks.findQueued(f.input.sessionId)).toHaveLength(3);
      expect(await f.tasks.findById(f.seed.active.task_id)).toEqual(f.seed.active);
    }
  );
});

describe('unmapped command occurrences', () => {
  dbTest(
    'a no-session receipt prevents replay against a subsequently mapped session',
    async ({ db }) => {
      const f = await fixture(db);
      const first = await f.commands.execute({ ...f.input, sessionId: null, expected: null });
      expect(first.receipt).toMatchObject({ outcome: 'idle', session_id: null, task_id: null });
      expect(first.removed).toEqual([]);
      const replay = await f.commands.execute(f.input);
      expect(replay.receipt).toEqual(first.receipt);
      expect(replay.claimed).toBeNull();
      expect(replay.removed).toEqual([]);
      expect(await f.tasks.findById(f.seed.active.task_id)).toEqual(f.seed.active);
      expect(await f.tasks.findQueued(f.input.sessionId)).toHaveLength(3);
    }
  );

  dbTest('an unauthorized actor cannot record a no-session occurrence', async ({ db }) => {
    const f = await fixture(db);
    expect(
      (
        await f.commands.execute({
          ...f.input,
          sessionId: null,
          expected: null,
          userId: f.seed.stranger.user_id,
        })
      ).receipt.outcome
    ).toBe('denied');
    expect((await f.commands.execute(f.input)).receipt.outcome).toBe('requested');
  });
});

describe('unmentioned thread command targeting', () => {
  async function map(
    db: Parameters<typeof fixture>[0],
    f: Awaited<ReturnType<typeof fixture>>,
    threadId = f.input.threadId,
    metadata?: Record<string, unknown>
  ) {
    return new ThreadSessionMapRepository(db).create({
      channel_id: f.channel.id,
      thread_id: threadId,
      session_id: f.input.sessionId,
      branch_id: f.seed.branch.branch_id,
      metadata,
    });
  }

  dbTest(
    'one connected session accepts bare controls and retains permission checks',
    async ({ db }) => {
      const f = await fixture(db);
      await map(db, f);
      const input = { ...f.input, implicitThreadIds: [f.input.threadId] };
      expect(
        (await f.commands.execute({ ...input, userId: f.seed.stranger.user_id })).receipt.outcome
      ).toBe('denied');
      expect((await f.commands.execute(input)).receipt.outcome).toBe('requested');
      expect(await f.tasks.findQueued(f.input.sessionId)).toHaveLength(0);
    }
  );

  dbTest(
    'multiple sessions request clarification once, and disconnection does not make replay act',
    async ({ db }) => {
      const f = await fixture(db);
      await map(db, f);
      const other = await fixture(db);
      const otherMapping = await map(db, other);
      const input = { ...f.input, implicitThreadIds: [f.input.threadId] };
      const first = await f.commands.execute(input);
      expect(first.receipt.outcome).toBe('ambiguous');
      expect(
        (
          await other.commands.execute({
            ...other.input,
            implicitThreadIds: [other.input.threadId],
          })
        ).receipt.outcome
      ).toBe('not_target');
      expect(await f.commands.snapshot(f.input.sessionId)).toEqual(f.input.expected);
      expect(await other.commands.snapshot(other.input.sessionId)).toEqual(other.input.expected);
      await new ThreadSessionMapRepository(db).update(otherMapping.id, { status: 'archived' });
      expect((await f.commands.execute(input)).receipt).toEqual(first.receipt);
      expect(await f.tasks.findById(f.seed.active.task_id)).toEqual(f.seed.active);
      // A fresh, explicitly addressed occurrence still selects its own bot.
      expect(
        (await f.commands.execute({ ...f.input, providerEventId: generateId() })).receipt.outcome
      ).toBe('requested');
    }
  );

  dbTest(
    'ambiguity is clarified without Manager, but a selected stop-clear still requires it',
    async ({ db }) => {
      const f = await fixture(db);
      await map(db, f);
      const other = await fixture(db);
      const otherMapping = await map(db, other);
      await setTestBranchUserRole(
        db,
        f.seed.branch.branch_id,
        f.seed.stranger.user_id,
        'collaborator'
      );
      await new SessionRepository(db).update(f.input.sessionId, {
        created_by: f.seed.stranger.user_id,
      });
      const input = {
        ...f.input,
        userId: f.seed.stranger.user_id,
        implicitThreadIds: [f.input.threadId],
      };
      expect((await f.commands.execute(input)).receipt.outcome).toBe('ambiguous');
      await new ThreadSessionMapRepository(db).update(otherMapping.id, { status: 'archived' });
      expect(
        (await f.commands.execute({ ...input, providerEventId: generateId() })).receipt.outcome
      ).toBe('denied');
      expect(await f.tasks.findById(f.seed.active.task_id)).toEqual(f.seed.active);
      expect(await f.tasks.findQueued(f.input.sessionId)).toHaveLength(3);
    }
  );

  dbTest(
    'unmapped bare commands remain silent and cannot acquire later work on redelivery',
    async ({ db }) => {
      const f = await fixture(db);
      const first = await f.commands.execute({
        ...f.input,
        sessionId: null,
        expected: null,
        implicitThreadIds: [f.input.threadId],
      });
      expect(first.receipt).toMatchObject({ outcome: 'not_target', session_id: null });
      await map(db, f);
      expect(
        (await f.commands.execute({ ...f.input, implicitThreadIds: [f.input.threadId] })).receipt
      ).toEqual(first.receipt);
      expect(await f.tasks.findById(f.seed.active.task_id)).toEqual(f.seed.active);
    }
  );

  dbTest(
    'multiple bots for the same session elect a single responder; aliases find it',
    async ({ db }) => {
      const f = await fixture(db);
      await map(db, f, 'legacy', { gateway_reply_aliases: [f.input.threadId] });
      const other = await fixture(db);
      await new GatewayChannelRepository(db).update(other.channel.id, {
        target_branch_id: f.seed.branch.branch_id,
      });
      await new ThreadSessionMapRepository(db).create({
        channel_id: other.channel.id,
        thread_id: f.input.threadId,
        session_id: f.input.sessionId,
        branch_id: f.seed.branch.branch_id,
      });
      expect(await f.commands.resolveImplicitTarget(f.channel.id, [f.input.threadId])).toEqual({
        outcome: 'selected',
        sessionId: f.input.sessionId,
      });
      expect(await f.commands.resolveImplicitTarget(other.channel.id, [f.input.threadId])).toEqual({
        outcome: 'not_target',
        sessionId: null,
      });
    }
  );

  dbTest(
    'disabled channels, closed mappings, archived sessions and other providers do not add targets',
    async ({ db }) => {
      const f = await fixture(db);
      await map(db, f);
      for (const variant of ['disabled', 'closed', 'archived', 'provider']) {
        const other = await fixture(
          db,
          variant === 'provider'
            ? {
                channel_type: 'discord',
                provider_installation_id: '123456789012345678',
                config: {
                  bot_token: 'test-token',
                  application_id: '123456789012345678',
                  guild_id: '223456789012345678',
                  allowed_channel_ids: ['323456789012345678'],
                  allowed_user_ids: ['423456789012345678'],
                  message_content_enabled: true,
                  thread_mode: 'public_thread_per_summon',
                  align_discord_users: false,
                },
              }
            : {}
        );
        const mapping = await map(db, other);
        if (variant === 'disabled')
          await new GatewayChannelRepository(db).update(other.channel.id, { enabled: false });
        if (variant === 'closed')
          await new ThreadSessionMapRepository(db).update(mapping.id, { status: 'archived' });
        if (variant === 'archived')
          await new SessionRepository(db).update(other.input.sessionId, { archived: true });
      }
      expect(await f.commands.resolveImplicitTarget(f.channel.id, [f.input.threadId])).toEqual({
        outcome: 'selected',
        sessionId: f.input.sessionId,
      });
    }
  );
});
