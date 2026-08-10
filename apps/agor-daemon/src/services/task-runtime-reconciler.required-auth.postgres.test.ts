/**
 * Real PostgreSQL/FORCE-RLS proof for tenant-scoped runtime reconciliation.
 *
 * AGOR_TEST_POSTGRES_URL must name a migrated non-owner, non-BYPASSRLS role.
 * AGOR_TEST_POSTGRES_OWNER_URL must name the non-elevated table owner and is
 * used only for deterministic cleanup.
 */

import { scheduler } from 'node:timers/promises';
import type { AgorConfig } from '@agor/core/config';
import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  deleteTenantData,
  executeRaw,
  generateId,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  SessionRepository,
  sql,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import {
  AuthenticationService,
  authenticate,
  feathers,
  feathersExpress,
  rest,
  socketio,
} from '@agor/core/feathers';
import type { AuthenticatedParams, TenantID, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const containExecutorProcess = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: 'verified_absent' as const })
);
vi.mock('../executor-tracking.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../executor-tracking.js')>()),
  containExecutorProcess,
}));

import { scopeExecutorRuntimeAuth } from '../auth/executor-runtime-scope.js';
import { createRequireAuthHook } from '../auth/require-auth.js';
import type { Application, TasksServiceImpl } from '../declarations.js';
import { restoreExecutorProcess, untrackExecutorProcess } from '../executor-tracking.js';
import { configureChannels } from '../setup/socketio.js';
import { TaskRuntimeReconciler } from './task-runtime-reconciler.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const postgresOwnerUrl = process.env.AGOR_TEST_POSTGRES_OWNER_URL;
let branchSequence = Date.now() % 1_000_000;

interface SupervisedTenant {
  tenantId: TenantID;
  dispatchTaskId: UUID;
  dispatchSessionId: UUID;
  heartbeatTaskId: UUID;
  heartbeatSessionId: UUID;
  statusFenceTaskId: UUID;
  heartbeatFenceTaskId: UUID;
}

interface LockedFence {
  blockerPid: number;
  taskId: UUID;
  commitUpdate(): Promise<void>;
  release(): Promise<void>;
}

function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
}

async function seedSupervisedTenant(db: Database, tenantId: TenantID): Promise<SupervisedTenant> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const userId = generateId();
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `heartbeat-supervisor-${tenantId}`,
      name: `Heartbeat supervisor ${tenantId}`,
      repo_type: 'local',
      local_path: `/tmp/heartbeat-supervisor-${tenantId}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `heartbeat-supervisor-${tenantId}`,
      ref: 'main',
      branch_unique_id: branchSequence++,
      path: `/tmp/heartbeat-supervisor-${tenantId}/branch`,
      created_by: userId,
    });
    const taskRepo = new TaskRepository(scoped);
    const sessionRepo = new SessionRepository(scoped);
    const seed = async (kind: 'dispatch' | 'heartbeat') => {
      const taskId = generateId();
      const session = await sessionRepo.create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'claude-code',
        created_by: userId,
        status: SessionStatus.RUNNING,
        ready_for_prompt: false,
        tasks: [taskId],
      });
      await taskRepo.create({
        task_id: taskId,
        session_id: session.session_id,
        created_by: userId,
        full_prompt: `${kind} supervision`,
        status: kind === 'dispatch' ? TaskStatus.DISPATCHING : TaskStatus.RUNNING,
        created_at: '2026-01-01T00:00:00.000Z',
        started_at: '2026-01-01T00:00:00.000Z',
        executor_mode: 'local',
        ...(kind === 'heartbeat'
          ? {
              executor_connected_at: '2026-01-01T00:00:00.000Z',
              last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
            }
          : {}),
        message_range: {
          start_index: 0,
          end_index: 0,
          start_timestamp: '2026-01-01T00:00:00.000Z',
        },
        git_state: { ref_at_start: 'main', sha_at_start: 'heartbeat-supervisor' },
        tool_use_count: 0,
      });
      return { taskId, sessionId: session.session_id };
    };
    const dispatch = await seed('dispatch');
    const heartbeat = await seed('heartbeat');
    const statusFence = await seed('dispatch');
    const heartbeatFence = await seed('heartbeat');
    return {
      tenantId,
      dispatchTaskId: dispatch.taskId,
      dispatchSessionId: dispatch.sessionId,
      heartbeatTaskId: heartbeat.taskId,
      heartbeatSessionId: heartbeat.sessionId,
      statusFenceTaskId: statusFence.taskId,
      heartbeatFenceTaskId: heartbeatFence.taskId,
    };
  });
}

describe.skipIf(!postgresUrl || !postgresOwnerUrl)(
  'TaskRuntimeReconciler required-auth PostgreSQL FORCE RLS',
  () => {
    let app: Application | undefined;
    let db: Database | undefined;
    let ownerDb: Database | undefined;
    let scopedDb: TenantScopeAwareDatabase | undefined;
    const tenantIds = new Set<TenantID>();
    const lockedFences = new Set<LockedFence>();

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      ownerDb = createDatabase({ dialect: 'postgresql', url: postgresOwnerUrl! });
      scopedDb = createTenantScopedDatabaseProxy(db, {
        requireScope: true,
        label: 'heartbeat supervisor PostgreSQL test database',
      });
      const result = await executeRaw(
        db,
        sql`SELECT current_user AS current_user,
                 pg_get_userbyid(c.relowner) AS table_owner,
                 r.rolsuper AS role_is_superuser,
                 r.rolbypassrls AS role_bypasses_rls,
                 c.relrowsecurity AS rls_enabled,
                 c.relforcerowsecurity AS rls_forced
          FROM pg_class c
          JOIN pg_roles r ON r.rolname = current_user
          WHERE c.oid = 'tasks'::regclass`
      );
      const role = resultRows(result)[0] as
        | {
            current_user?: string;
            table_owner?: string;
            role_is_superuser?: boolean;
            role_bypasses_rls?: boolean;
            rls_enabled?: boolean;
            rls_forced?: boolean;
          }
        | undefined;
      if (
        !role ||
        role.current_user === role.table_owner ||
        role.role_is_superuser ||
        role.role_bypasses_rls ||
        !role.rls_enabled ||
        !role.rls_forced
      ) {
        throw new Error('AGOR_TEST_POSTGRES_URL must use the migrated FORCE-RLS non-owner role');
      }
      const ownerResult = await executeRaw(
        ownerDb,
        sql`SELECT current_user AS current_user,
                 pg_get_userbyid(c.relowner) AS table_owner,
                 r.rolsuper AS role_is_superuser,
                 r.rolbypassrls AS role_bypasses_rls,
                 c.relrowsecurity AS rls_enabled,
                 c.relforcerowsecurity AS rls_forced
          FROM pg_class c
          JOIN pg_roles r ON r.rolname = current_user
          WHERE c.oid = 'tasks'::regclass`
      );
      const ownerRole = resultRows(ownerResult)[0] as typeof role;
      if (
        !ownerRole ||
        ownerRole.current_user !== ownerRole.table_owner ||
        ownerRole.role_is_superuser ||
        ownerRole.role_bypasses_rls ||
        !ownerRole.rls_enabled ||
        !ownerRole.rls_forced
      ) {
        throw new Error(
          'AGOR_TEST_POSTGRES_OWNER_URL must use the non-elevated FORCE-RLS table owner'
        );
      }

      const config = {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth' },
        execution: {
          branch_rbac: false,
          allow_superadmin: false,
          unix_user_mode: 'simple',
          allow_web_terminal: false,
          bootstrap_superadmin_users: [],
        },
      } satisfies AgorConfig;
      const jwtSecret = 'heartbeat-supervisor-postgres-test-secret';
      const multiTenancy = resolveMultiTenancyConfig(config);
      const requireAuth = createRequireAuthHook(
        scopeExecutorRuntimeAuth(authenticate({ strategies: ['api-key', 'jwt'] })),
        multiTenancy
      );

      app = feathersExpress(feathers());
      app.configure(rest());
      app.configure(socketio());
      configureChannels(app, { multiTenancy });
      app.set('database', scopedDb);
      app.set('config', config);
      app.set('authentication', {
        secret: jwtSecret,
        entity: 'user',
        entityId: 'user_id',
        service: 'users',
        authStrategies: ['jwt', 'api-key'],
      });
      app.use('/authentication', new AuthenticationService(app));
      const [{ registerServices }, { registerHooks }] = await Promise.all([
        import('../register-services.js'),
        import('../register-hooks.js'),
      ]);
      const services = await registerServices({
        db: scopedDb,
        app,
        config,
        jwtSecret,
        daemonUrl: 'http://localhost:3030',
        bundledUiAvailable: false,
        DAEMON_PORT: 3030,
        UI_PORT: 5173,
        branchRbacEnabled: false,
        allowSuperadmin: false,
        requireAuth,
        deployment: { mode: 'standalone' },
      });
      registerHooks({
        db: scopedDb,
        app,
        config,
        jwtSecret,
        branchRbacEnabled: false,
        requireAuth,
        superadminOpts: { allowSuperadmin: false },
        sessionsService: services.sessionsService,
        messagesService: services.messagesService,
        boardsService: services.boardsService,
        branchRepository: services.branchRepository,
        usersRepository: services.usersRepository,
        sessionsRepository: services.sessionsRepository,
        deployment: { mode: 'standalone' },
      });
    });

    afterAll(async () => {
      try {
        await Promise.all([...lockedFences].map((fence) => fence.release()));
      } finally {
        try {
          if (app) await app.teardown();
        } finally {
          try {
            if (ownerDb) {
              for (const tenantId of tenantIds) await deleteTenantData(ownerDb, tenantId);
            }
          } finally {
            await Promise.all([
              ownerDb
                ? (ownerDb as Database & { $client: { end: () => Promise<void> } }).$client.end()
                : Promise.resolve(),
              db
                ? (db as Database & { $client: { end: () => Promise<void> } }).$client.end()
                : Promise.resolve(),
            ]);
          }
        }
      }
    });

    beforeEach(() => {
      containExecutorProcess.mockClear();
    });

    async function lockFence(
      tenantId: TenantID,
      taskId: UUID,
      update: (tasks: TaskRepository) => Promise<unknown>
    ): Promise<LockedFence> {
      let signalRelease!: (commitUpdate: boolean) => void;
      const releaseRequested = new Promise<boolean>((resolve) => {
        signalRelease = resolve;
      });
      let signalLocked!: (pid: number) => void;
      const locked = new Promise<number>((resolve) => {
        signalLocked = resolve;
      });
      const transaction = runWithTenantDatabaseScope(db!, tenantId, async (scoped) => {
        const pidResult = await executeRaw(scoped, sql`SELECT pg_backend_pid() AS pid`);
        const blockerPid = Number(resultRows(pidResult)[0]?.pid);
        await executeRaw(
          scoped,
          sql`SELECT task_id FROM tasks WHERE task_id = ${taskId} FOR UPDATE`
        );
        signalLocked(blockerPid);
        if (await releaseRequested) await update(new TaskRepository(scoped));
      });
      const blockerPid = await Promise.race([
        locked,
        transaction.then(
          () => Promise.reject(new Error(`Task ${taskId} lock transaction ended before locking`)),
          (error) => Promise.reject(error)
        ),
      ]);
      let released = false;
      const finish = async (commitUpdate: boolean) => {
        if (!released) {
          released = true;
          signalRelease(commitUpdate);
        }
        await transaction;
        lockedFences.delete(fence);
      };
      const fence: LockedFence = {
        blockerPid,
        taskId,
        commitUpdate: () => finish(true),
        release: () => finish(false),
      };
      lockedFences.add(fence);
      return fence;
    }

    async function waitForBlockedFence(candidates: LockedFence[]): Promise<LockedFence> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = await executeRaw(
          db!,
          sql`SELECT pg_blocking_pids(pid) AS blocker_pids
            FROM pg_stat_activity
            WHERE cardinality(pg_blocking_pids(pid)) > 0`
        );
        const blockingPids = new Set(
          resultRows(result).flatMap((row) =>
            Array.isArray(row.blocker_pids) ? row.blocker_pids.map(Number) : []
          )
        );
        const blocked = candidates.find((candidate) => blockingPids.has(candidate.blockerPid));
        if (blocked) return blocked;
        await scheduler.yield();
      }
      throw new Error(
        `No supervisor termination claim waited on task row locks: ${candidates
          .map((candidate) => candidate.taskId)
          .join(', ')}`
      );
    }

    async function expectTerminalConsequences(tenants: SupervisedTenant[]): Promise<void> {
      for (let attempt = 0; attempt < 500; attempt++) {
        let complete = true;
        for (const tenant of tenants) {
          await runWithTenantDatabaseScope(db!, tenant.tenantId, async (scoped) => {
            const tasks = new TaskRepository(scoped);
            for (const taskId of [tenant.dispatchTaskId, tenant.heartbeatTaskId]) {
              if (!(await tasks.findById(taskId))?.metadata?.terminal_consequences_completed_at) {
                complete = false;
              }
            }
          });
        }
        if (complete) return;
      }
      throw new Error('Terminal consequences did not complete before cleanup');
    }

    it('contains each tenant locally, denies cross-tenant work, fails closed, and fences newer facts', async () => {
      const tenantAId = `heartbeat-supervisor-a-${generateId()}` as TenantID;
      tenantIds.add(tenantAId);
      const tenantA = await seedSupervisedTenant(db!, tenantAId);
      const tenantBId = `heartbeat-supervisor-b-${generateId()}` as TenantID;
      tenantIds.add(tenantBId);
      const tenantB = await seedSupervisedTenant(db!, tenantBId);
      const tenants = [tenantA, tenantB];
      const tasksService = app!.service('tasks') as unknown as TasksServiceImpl;
      for (const tenant of tenants) {
        restoreExecutorProcess(
          tenant.dispatchSessionId,
          tenant.dispatchTaskId,
          { mode: 'local', pid: 2_147_483_647 },
          app!
        );
        restoreExecutorProcess(
          tenant.heartbeatSessionId,
          tenant.heartbeatTaskId,
          { mode: 'local', pid: 2_147_483_647 },
          app!
        );
      }

      await expect(tasksService.get(tenantA.dispatchTaskId)).rejects.toThrow(
        /Missing tenant|Tenant identity is required/
      );
      await expect(
        runWithTenantContext(tenantA.tenantId, () => tasksService.get(tenantB.dispatchTaskId))
      ).rejects.toThrow();
      await expect(
        runWithTenantContext(tenantA.tenantId, () =>
          runWithTenantDatabaseScope(scopedDb!, tenantA.tenantId, () =>
            tasksService.claimTermination({
              taskId: tenantB.dispatchTaskId,
              cause: 'user_stop',
              errorMessage: 'must not cross tenants',
            })
          )
        )
      ).rejects.toThrow(/Task with ID .* not found/);
      const conflictingParams: AuthenticatedParams = {
        tenant: { tenant_id: tenantB.tenantId, source: 'explicit' },
      };
      await expect(
        runWithTenantContext(tenantA.tenantId, () =>
          tasksService.get(tenantA.dispatchTaskId, conflictingParams)
        )
      ).rejects.toThrow(/Cannot enter tenant|Conflicting tenant/);

      const races = await Promise.all(
        tenants.flatMap((tenant) => [
          lockFence(tenant.tenantId, tenant.statusFenceTaskId, (tasks) =>
            tasks.connectExecutor(tenant.statusFenceTaskId)
          ),
          lockFence(tenant.tenantId, tenant.heartbeatFenceTaskId, (tasks) =>
            tasks.reportRuntimeTelemetry(
              tenant.heartbeatFenceTaskId,
              { sequence: 2, kind: 'progress', detail: 'newer' },
              { sequence: 2, kind: 'progress', detail: 'newer' },
              new Date('2026-01-01T00:00:04.000Z')
            )
          ),
        ])
      );

      try {
        const reconciler = new TaskRuntimeReconciler({
          app: app!,
          db: scopedDb!,
          config: {
            enabled: true,
            interval_ms: 1_000,
            stale_after_ms: 3_000,
            callback: { command_template: null, timeout_ms: 3_000 },
          },
          workIdentity: { instanceId: 'postgres-qa', bootId: 'postgres-qa-boot' },
          dispatchConnectTimeoutMs: 3_000,
          now: () => new Date('2026-01-01T00:00:05.000Z'),
          startupOffsetMaxMs: 0,
        });
        const reconciliation = reconciler.checkOnce();
        const pendingRaces = [...races];
        while (pendingRaces.length > 0) {
          const blocked = await waitForBlockedFence(pendingRaces);
          pendingRaces.splice(pendingRaces.indexOf(blocked), 1);
          await blocked.commitUpdate();
        }
        await reconciliation;

        for (const tenant of tenants) {
          await runWithTenantDatabaseScope(db!, tenant.tenantId, async (scoped) => {
            const tasks = new TaskRepository(scoped);
            const sessions = new SessionRepository(scoped);
            await expect(tasks.findById(tenant.dispatchTaskId)).resolves.toMatchObject({
              status: TaskStatus.FAILED,
              termination_request: { cause: 'startup_timeout' },
              sdk_failure: { reason: 'startup_timeout' },
            });
            await expect(tasks.findById(tenant.heartbeatTaskId)).resolves.toMatchObject({
              status: TaskStatus.FAILED,
              termination_request: { cause: 'heartbeat_lost' },
              sdk_failure: { reason: 'heartbeat_lost' },
            });
            await expect(sessions.findById(tenant.dispatchSessionId)).resolves.toMatchObject({
              status: SessionStatus.FAILED,
              runtime_projection: { terminal_task_id: tenant.dispatchTaskId },
            });
            await expect(sessions.findById(tenant.heartbeatSessionId)).resolves.toMatchObject({
              status: SessionStatus.FAILED,
              runtime_projection: { terminal_task_id: tenant.heartbeatTaskId },
            });
            await expect(tasks.findById(tenant.statusFenceTaskId)).resolves.toMatchObject({
              status: TaskStatus.RUNNING,
              executor_connected_at: expect.any(String),
            });
            await expect(tasks.findById(tenant.heartbeatFenceTaskId)).resolves.toMatchObject({
              status: TaskStatus.RUNNING,
              last_executor_heartbeat_at: '2026-01-01T00:00:04.000Z',
            });
          });
        }
        await expectTerminalConsequences(tenants);
        expect(containExecutorProcess).toHaveBeenCalledTimes(4);
      } finally {
        await Promise.all(races.map((race) => race.release()));
        for (const tenant of tenants) {
          untrackExecutorProcess(tenant.dispatchSessionId, tenant.dispatchTaskId, app!);
          untrackExecutorProcess(tenant.heartbeatSessionId, tenant.heartbeatTaskId, app!);
        }
      }
    });
  }
);
