import { generateId, SessionRepository, TaskRepository } from '@agor/core/db';
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
