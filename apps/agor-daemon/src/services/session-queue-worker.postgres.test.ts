/**
 * PostgreSQL-gated proof that two independently constructed daemon queue
 * workers can discover the same admitted Task while the production Task
 * service/repository fence emits only one executor-launch intent.
 */

import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  sql,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { SessionID, TaskID, TenantID, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionQueueWorker } from './session-queue-worker.js';
import { TasksService } from './tasks.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() % 1_000_000) + 5_000_000;

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'SessionQueueWorker two-daemon PostgreSQL integration',
  () => {
    let dbA: Database;
    let dbB: Database;

    beforeAll(async () => {
      dbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(dbA);
    });

    afterAll(async () => {
      await Promise.all(
        [dbA, dbB].map((database) =>
          (database as Database & { $client: { end: () => Promise<void> } }).$client.end()
        )
      );
    });

    it('admits one queued Task and fences two peer dispatch attempts to one launch intent', async () => {
      const tenantId = `daemon-queue-${generateId()}` as TenantID;
      expect((dbA as Database & { $client: unknown }).$client).not.toBe(
        (dbB as Database & { $client: unknown }).$client
      );
      const backendIds = await Promise.all(
        [dbA, dbB].map((database) =>
          runWithTenantDatabaseScope(database, tenantId, async (scoped) => {
            const result = await (
              scoped as unknown as {
                execute(query: unknown): Promise<Array<{ backend_pid: number }>>;
              }
            ).execute(sql`SELECT pg_backend_pid() AS backend_pid`);
            return result[0]?.backend_pid;
          })
        )
      );
      expect(backendIds[0]).toEqual(expect.any(Number));
      expect(backendIds[1]).toEqual(expect.any(Number));
      expect(backendIds[0]).not.toBe(backendIds[1]);

      const seeded = await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${tenantId}@example.com`,
          name: 'Daemon queue integration',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId(),
          slug: tenantId,
          name: tenantId,
          repo_type: 'remote',
          remote_url: 'https://example.invalid/daemon-queue.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: tenantId,
          ref: 'main',
          branch_unique_id: branchUnique++,
          path: `/tmp/${generateId()}`,
          created_by: user.user_id,
        });
        const session = await new SessionRepository(scoped).create({
          session_id: generateId() as SessionID,
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'codex',
          status: SessionStatus.IDLE,
          ready_for_prompt: true,
        });
        const task = await new TaskRepository(scoped).createPending({
          task_id: generateId() as TaskID,
          session_id: session.session_id,
          created_by: user.user_id as UUID,
          full_prompt: 'deterministic two-daemon queue proof',
          status: TaskStatus.QUEUED,
        });
        return { session, task };
      });

      let discoveries = 0;
      let releaseDiscoveries!: () => void;
      const bothDiscovered = new Promise<void>((resolve) => {
        releaseDiscoveries = resolve;
      });
      const launchOwners: string[] = [];

      const makeDaemon = (instanceId: string, database: Database) => {
        const scopedDb = createTenantScopedDatabaseProxy(database, {
          requireScope: true,
          label: `${instanceId} queue integration`,
        });
        let tasksService: TasksService;
        const taskEvents = { emit: vi.fn() };
        const app = {
          get: (name: string) => (name === 'config' ? { execution: {} } : undefined),
          service: (name: string) => (name === 'tasks' ? taskEvents : undefined),
        } as unknown as Application;
        tasksService = new TasksService(scopedDb, app as never);

        const discover = async () => {
          const refs = await runWithTenantDatabaseScope(scopedDb, tenantId, (tenantDb) =>
            new TaskRepository(tenantDb).findQueuedSessionRefs(25)
          );
          discoveries += 1;
          if (discoveries === 2) releaseDiscoveries();
          await bothDiscovered;
          return refs;
        };

        const worker = new SessionQueueWorker(scopedDb, {
          tenantId,
          workIdentity: { instanceId, bootId: `${instanceId}-boot` },
          discover,
          processSession: async (sessionId, params) => {
            expect(sessionId).toBe(seeded.session.session_id);
            await runWithTenantDatabaseScope(scopedDb, tenantId, async () => {
              const claim = await tasksService.claimDispatchAndProjectSession(
                seeded.task.task_id,
                TaskStatus.QUEUED,
                { status: TaskStatus.DISPATCHING },
                params as never
              );
              if (claim.outcome === 'claimed') launchOwners.push(instanceId);
            });
          },
        });
        return { app, worker, taskEvents };
      };

      const daemonA = makeDaemon('daemon-a', dbA);
      const daemonB = makeDaemon('daemon-b', dbB);
      expect(daemonA.app).not.toBe(daemonB.app);
      await expect(
        Promise.all([daemonA.worker.checkOnce(), daemonB.worker.checkOnce()])
      ).resolves.toEqual([1, 1]);

      expect(launchOwners).toHaveLength(1);
      expect(['daemon-a', 'daemon-b']).toContain(launchOwners[0]);
      expect(
        daemonA.taskEvents.emit.mock.calls.length + daemonB.taskEvents.emit.mock.calls.length
      ).toBe(1);
      // Read the winner through the peer connection rather than the seeding
      // connection, proving that no process-local service state is authority.
      await runWithTenantDatabaseScope(dbB, tenantId, async (scoped) => {
        expect(await new TaskRepository(scoped).findById(seeded.task.task_id)).toMatchObject({
          status: TaskStatus.DISPATCHING,
          queue_position: undefined,
        });
        expect(
          await new SessionRepository(scoped).findById(seeded.session.session_id)
        ).toMatchObject({
          status: SessionStatus.RUNNING,
          ready_for_prompt: false,
          tasks: [seeded.task.task_id],
        });
      });
    });
  }
);
