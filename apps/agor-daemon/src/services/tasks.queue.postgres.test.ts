/** Real public services, JWT/RBAC/RLS, and independent PostgreSQL connections. */
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  runWithoutTenantDatabaseScope,
  runWithTenantDatabaseScope,
  SessionRepository,
  sql,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { queueClient, queueTestServer, seedQueue } from '../../test/task-queue-fixture.js';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'public queue management PostgreSQL/HA',
  () => {
    let a: Database;
    let b: Database;
    beforeAll(async () => {
      a = createDatabase({ dialect: 'postgresql', url: url! });
      b = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(a);
      const result = await executeRaw(
        a,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    }, 60000);
    afterAll(async () => {
      await Promise.all(
        [a, b].map((db) => (db as Database & { $client: { end(): Promise<void> } }).$client.end())
      );
    });

    async function fixture() {
      const tenant = `queue-${generateId()}`;
      const seed = await runWithTenantDatabaseScope(a, tenant, seedQueue);
      const serverA = await queueTestServer(createTenantScopedDatabaseProxy(a), true);
      const serverB = await queueTestServer(createTenantScopedDatabaseProxy(b), true);
      const clientA = await queueClient(serverA, seed.owner.user_id, tenant);
      const clientB = await queueClient(serverB, seed.owner.user_id, tenant);
      return {
        tenant,
        seed,
        serverA,
        serverB,
        clientA,
        clientB,
        close: () => Promise.all([serverA.close(), serverB.close()]),
      };
    }

    it('two public reorders elect one winner; cancel is atomic and current execution is untouched', async () => {
      const f = await fixture();
      const session_id = f.seed.session.session_id;
      const ids = f.seed.queued.map((t) => t.task_id);
      const patched = vi.fn();
      f.serverA.app.service('tasks').on('patched', patched);
      try {
        const results = await Promise.allSettled([
          f.clientA.reorderQueued({
            session_id,
            expected_task_ids: ids,
            task_ids: [...ids].reverse(),
          }),
          f.clientB.reorderQueued({
            session_id,
            expected_task_ids: ids,
            task_ids: [ids[1], ids[0], ids[2]],
          }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
        await expect(
          f.clientA.cancelQueued({ session_id, task_ids: [ids[0], f.seed.active.task_id] })
        ).rejects.toMatchObject({ code: 409 });
        const result = await f.clientB.cancelQueued({ session_id, task_ids: [ids[0], ids[2]] });
        expect(result.queue.map((t) => t.task_id)).toEqual([ids[1]]);
        await runWithTenantDatabaseScope(a, f.tenant, async (db) => {
          expect(await new TaskRepository(db).findById(f.seed.active.task_id)).toEqual(
            f.seed.active
          );
          expect(await new TaskRepository(db).findById(ids[0])).toBeNull();
        });
      } finally {
        await f.close();
      }
    });

    it('Session lock serializes public reorder with actual admission; stale enqueue snapshot has no events or writes', async () => {
      const f = await fixture();
      const session_id = f.seed.session.session_id;
      const ids = f.seed.queued.map((t) => t.task_id);
      const patched = vi.fn();
      f.serverB.app.service('tasks').on('patched', patched);
      try {
        let pending!: ReturnType<typeof f.clientB.reorderQueued>;
        await runWithTenantDatabaseScope(a, f.tenant, async (db) => {
          await executeRaw(
            db,
            sql`SELECT 1 FROM sessions WHERE session_id = ${session_id} FOR UPDATE`
          );
          let settled = false;
          pending = f.clientB.reorderQueued({
            session_id,
            expected_task_ids: ids,
            task_ids: [...ids].reverse(),
          });
          void pending.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            }
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(settled).toBe(false);
          await new TaskRepository(db).createPending({
            session_id,
            created_by: f.seed.owner.user_id,
            full_prompt: 'concurrent admission',
            status: TaskStatus.QUEUED,
          });
          expect(patched).not.toHaveBeenCalled();
        });
        await expect(pending).rejects.toMatchObject({ code: 409 });
        expect(patched).not.toHaveBeenCalled();
        await runWithTenantDatabaseScope(a, f.tenant, async (db) => {
          const queue = await new TaskRepository(db).findQueued(session_id);
          expect(queue.slice(0, 3).map((t) => t.task_id)).toEqual(ids);
          expect(queue.map((t) => t.queue_position)).toEqual([1, 2, 3, 4]);
        });
      } finally {
        await f.close();
      }
    });

    it('dispatch winning the Session lock makes selected batch cancellation fail without deleting the remainder', async () => {
      const f = await fixture();
      const session_id = f.seed.session.session_id;
      const ids = f.seed.queued.map((t) => t.task_id);
      try {
        await runWithTenantDatabaseScope(a, f.tenant, async (db) => {
          await new TaskRepository(db).update(f.seed.active.task_id, {
            status: TaskStatus.COMPLETED,
          });
          await new SessionRepository(db).update(session_id, {
            status: SessionStatus.IDLE,
            ready_for_prompt: true,
          });
        });
        let pending!: ReturnType<typeof f.clientB.cancelQueued>;
        await runWithTenantDatabaseScope(a, f.tenant, async (db) => {
          await executeRaw(
            db,
            sql`SELECT 1 FROM sessions WHERE session_id = ${session_id} FOR UPDATE`
          );
          pending = f.clientB.cancelQueued({ session_id, task_ids: [ids[0], ids[1]] });
          void pending.catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(
            (
              await new TaskRepository(db).claimDispatchAndProjectSession(
                ids[0],
                TaskStatus.QUEUED,
                { status: TaskStatus.DISPATCHING }
              )
            ).outcome
          ).toBe('claimed');
        });
        await expect(pending).rejects.toMatchObject({ code: 409 });
        await runWithTenantDatabaseScope(a, f.tenant, async (db) => {
          const tasks = new TaskRepository(db);
          expect((await tasks.findQueued(session_id)).map((t) => t.task_id)).toEqual(ids.slice(1));
          expect((await tasks.findById(ids[0]))?.status).toBe(TaskStatus.DISPATCHING);
        });
      } finally {
        await f.close();
      }
    });

    it('cross-tenant sessions and IDs fail closed, as do same-tenant users without Manager capability', async () => {
      const f = await fixture();
      const foreignTenant = `foreign-${generateId()}`;
      const foreign = await runWithTenantDatabaseScope(a, foreignTenant, async (db) => {
        const seeded = await seedQueue(db);
        await new UsersRepository(db).update(seeded.owner.user_id, { role: 'admin' });
        return seeded;
      });
      const session_id = f.seed.session.session_id;
      const ids = f.seed.queued.map((t) => t.task_id);
      try {
        const denied = await queueClient(f.serverB, f.seed.stranger.user_id, f.tenant);
        const foreignClient = await queueClient(f.serverB, foreign.owner.user_id, foreignTenant);
        for (const client of [denied, foreignClient]) {
          await expect(client.cancelQueued({ session_id, task_ids: [ids[0]] })).rejects.toThrow();
          await expect(
            client.reorderQueued({
              session_id,
              expected_task_ids: ids,
              task_ids: [...ids].reverse(),
            })
          ).rejects.toThrow();
        }
        await expect(
          f.clientA.cancelQueued({ session_id, task_ids: [ids[0], foreign.queued[0].task_id] })
        ).rejects.toMatchObject({ code: 409 });
        await expect(
          f.clientA.reorderQueued({
            session_id,
            expected_task_ids: ids,
            task_ids: [ids[0], ids[1], foreign.queued[0].task_id],
          })
        ).rejects.toMatchObject({ code: 409 });
        await runWithTenantDatabaseScope(a, f.tenant, async (db) =>
          expect(
            (await new TaskRepository(db).findQueued(session_id)).map((t) => t.task_id)
          ).toEqual(ids)
        );
      } finally {
        await f.close();
      }
    });

    it('cancellation commits before a waiting dispatch; events and wakeups are postcommit, rollback publishes nothing', async () => {
      const f = await fixture();
      const session_id = f.seed.session.session_id;
      const ids = f.seed.queued.map((t) => t.task_id);
      const service = f.serverA.app.service(
        'tasks'
      ) as unknown as import('./tasks.js').TasksService;
      const params = {
        provider: 'mcp',
        authenticated: true,
        user: f.seed.owner,
        tenant: { tenant_id: f.tenant, source: 'explicit' },
      } as import('./tasks.js').TaskParams;
      const removed = vi.fn();
      const patched = vi.fn();
      const wake = vi.fn().mockResolvedValue(undefined);
      f.serverA.app.service('tasks').on('removed', removed).on('patched', patched);
      Object.assign(f.serverA.app.service('sessions'), { triggerQueueProcessing: wake });
      try {
        await expect(
          runWithTenantDatabaseScope(a, f.tenant, async () => {
            await service.reorderQueued(
              { session_id, expected_task_ids: ids, task_ids: [...ids].reverse() },
              params
            );
            expect(patched).not.toHaveBeenCalled();
            throw new Error('rollback queue command');
          })
        ).rejects.toThrow('rollback queue command');
        expect(patched).not.toHaveBeenCalled();
        await runWithTenantDatabaseScope(a, f.tenant, async (db) => {
          expect(
            (await new TaskRepository(db).findQueued(session_id)).map((t) => t.task_id)
          ).toEqual(ids);
          await new TaskRepository(db).update(f.seed.active.task_id, {
            status: TaskStatus.COMPLETED,
          });
          await new SessionRepository(db).update(session_id, {
            status: SessionStatus.IDLE,
            ready_for_prompt: true,
          });
        });
        let claimant!: Promise<unknown>;
        await runWithTenantDatabaseScope(a, f.tenant, async (db) => {
          await executeRaw(
            db,
            sql`SELECT 1 FROM sessions WHERE session_id = ${session_id} FOR UPDATE`
          );
          claimant = runWithoutTenantDatabaseScope(() =>
            runWithTenantDatabaseScope(b, f.tenant, (scoped) =>
              new TaskRepository(scoped).claimDispatchAndProjectSession(ids[0], TaskStatus.QUEUED, {
                status: TaskStatus.DISPATCHING,
              })
            )
          );
          void claimant.catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 100));
          await service.cancelQueued({ session_id, task_ids: [ids[0]] }, params);
          expect(removed).not.toHaveBeenCalled();
          expect(wake).not.toHaveBeenCalled();
        });
        await expect(claimant).rejects.toThrow();
        expect(removed).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
        await runWithTenantDatabaseScope(a, f.tenant, async (db) => {
          expect(await new TaskRepository(db).findById(ids[0])).toBeNull();
          expect(
            (
              await new TaskRepository(db).claimDispatchAndProjectSession(
                ids[1],
                TaskStatus.QUEUED,
                {
                  status: TaskStatus.DISPATCHING,
                }
              )
            ).outcome
          ).toBe('claimed');
        });
      } finally {
        await f.close();
      }
    });

    it('concurrent public cancellation, reorder and admissions preserve a complete ordered queue', async () => {
      const f = await fixture();
      const session_id = f.seed.session.session_id;
      const ids = f.seed.queued.map((t) => t.task_id);
      try {
        const operations = await Promise.allSettled([
          f.clientA.cancelQueued({ session_id, task_ids: [ids[1]] }),
          f.clientB.reorderQueued({
            session_id,
            expected_task_ids: ids,
            task_ids: [...ids].reverse(),
          }),
          ...['new-1', 'new-2', 'new-3'].map((full_prompt) =>
            runWithTenantDatabaseScope(b, f.tenant, (db) =>
              new TaskRepository(db).createPending({
                session_id,
                full_prompt,
                created_by: f.seed.owner.user_id,
                status: TaskStatus.QUEUED,
              })
            )
          ),
        ]);
        expect(operations[0].status).toBe('fulfilled');
        expect(operations.slice(2).every((r) => r.status === 'fulfilled')).toBe(true);
        await runWithTenantDatabaseScope(a, f.tenant, async (db) => {
          const queue = await new TaskRepository(db).findQueued(session_id);
          expect(queue).toHaveLength(5);
          expect(queue.slice(0, 2).map((t) => t.task_id)).toEqual(
            operations[1].status === 'fulfilled' ? [ids[2], ids[0]] : [ids[0], ids[2]]
          );
          expect(new Set(queue.map((t) => t.queue_position)).size).toBe(5);
          expect(queue.map((t) => t.queue_position)).toEqual(
            queue.map((t) => t.queue_position).sort((x, y) => x! - y!)
          );
          expect(await new TaskRepository(db).findById(f.seed.active.task_id)).toEqual(
            f.seed.active
          );
        });
      } finally {
        await f.close();
      }
    });
  }
);
