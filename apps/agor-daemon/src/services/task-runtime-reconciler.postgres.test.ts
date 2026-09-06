/**
 * PostgreSQL-gated integration for two independently constructed Task runtime
 * reconcilers sharing durable state.
 */

import { createHash } from 'node:crypto';
import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  ExecutorSessionTokenAuthorityRepository,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Params, SessionID, TaskID, TenantID, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Application } from '../declarations.js';
import { prepareTaskRuntimeStartup, type StartupContext } from '../startup.js';
import { TaskRuntimeReconciler } from './task-runtime-reconciler.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() % 1_000_000) + 3_000_000;

function createDaemonApp(
  scopedDb: TenantScopeAwareDatabase,
  identity: { instanceId: string; bootId: string },
  observations: string[]
) {
  const tasks = new TaskRepository(scopedDb);
  const sessions = new SessionRepository(scopedDb);
  const taskService = {
    get: async (id: string) => {
      const task = await tasks.findById(id);
      if (!task) throw new Error(`Task not found: ${id}`);
      return task;
    },
    recordExecutorStartupWarning: (id: string, warning: string) =>
      tasks.recordExecutorStartupWarning(id, warning),
    claimTermination: async (input: Parameters<TaskRepository['claimTermination']>[0]) => {
      const result = await tasks.claimTermination(input);
      if (result.outcome === 'claimed') {
        observations.push('task_stopping');
        await sessions.update(result.task.session_id, {
          status: SessionStatus.STOPPING,
          ready_for_prompt: false,
        });
      }
      // Simulate the still-connected remote executor observing STOPPING through
      // either daemon and durably reporting cooperative SDK quiescence.
      if (
        result.task.status === TaskStatus.STOPPING &&
        result.task.termination_request &&
        !result.task.termination_request.executor_quiesced_at
      ) {
        const quiesced = await tasks.recordExecutorQuiescence({
          task_id: result.task.task_id,
          requested_at: result.task.termination_request.requested_at,
        });
        if (quiesced) return { ...result, task: quiesced };
      }
      return result;
    },
    claimTerminationCoordination: async (
      input: Parameters<TaskRepository['claimTerminationCoordination']>[0]
    ) => {
      const result = await tasks.claimTerminationCoordination(input);
      observations.push(`coordination_${result.outcome}`);
      return result;
    },
    settleTermination: async (
      input: Parameters<TaskRepository['settleTermination']>[0],
      _params?: Params
    ) => {
      const result = await tasks.settleTermination(input);
      if (result.outcome === 'transitioned') {
        observations.push('task_settled');
        const projected = await sessions.findById(result.task.session_id);
        if (!projected?.ready_for_prompt) throw new Error('Session projection was not committed');
        observations.push('session_projected');
      }
      return result;
    },
  };
  const app = {
    get: (name: string) => (name === 'distributedWorkIdentity' ? identity : undefined),
    service: (name: string) => {
      if (name === 'tasks') return taskService;
      if (name === 'sessions') {
        return {
          get: async (id: string) => {
            const session = await sessions.findById(id);
            if (!session) throw new Error(`Session not found: ${id}`);
            return session;
          },
        };
      }
      throw new Error(`Unknown service: ${name}`);
    },
  };
  return app as unknown as Application;
}

async function seed(db: Database) {
  const tenantId = `daemon-reconciler-${generateId()}` as TenantID;
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}@example.com`,
      name: 'Task runtime reconciler',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: tenantId,
      name: tenantId,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/reconciler.git',
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
      status: SessionStatus.RUNNING,
      ready_for_prompt: false,
    });
    const tasks = new TaskRepository(scoped);
    const active = await tasks.create({
      task_id: generateId() as TaskID,
      session_id: session.session_id,
      created_by: user.user_id as UUID,
      full_prompt: 'stale remote task',
      status: TaskStatus.DISPATCHING,
      executor_mode: 'templated',
      message_range: {
        start_index: 0,
        end_index: 0,
        start_timestamp: '2000-01-01T00:00:00.000Z',
      },
      git_state: { ref_at_start: 'main', sha_at_start: 'stale' },
      tool_use_count: 0,
    });
    const tokenFingerprint = createHash('sha256').update(active.task_id).digest('hex');
    const authority = {
      token_fingerprint: tokenFingerprint,
      principal_user_id: user.user_id,
      session_id: session.session_id,
      branch_id: branch.branch_id,
    };
    await tasks.bindExecutorLaunchAuthority(active.task_id);
    await tasks.connectExecutor(active.task_id, new Date('2000-01-01T00:00:01.000Z'));
    const tokenNow = new Date();
    await new ExecutorSessionTokenAuthorityRepository(scoped).issue({
      tenantId,
      tokenFingerprint,
      tokenType: 'executor-session',
      purpose: 'executor-task',
      sessionId: session.session_id,
      taskId: active.task_id,
      branchId: branch.branch_id,
      userId: user.user_id,
      createdAt: tokenNow,
      expiresAt: new Date(tokenNow.getTime() + 60_000),
      maxUses: -1,
    });
    const queued = await tasks.create({
      task_id: generateId() as TaskID,
      session_id: session.session_id,
      created_by: user.user_id as UUID,
      full_prompt: 'preserve me',
      status: TaskStatus.QUEUED,
      queue_position: 1,
      message_range: {
        start_index: -1,
        end_index: -1,
        start_timestamp: new Date().toISOString(),
      },
      git_state: { ref_at_start: '', sha_at_start: '' },
      tool_use_count: 0,
    });
    return { tenantId, session, active, queued, authority };
  });
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'TaskRuntimeReconciler two-daemon PostgreSQL integration',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
    });

    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('elects one containment path, settles before Session projection, and preserves the queue', async () => {
      const seeded = await seed(db);
      const scopedA = createTenantScopedDatabaseProxy(db, {
        requireScope: true,
        label: 'daemon A task runtime',
      });
      const scopedB = createTenantScopedDatabaseProxy(db, {
        requireScope: true,
        label: 'daemon B task runtime',
      });
      const observations: string[] = [];
      const identityA = { instanceId: 'daemon-a', bootId: 'boot-a' };
      const identityB = { instanceId: 'daemon-b', bootId: 'boot-b' };
      const appA = createDaemonApp(scopedA, identityA, observations);
      const appB = createDaemonApp(scopedB, identityB, observations);
      const options = {
        config: {
          enabled: true,
          interval_ms: 1000,
          stale_after_ms: 1,
          callback: { command_template: null, timeout_ms: 3000 },
        },
        tenantId: seeded.tenantId,
        startupOffsetMaxMs: 0,
      };
      const reconcilerA = new TaskRuntimeReconciler({
        app: appA,
        db: scopedA,
        workIdentity: identityA,
        ...options,
      });
      const reconcilerB = new TaskRuntimeReconciler({
        app: appB,
        db: scopedB,
        workIdentity: identityB,
        ...options,
      });

      await Promise.all([reconcilerA.checkOnce(), reconcilerB.checkOnce()]);

      await runWithTenantDatabaseScope(db, seeded.tenantId, async (scoped) => {
        const tasks = new TaskRepository(scoped);
        expect(await tasks.findById(seeded.active.task_id)).toMatchObject({
          status: TaskStatus.FAILED,
          sdk_failure: { termination: 'verified' },
        });
        expect(await tasks.findById(seeded.queued.task_id)).toMatchObject({
          status: TaskStatus.QUEUED,
          queue_position: 1,
        });
        expect(
          await new SessionRepository(scoped).findById(seeded.session.session_id)
        ).toMatchObject({
          status: SessionStatus.FAILED,
          ready_for_prompt: true,
        });
      });
      expect(observations.filter((entry) => entry === 'coordination_claimed')).toHaveLength(1);
      expect(observations.indexOf('task_settled')).toBeLessThan(
        observations.indexOf('session_projected')
      );
    });

    it("keeps daemon A's fresh Task and queue intact when daemon B starts", async () => {
      const seeded = await seed(db);
      const scopedA = createTenantScopedDatabaseProxy(db, {
        requireScope: true,
        label: 'daemon A fresh runtime',
      });
      const scopedB = createTenantScopedDatabaseProxy(db, {
        requireScope: true,
        label: 'daemon B fresh runtime',
      });
      const appA = createDaemonApp(
        scopedA,
        { instanceId: 'daemon-a-fresh', bootId: 'boot-a-fresh' },
        []
      );
      const identityB = { instanceId: 'daemon-b-fresh', bootId: 'boot-b-fresh' };
      const appB = createDaemonApp(scopedB, identityB, []);

      // A remains a separately constructed owner replica. B's shared startup
      // is deliberately non-destructive, then the executor reaches B and
      // refreshes the one natural liveness signal.
      expect(appA).not.toBe(appB);
      await expect(
        prepareTaskRuntimeStartup({
          taskRuntimePolicy: 'shared_postgres',
        } as StartupContext)
      ).resolves.toBeNull();
      await runWithTenantDatabaseScope(scopedB, seeded.tenantId, () =>
        new TaskRepository(scopedB).reportRuntimeTelemetry(seeded.active.task_id, seeded.authority)
      );
      const reconcilerB = new TaskRuntimeReconciler({
        app: appB,
        db: scopedB,
        workIdentity: identityB,
        tenantId: seeded.tenantId,
        startupOffsetMaxMs: 0,
        config: {
          enabled: true,
          interval_ms: 1_000,
          stale_after_ms: 60_000,
          callback: { command_template: null, timeout_ms: 3_000 },
        },
      });
      await reconcilerB.checkOnce();

      await runWithTenantDatabaseScope(db, seeded.tenantId, async (scoped) => {
        const tasks = new TaskRepository(scoped);
        expect(await tasks.findById(seeded.active.task_id)).toMatchObject({
          status: TaskStatus.RUNNING,
        });
        expect(await tasks.findById(seeded.queued.task_id)).toMatchObject({
          status: TaskStatus.QUEUED,
          queue_position: 1,
        });
        expect(
          await new SessionRepository(scoped).findById(seeded.session.session_id)
        ).toMatchObject({
          status: SessionStatus.RUNNING,
          ready_for_prompt: false,
        });
      });
    });
  }
);
