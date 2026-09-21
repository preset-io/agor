import { setImmediate as nextTurn } from 'node:timers/promises';
import { generateId, SessionRepository, TaskRepository } from '@agor/core/db';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { queueClient, queueTestServer, seedQueue } from '../../test/task-queue-fixture.js';

describe('public queued-task management (SQLite)', () => {
  dbTest(
    'cancels and reorders during execution, publishes existing events, and appends after the reordered tail',
    async ({ db }) => {
      const seed = await seedQueue(db);
      const server = await queueTestServer(db);
      const tasks = new TaskRepository(db);
      const patched = vi.fn();
      const removed = vi.fn();
      server.app.service('tasks').on('patched', patched).on('removed', removed);
      try {
        const client = await queueClient(server, seed.owner.user_id);
        const ids = seed.queued.map((t) => t.task_id);
        const result = await client.reorderQueued({
          session_id: seed.session.session_id,
          expected_task_ids: ids,
          task_ids: [...ids].reverse(),
        });
        expect(result.queue.map((t) => t.task_id)).toEqual([...ids].reverse());
        expect(patched).toHaveBeenCalledTimes(3);
        const cancelled = await client.cancelQueued({
          session_id: seed.session.session_id,
          task_ids: [ids[0], ids[2]],
        });
        expect(cancelled.queue.map((t) => t.task_id)).toEqual([ids[1]]);
        expect(removed).toHaveBeenCalledTimes(2);
        expect(await tasks.findById(seed.active.task_id)).toEqual(seed.active);
        const next = await tasks.createPending({
          session_id: seed.session.session_id,
          created_by: seed.owner.user_id,
          full_prompt: 'new',
          status: TaskStatus.QUEUED,
        });
        expect(next.queue_position).toBeGreaterThan(cancelled.queue[0].queue_position!);
        const page = await client.find({
          query: {
            session_id: seed.session.session_id,
            status: TaskStatus.QUEUED,
            $sort: { queue_position: 1 },
          },
        });
        expect('data' in page && page.data.map((t) => t.task_id)).toEqual([ids[1], next.task_id]);
      } finally {
        await server.close();
      }
    }
  );

  dbTest(
    'rejects invalid, duplicate, stale, omitted, foreign-session and nonqueued IDs without partial effects',
    async ({ db }) => {
      const seed = await seedQueue(db);
      const other = await seedQueue(db);
      const server = await queueTestServer(db);
      try {
        const client = await queueClient(server, seed.owner.user_id);
        const ids = seed.queued.map((t) => t.task_id);
        const session_id = seed.session.session_id;
        for (const task_ids of [
          [ids[0], seed.active.task_id],
          [ids[0], other.queued[0].task_id],
          [ids[0], generateId()],
          [ids[0], ids[0]],
          [],
        ]) {
          await expect(client.cancelQueued({ session_id, task_ids })).rejects.toThrow();
          expect(
            (await new TaskRepository(db).findQueued(session_id)).map((t) => t.task_id)
          ).toEqual(ids);
        }
        for (const [expected_task_ids, task_ids] of [
          [ids, ids.slice(1)],
          [[...ids].reverse(), ids],
          [ids, [ids[0], ids[0], ids[2]]],
          [ids, [ids[0], ids[1], seed.active.task_id]],
          [ids, [ids[0], ids[1], other.queued[0].task_id]],
        ]) {
          await expect(
            client.reorderQueued({ session_id, expected_task_ids, task_ids })
          ).rejects.toThrow();
          expect(
            (await new TaskRepository(db).findQueued(session_id)).map((t) => t.task_id)
          ).toEqual(ids);
        }
        const denied = await queueClient(server, seed.stranger.user_id);
        await expect(denied.cancelQueued({ session_id, task_ids: [ids[0]] })).rejects.toThrow();
        await expect(
          denied.reorderQueued({ session_id, expected_task_ids: ids, task_ids: [...ids].reverse() })
        ).rejects.toThrow();
        expect(await new TaskRepository(db).findById(seed.active.task_id)).toEqual(seed.active);
      } finally {
        await server.close();
      }
    }
  );

  dbTest(
    'failure-held queues remain held and do not trigger processing or completion callbacks',
    async ({ db }) => {
      const seed = await seedQueue(db);
      const server = await queueTestServer(db);
      const triggerQueueProcessing = vi.fn();
      Object.assign(server.app.service('sessions'), { triggerQueueProcessing });
      try {
        await new TaskRepository(db).update(seed.active.task_id, { status: TaskStatus.FAILED });
        await new SessionRepository(db).update(seed.session.session_id, {
          status: SessionStatus.FAILED,
          ready_for_prompt: false,
        });
        const before = await new SessionRepository(db).findById(seed.session.session_id);
        const client = await queueClient(server, seed.owner.user_id);
        const ids = seed.queued.map((t) => t.task_id);
        await client.reorderQueued({
          session_id: seed.session.session_id,
          expected_task_ids: ids,
          task_ids: [...ids].reverse(),
        });
        await client.cancelQueued({ session_id: seed.session.session_id, task_ids: [ids[0]] });
        await nextTurn();
        expect(triggerQueueProcessing).not.toHaveBeenCalled();
        expect(await new SessionRepository(db).findById(seed.session.session_id)).toEqual(before);
      } finally {
        await server.close();
      }
    }
  );
  dbTest(
    'all nonqueued lifecycle states are ineligible and failed batches leave eligible work untouched',
    async ({ db }) => {
      const seed = await seedQueue(db);
      const server = await queueTestServer(db);
      const repository = new TaskRepository(db);
      try {
        const client = await queueClient(server, seed.owner.user_id);
        const session_id = seed.session.session_id;
        const ids = seed.queued.map((t) => t.task_id);
        for (const status of Object.values(TaskStatus).filter(
          (status) => status !== TaskStatus.QUEUED
        )) {
          const task = await repository.create({
            session_id,
            status,
            created_by: seed.owner.user_id,
            full_prompt: status,
          });
          await expect(
            client.cancelQueued({ session_id, task_ids: [ids[0], task.task_id] })
          ).rejects.toMatchObject({ code: 409 });
          await expect(
            client.reorderQueued({
              session_id,
              expected_task_ids: ids,
              task_ids: [ids[0], ids[1], task.task_id],
            })
          ).rejects.toMatchObject({ code: 409 });
          expect(await repository.findById(task.task_id)).toEqual(task);
          expect((await repository.findQueued(session_id)).map((t) => t.task_id)).toEqual(ids);
        }
      } finally {
        await server.close();
      }
    }
  );

  dbTest(
    'concurrent SQLite admissions and queue commands retain FIFO admission after the reordered tail',
    async ({ db }) => {
      const seed = await seedQueue(db);
      const server = await queueTestServer(db);
      const repository = new TaskRepository(db);
      const session_id = seed.session.session_id;
      const ids = seed.queued.map((t) => t.task_id);
      try {
        const client = await queueClient(server, seed.owner.user_id);
        await client.reorderQueued({
          session_id,
          expected_task_ids: ids,
          task_ids: [...ids].reverse(),
        });
        const outcomes = await Promise.all([
          client.cancelQueued({ session_id, task_ids: [ids[1]] }),
          ...['next-1', 'next-2', 'next-3'].map((full_prompt) =>
            repository.createPending({
              session_id,
              full_prompt,
              created_by: seed.owner.user_id,
              status: TaskStatus.QUEUED,
            })
          ),
        ]);
        expect(outcomes).toHaveLength(4);
        const queue = await repository.findQueued(session_id);
        expect(queue.slice(0, 2).map((t) => t.task_id)).toEqual([ids[2], ids[0]]);
        expect(queue.map((t) => t.queue_position)).toEqual([1, 3, 4, 5, 6]);
        expect(await repository.findById(seed.active.task_id)).toEqual(seed.active);
      } finally {
        await server.close();
      }
    }
  );
});
