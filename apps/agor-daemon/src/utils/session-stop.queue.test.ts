import { DEFAULT_STATIC_TENANT_ID } from '@agor/core/config';
import {
  createTenantScopedDatabaseProxy,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
} from '@agor/core/db';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { queueTestServer, seedQueue } from '../../test/task-queue-fixture.js';
import type { SessionsServiceImpl } from '../declarations.js';
import { requestExecutorTermination } from '../termination-coordinator.js';
import { stopSessionPreserveQueue } from './session-stop.js';
import { findActiveTasksForSession } from './session-tasks.js';

// Real SQLite repositories, service hooks, active-task selection and termination
// coordinator. Deterministically advance the queue at either side of the lookup;
// no executor launch, live Session, or external process is involved.
for (const timing of ['before lookup', 'after lookup'] as const) {
  dbTest(
    `conditional Stop preserves the successor when the original finishes ${timing}`,
    async ({ db }) => {
      const guardedDb = createTenantScopedDatabaseProxy(db);
      const seed = await seedQueue(db);
      const server = await queueTestServer(guardedDb);
      const tasks = new TaskRepository(db);
      const sessions = new SessionRepository(db);
      const successor = seed.queued[0];
      const advance = async () => {
        await tasks.update(seed.active.task_id, { status: TaskStatus.COMPLETED });
        await sessions.update(seed.session.session_id, {
          status: SessionStatus.IDLE,
          ready_for_prompt: true,
        });
        expect(
          await tasks.claimDispatchAndProjectSession(successor.task_id, TaskStatus.QUEUED, {
            status: TaskStatus.DISPATCHING,
          })
        ).toMatchObject({ outcome: 'claimed' });
        await tasks.connectExecutor(successor.task_id);
      };
      const terminate = vi.fn(requestExecutorTermination);
      try {
        if (timing === 'before lookup') await advance();
        const result = await stopSessionPreserveQueue(
          {
            app: server.app,
            taskRepo: tasks,
            sessionsService: server.app.service('sessions') as unknown as SessionsServiceImpl,
            findActiveTasks: async (...args) => {
              const active = await findActiveTasksForSession(...args);
              if (timing === 'after lookup') await advance();
              return active;
            },
            requestTermination: terminate,
            runInTenantDatabaseScope: (work) =>
              runWithTenantDatabaseScope(guardedDb, DEFAULT_STATIC_TENANT_ID, work),
            runInFreshTenantWriteDatabase: (work) =>
              runWithTenantDatabaseScope(guardedDb, DEFAULT_STATIC_TENANT_ID, work),
          },
          seed.session.session_id,
          {},
          { expectedTaskId: seed.active.task_id, reason: 'Update prioritized' }
        );
        expect(result).toMatchObject({ success: false, outcome: 'condition_changed' });
        if (timing === 'before lookup') expect(terminate).not.toHaveBeenCalled();
        else {
          expect(terminate).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ taskId: seed.active.task_id })
          );
        }
        expect(await tasks.findById(successor.task_id)).toMatchObject({
          status: TaskStatus.RUNNING,
        });
        expect((await tasks.findById(successor.task_id))?.termination_request).toBeUndefined();
        expect(await sessions.findById(seed.session.session_id)).toMatchObject({
          status: SessionStatus.RUNNING,
          ready_for_prompt: false,
        });
        expect(await tasks.findById(seed.active.task_id)).toMatchObject({
          status: TaskStatus.COMPLETED,
        });
        expect(
          (await tasks.findQueued(seed.session.session_id)).map((task) => task.task_id)
        ).toEqual(seed.queued.slice(1).map((task) => task.task_id));
      } finally {
        await server.close();
      }
    }
  );
}
