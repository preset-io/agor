/**
 * PostgreSQL integration for Task runtime HA discovery and fencing.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/task-runtime-ha.postgres.test.ts
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { BranchID, SessionID, TaskID, UUID } from '../types/id';
import { SessionStatus } from '../types/session';
import { TaskStatus } from '../types/task';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase } from './database-wrapper';
import { initializeDatabase } from './migrate';
import {
  BranchRepository,
  ExecutorSessionTokenAuthorityRepository,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from './repositories';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';
import { setTestBranchUserRole } from './test-helpers';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() % 1_000_000) + 2_000_000;

interface TenantSeed {
  tenantId: string;
  userId: UUID;
  branchId: BranchID;
  sessionId: SessionID;
}

async function seedTenant(db: Database, label: string): Promise<TenantSeed> {
  const tenantId = `task-runtime-${label}-${generateId()}`;
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const owner = await new UsersRepository(scoped).create({
      email: `${tenantId}-owner@example.com`,
      name: `Runtime ${label} owner`,
    });
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}@example.com`,
      name: `Runtime ${label}`,
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: tenantId,
      name: `Runtime ${label}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/task-runtime.git',
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
      created_by: owner.user_id,
    });
    await setTestBranchUserRole(
      scoped,
      branch.branch_id,
      user.user_id,
      'collaborator',
      'write',
      owner.user_id
    );
    const session = await new SessionRepository(scoped).create({
      session_id: generateId() as SessionID,
      branch_id: branch.branch_id,
      created_by: user.user_id,
      agentic_tool: 'codex',
    });
    return {
      tenantId,
      userId: user.user_id as UUID,
      branchId: branch.branch_id,
      sessionId: session.session_id,
    };
  });
}

function runtimeAuthority(seed: TenantSeed, taskId: string) {
  return {
    token_fingerprint: createHash('sha256').update(taskId).digest('hex'),
    principal_user_id: seed.userId,
    session_id: seed.sessionId,
    branch_id: seed.branchId,
    branchRbacEnabled: true,
  };
}

async function authorizeRuntime(
  scoped: Database,
  seed: TenantSeed,
  task: { task_id: string },
  connectedAt: Date
) {
  const tasks = new TaskRepository(scoped);
  const authority = runtimeAuthority(seed, task.task_id);
  await tasks.bindExecutorLaunchAuthority(task.task_id, {
    branchRbacEnabled: true,
  });
  await tasks.connectExecutor(task.task_id, connectedAt);
  const now = new Date();
  await new ExecutorSessionTokenAuthorityRepository(scoped).issue({
    tenantId: seed.tenantId,
    tokenFingerprint: authority.token_fingerprint,
    tokenType: 'executor-session',
    purpose: 'executor-task',
    sessionId: seed.sessionId,
    taskId: task.task_id,
    branchId: seed.branchId,
    userId: seed.userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    maxUses: -1,
  });
  return authority;
}

function taskInput(seed: TenantSeed, status: TaskStatus, overrides: Record<string, unknown> = {}) {
  return {
    task_id: generateId() as TaskID,
    session_id: seed.sessionId,
    created_by: seed.userId,
    full_prompt: 'HA runtime probe',
    status,
    message_range: {
      start_index: 0,
      end_index: 0,
      start_timestamp: new Date().toISOString(),
    },
    git_state: { ref_at_start: 'main', sha_at_start: 'ha-probe' },
    tool_use_count: 0,
    ...overrides,
  };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('Task runtime HA (PostgreSQL)', () => {
  let db: Database;
  let peerDb: Database;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    peerDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
  });

  afterAll(async () => {
    await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    await (peerDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('lets a second daemon accept heartbeats without changing the Task or its queue', async () => {
    const seed = await seedTenant(db, 'heartbeat-handoff');
    const { active, queued, authority } = await runWithTenantDatabaseScope(
      db,
      seed.tenantId,
      async (scoped) => {
        const tasks = new TaskRepository(scoped);
        const active = await tasks.create(
          taskInput(seed, TaskStatus.DISPATCHING, {
            executor_mode: 'templated',
          })
        );
        const authority = await authorizeRuntime(
          scoped,
          seed,
          active,
          new Date('2026-08-06T10:00:01.000Z')
        );
        const queued = await tasks.create(
          taskInput(seed, TaskStatus.QUEUED, { queue_position: 1 })
        );
        return { active, queued, authority };
      }
    );

    let refreshedAt: string | undefined;
    await runWithTenantDatabaseScope(peerDb, seed.tenantId, async (scoped) => {
      // A separately constructed repository represents daemon B receiving the
      // detached/remote executor's next authenticated heartbeat.
      const daemonB = new TaskRepository(scoped);
      await expect(
        daemonB.reportRuntimeTelemetry(active.task_id, authority)
      ).resolves.toMatchObject({ outcome: 'continued' });
      refreshedAt = (await daemonB.findById(active.task_id))?.last_executor_heartbeat_at;
      expect(await daemonB.findById(active.task_id)).toMatchObject({ status: TaskStatus.RUNNING });
      expect(await daemonB.findById(queued.task_id)).toMatchObject({
        status: TaskStatus.QUEUED,
        queue_position: 1,
      });
    });
    await runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
      new ExecutorSessionTokenAuthorityRepository(scoped).revoke(
        authority.token_fingerprint,
        seed.tenantId
      )
    );
    await runWithTenantDatabaseScope(peerDb, seed.tenantId, async (scoped) => {
      // Daemon A committed revocation while Redis/realtime fanout was missed.
      // Daemon B's next normal heartbeat still denies from PostgreSQL.
      const daemonB = new TaskRepository(scoped);
      await expect(
        daemonB.reportRuntimeTelemetry(active.task_id, authority)
      ).resolves.toMatchObject({ outcome: 'authorization_revoked', reason: 'token_revoked' });
      expect((await daemonB.findById(active.task_id))?.last_executor_heartbeat_at).toBe(
        refreshedAt
      );
    });
  });

  it('observes a write-to-read policy demotion on a peer heartbeat', async () => {
    const seed = await seedTenant(db, 'policy-demotion');
    const { task, authority } = await runWithTenantDatabaseScope(
      db,
      seed.tenantId,
      async (scoped) => {
        const tasks = new TaskRepository(scoped);
        const task = await tasks.create(taskInput(seed, TaskStatus.DISPATCHING));
        const authority = await authorizeRuntime(scoped, seed, task, new Date());
        return { task, authority };
      }
    );
    await runWithTenantDatabaseScope(peerDb, seed.tenantId, (scoped) =>
      new TaskRepository(scoped).reportRuntimeTelemetry(task.task_id, authority)
    );
    await runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
      setTestBranchUserRole(scoped, seed.branchId, seed.userId, 'collaborator', 'read')
    );
    await runWithTenantDatabaseScope(peerDb, seed.tenantId, async (scoped) => {
      await expect(
        new TaskRepository(scoped).reportRuntimeTelemetry(task.task_id, authority)
      ).resolves.toMatchObject({
        outcome: 'authorization_revoked',
        reason: 'filesystem_access_revoked',
      });
    });
  });

  it('keeps deferred heartbeat branch projections inside the originating tenant', async () => {
    const owner = await seedTenant(db, 'heartbeat-callback-owner');
    const other = await seedTenant(db, 'heartbeat-callback-other');

    await runWithTenantDatabaseScope(db, owner.tenantId, async (scoped) => {
      // A fresh repository models the post-commit callback reopening a short
      // database unit on whichever daemon receives the heartbeat.
      await expect(new SessionRepository(scoped).findById(owner.sessionId)).resolves.toMatchObject({
        session_id: owner.sessionId,
        branch_id: owner.branchId,
      });
      await expect(
        new SessionRepository(scoped).findBranchIdBySessionId(owner.sessionId)
      ).resolves.toBe(owner.branchId);
    });

    await runWithTenantDatabaseScope(db, other.tenantId, async (scoped) => {
      // The same globally unique Session id must not be usable to enrich a
      // request or callback running under a different tenant's RLS scope.
      await expect(new SessionRepository(scoped).findById(owner.sessionId)).resolves.toBeNull();
      await expect(
        new SessionRepository(scoped).findBranchIdBySessionId(owner.sessionId)
      ).resolves.toBeNull();
    });
  });

  it('fences dispatch and stale-heartbeat races against newer executor facts', async () => {
    const seed = await seedTenant(db, 'fact-races');
    const { dispatch, running, runningAuthority } = await runWithTenantDatabaseScope(
      db,
      seed.tenantId,
      async (scoped) => {
        const tasks = new TaskRepository(scoped);
        const dispatch = await tasks.create(
          taskInput(seed, TaskStatus.DISPATCHING, {
            executor_mode: 'local',
            started_at: '2000-01-01T00:00:00.000Z',
          })
        );
        const running = await tasks.create(
          taskInput(seed, TaskStatus.DISPATCHING, {
            executor_mode: 'templated',
          })
        );
        const runningAuthority = await authorizeRuntime(
          scoped,
          seed,
          running,
          new Date('2000-01-01T00:00:01.000Z')
        );
        return { dispatch, running, runningAuthority };
      }
    );

    const discovered = await runWithSystemDatabaseScope(
      db,
      'task runtime race discovery',
      async (systemDb) => {
        const tasks = new TaskRepository(systemDb);
        return {
          dispatch: await tasks.findExpiredDispatchRefs(1, { limit: 100 }),
          heartbeat: await tasks.findStaleHeartbeatRefs(1, { limit: 100 }),
        };
      },
      { capability: 'task_runtime_discovery' }
    );
    const dispatchRef = discovered.dispatch.find((ref) => ref.task_id === dispatch.task_id)!;
    const heartbeatRef = discovered.heartbeat.find((ref) => ref.task_id === running.task_id)!;

    await runWithTenantDatabaseScope(db, seed.tenantId, async (scoped) => {
      const daemonB = new TaskRepository(scoped);
      await daemonB.connectExecutor(dispatchRef.task_id);
      await daemonB.reportRuntimeTelemetry(running.task_id, runningAuthority);

      const daemonA = new TaskRepository(scoped);
      await expect(
        daemonA.claimTermination({
          taskId: dispatchRef.task_id,
          cause: 'startup_timeout',
          errorMessage: 'dispatch expired',
          expectedStatus: TaskStatus.DISPATCHING,
          requireExecutorDisconnected: true,
        })
      ).resolves.toMatchObject({ outcome: 'condition_changed' });
      await expect(
        daemonA.claimTermination({
          taskId: heartbeatRef.task_id,
          cause: 'heartbeat_lost',
          errorMessage: 'heartbeat expired',
          expectedStatus: TaskStatus.RUNNING,
          expectedHeartbeatAt: heartbeatRef.executor_heartbeat_at,
        })
      ).resolves.toMatchObject({ outcome: 'condition_changed' });
    });
  });

  it('elects one daemon, then lets another reclaim a dead coordinator lease', async () => {
    const seed = await seedTenant(db, 'termination-recovery');
    const task = await runWithTenantDatabaseScope(db, seed.tenantId, async (scoped) => {
      const tasks = new TaskRepository(scoped);
      const sessions = new SessionRepository(scoped);
      const task = await tasks.create(taskInput(seed, TaskStatus.RUNNING));
      await sessions.update(seed.sessionId, {
        status: SessionStatus.STOPPING,
        ready_for_prompt: false,
      });
      await tasks.claimTermination({
        taskId: task.task_id,
        cause: 'heartbeat_lost',
        errorMessage: 'heartbeat expired',
        now: new Date('2026-08-06T12:00:00.000Z'),
      });
      return task;
    });

    const claims = await Promise.all(
      ['daemon-a', 'daemon-b'].map((instanceId) =>
        runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
          new TaskRepository(scoped).claimTerminationCoordination({
            taskId: task.task_id,
            claimToken: `${instanceId}-claim`,
            leaseDurationMs: 1_000,
            instanceId,
            bootId: `${instanceId}-boot`,
            now: new Date('2026-08-06T12:00:01.000Z'),
          })
        )
      )
    );
    expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1);
    const firstToken = claims.find((claim) => claim.outcome === 'claimed')!.task
      .termination_request!.coordination!.claim_token;

    await runWithTenantDatabaseScope(db, seed.tenantId, async (scoped) => {
      const replacement = await new TaskRepository(scoped).claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'replacement-claim',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-c',
        bootId: 'daemon-c-boot',
        now: new Date('2026-08-06T12:00:02.000Z'),
      });
      expect(replacement).toMatchObject({
        outcome: 'claimed',
        task: {
          status: TaskStatus.STOPPING,
          termination_request: {
            coordination: { claim_token: 'replacement-claim', instance_id: 'daemon-c' },
          },
        },
      });
      await expect(
        new TaskRepository(scoped).settleTermination({
          taskId: task.task_id,
          outcome: 'verified_absent',
          coordinationToken: firstToken,
          now: new Date('2026-08-06T12:00:03.000Z'),
        })
      ).resolves.toMatchObject({ outcome: 'condition_changed' });
      await expect(
        new TaskRepository(scoped).settleTermination({
          taskId: task.task_id,
          outcome: 'verified_absent',
          coordinationToken: 'replacement-claim',
          now: new Date('2026-08-06T12:00:03.000Z'),
        })
      ).resolves.toMatchObject({ outcome: 'transitioned', task: { status: TaskStatus.FAILED } });
      await expect(new SessionRepository(scoped).findById(seed.sessionId)).resolves.toMatchObject({
        status: SessionStatus.FAILED,
        ready_for_prompt: true,
      });
    });
  });

  it('reconciles late executor quiescence through RLS without exposing it cross-tenant', async () => {
    const owner = await seedTenant(db, 'late-quiescence-owner');
    const other = await seedTenant(db, 'late-quiescence-other');
    const { task, requestedAt } = await runWithTenantDatabaseScope(
      db,
      owner.tenantId,
      async (scoped) => {
        const tasks = new TaskRepository(scoped);
        const task = await tasks.create(
          taskInput(owner, TaskStatus.RUNNING, {
            executor_mode: 'templated',
            executor_connected_at: '2026-08-06T12:00:00.000Z',
          })
        );
        const request = await tasks.claimTermination({
          taskId: task.task_id,
          cause: 'user_stop',
          errorMessage: 'Stopped by user',
          now: new Date('2026-08-06T12:01:00.000Z'),
        });
        await tasks.claimTerminationCoordination({
          taskId: task.task_id,
          claimToken: 'initial-unverified',
          leaseDurationMs: 30_000,
          instanceId: 'daemon-a',
          bootId: 'boot-a',
          now: new Date('2026-08-06T12:01:00.010Z'),
        });
        await tasks.settleTermination({
          taskId: task.task_id,
          outcome: 'unverified',
          coordinationToken: 'initial-unverified',
          errorMessage: 'Executor acknowledgement did not arrive in time.',
          sdkFailure: {
            reason: 'termination_unverified',
            detected_at: '2026-08-06T12:01:01.500Z',
            tool: 'codex',
            termination: 'unverified',
          },
          now: new Date('2026-08-06T12:01:01.500Z'),
        });
        return {
          task,
          requestedAt: request.task.termination_request!.requested_at,
        };
      }
    );

    await runWithTenantDatabaseScope(db, other.tenantId, async (scoped) => {
      await expect(
        new TaskRepository(scoped).recordExecutorQuiescence({
          task_id: task.task_id,
          requested_at: requestedAt,
        })
      ).rejects.toThrow();
    });

    await runWithTenantDatabaseScope(db, owner.tenantId, async (scoped) => {
      const reported = await new TaskRepository(scoped).recordExecutorQuiescence(
        { task_id: task.task_id, requested_at: requestedAt },
        new Date('2026-08-06T12:01:02.000Z')
      );
      expect(reported).toMatchObject({ status: TaskStatus.STOPPING });
      expect(reported?.sdk_failure).toBeUndefined();
      expect(reported?.error_message).toBeUndefined();
    });

    const stranded = await runWithSystemDatabaseScope(
      db,
      'late quiescence discovery',
      (systemDb) =>
        new TaskRepository(systemDb).findStrandedTerminationRefs({
          now: new Date('2026-08-06T12:01:02.001Z'),
          limit: 1_000,
        }),
      { capability: 'task_runtime_discovery' }
    );
    expect(stranded).toContainEqual(
      expect.objectContaining({ task_id: task.task_id, tenant_id: owner.tenantId })
    );

    await runWithTenantDatabaseScope(db, owner.tenantId, async (scoped) => {
      const tasks = new TaskRepository(scoped);
      await expect(
        tasks.claimTerminationCoordination({
          taskId: task.task_id,
          claimToken: 'late-quiescence',
          leaseDurationMs: 30_000,
          instanceId: 'daemon-b',
          bootId: 'boot-b',
          now: new Date('2026-08-06T12:01:02.010Z'),
        })
      ).resolves.toMatchObject({ outcome: 'claimed' });
      await expect(
        tasks.settleTermination({
          taskId: task.task_id,
          outcome: 'verified_absent',
          coordinationToken: 'late-quiescence',
          now: new Date('2026-08-06T12:01:02.020Z'),
        })
      ).resolves.toMatchObject({
        outcome: 'transitioned',
        task: { status: TaskStatus.STOPPED },
      });
      await expect(new SessionRepository(scoped).findById(owner.sessionId)).resolves.toMatchObject({
        status: SessionStatus.IDLE,
        ready_for_prompt: true,
      });
    });
  });

  it('discovers routing refs globally but rejects cross-tenant reload and mutation', async () => {
    const a = await seedTenant(db, 'tenant-a');
    const b = await seedTenant(db, 'tenant-b');
    const taskA = await runWithTenantDatabaseScope(db, a.tenantId, (scoped) =>
      new TaskRepository(scoped).create(
        taskInput(a, TaskStatus.RUNNING, {
          executor_connected_at: '2000-01-01T00:00:00.000Z',
          last_executor_heartbeat_at: '2000-01-01T00:00:01.000Z',
        })
      )
    );
    const taskB = await runWithTenantDatabaseScope(db, b.tenantId, (scoped) =>
      new TaskRepository(scoped).create(
        taskInput(b, TaskStatus.RUNNING, {
          executor_connected_at: '2000-01-01T00:00:00.000Z',
          last_executor_heartbeat_at: '2000-01-01T00:00:01.000Z',
        })
      )
    );

    const refs = await runWithSystemDatabaseScope(
      db,
      'task runtime cross-tenant discovery',
      (systemDb) => new TaskRepository(systemDb).findStaleHeartbeatRefs(1, { limit: 1000 }),
      { capability: 'task_runtime_discovery' }
    );
    const routing = new Map(refs.map((ref) => [ref.task_id, ref.tenant_id]));
    expect(routing.get(taskA.task_id)).toBe(a.tenantId);
    expect(routing.get(taskB.task_id)).toBe(b.tenantId);

    await runWithTenantDatabaseScope(db, a.tenantId, async (scoped) => {
      expect(await new TaskRepository(scoped).findById(taskB.task_id)).toBeNull();
      await expect(
        new TaskRepository(scoped).claimTermination({
          taskId: taskB.task_id,
          cause: 'heartbeat_lost',
          errorMessage: 'cross-tenant attempt',
        })
      ).rejects.toThrow();
    });
  });
});
