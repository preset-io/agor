/**
 * PostgreSQL integration for scheduler occurrence admission/recovery.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/scheduler-ha.postgres.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { SessionID, TaskID, UUID } from '../types/id';
import type { ScheduleID } from '../types/schedule';
import { SessionStatus } from '../types/session';
import { TaskStatus } from '../types/task';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase } from './database-wrapper';
import { initializeDatabase } from './migrate';
import {
  BranchRepository,
  RepoRepository,
  ScheduleRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from './repositories';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = Date.now() % 1_000_000;

interface TenantSeed {
  tenantId: string;
  userId: UUID;
  branchId: UUID;
  scheduleId: ScheduleID;
}

async function seedTenant(db: Database, tenantId: string, enabled = true): Promise<TenantSeed> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}-${generateId()}@example.com`,
      name: `Scheduler ${tenantId}`,
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `scheduler-ha-${tenantId}-${generateId()}`,
      name: `Scheduler HA ${tenantId}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/scheduler-ha.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `scheduler-ha-${tenantId}`,
      ref: 'main',
      branch_unique_id: branchUnique++,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    const schedule = await new ScheduleRepository(scoped).create({
      schedule_id: generateId() as ScheduleID,
      branch_id: branch.branch_id,
      created_by: user.user_id,
      name: `Scheduler HA ${tenantId}`,
      cron_expression: '* * * * *',
      timezone_mode: 'utc',
      prompt: 'recover me',
      agentic_tool_config: { agentic_tool: 'claude-code' },
      enabled,
      next_run_at: Date.now() - 1_000,
      retention: 0,
    });
    return {
      tenantId,
      userId: user.user_id as UUID,
      branchId: branch.branch_id as UUID,
      scheduleId: schedule.schedule_id,
    };
  });
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('scheduler HA (PostgreSQL)', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
  });

  afterAll(async () => {
    await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('serializes five occurrence admissions to one durable Session', async () => {
    const seed = await seedTenant(db, `scheduler-five-${generateId()}`);
    const scheduledRunAt = Date.now();

    const ids = await Promise.all(
      Array.from({ length: 5 }, () =>
        runWithTenantDatabaseScope(db, seed.tenantId, async (scoped) => {
          const schedules = new ScheduleRepository(scoped);
          const sessions = new SessionRepository(scoped);
          await schedules.lockForRunAdmission(seed.scheduleId);
          const existing = await sessions.findScheduleRun(seed.scheduleId, scheduledRunAt);
          if (existing) return existing.session_id;
          const created = await sessions.create({
            session_id: generateId() as SessionID,
            branch_id: seed.branchId,
            created_by: seed.userId,
            agentic_tool: 'claude-code',
            status: SessionStatus.IDLE,
            scheduled_from_branch: true,
            scheduled_run_at: scheduledRunAt,
            schedule_id: seed.scheduleId,
          });
          return created.session_id;
        })
      )
    );

    expect(new Set(ids).size).toBe(1);
    await runWithTenantDatabaseScope(db, seed.tenantId, async (scoped) => {
      expect(await new SessionRepository(scoped).findByScheduleId(seed.scheduleId)).toHaveLength(1);
    });
  });

  it('fences five dispatchers after idempotent task recovery', async () => {
    const seed = await seedTenant(db, `scheduler-task-${generateId()}`);
    const session = await runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
      new SessionRepository(scoped).create({
        session_id: generateId() as SessionID,
        branch_id: seed.branchId,
        created_by: seed.userId,
        agentic_tool: 'claude-code',
      })
    );
    const taskId = generateId() as TaskID;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
          new TaskRepository(scoped).createPending({
            task_id: taskId,
            session_id: session.session_id,
            created_by: seed.userId,
            full_prompt: 'recover me',
            status: TaskStatus.CREATED,
          })
        )
      )
    );
    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
          new TaskRepository(scoped).claimDispatchAndProjectSession(taskId, TaskStatus.CREATED, {
            status: TaskStatus.DISPATCHING,
          })
        )
      )
    );

    expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.outcome === 'already_claimed')).toHaveLength(4);
  });

  it('mutually fences prompt admission and permanent initialization diagnosis', async () => {
    const seed = await seedTenant(db, `scheduler-init-race-${generateId()}`);
    const session = await runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
      new SessionRepository(scoped).create({
        session_id: generateId() as SessionID,
        branch_id: seed.branchId,
        created_by: seed.userId,
        agentic_tool: 'claude-code',
        scheduled_from_branch: true,
        scheduled_run_at: Date.now(),
        schedule_id: seed.scheduleId,
      })
    );
    const taskId = generateId() as TaskID;

    await Promise.allSettled([
      runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
        new TaskRepository(scoped).createPending({
          task_id: taskId,
          session_id: session.session_id,
          created_by: seed.userId,
          full_prompt: 'stable scheduler admission',
          status: TaskStatus.QUEUED,
        })
      ),
      runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
        new SessionRepository(scoped).markScheduledInitializationPermanentFailure({
          sessionId: session.session_id,
          code: 'mcp_server_not_usable',
          stage: 'mcp_attachment',
        })
      ),
    ]);

    await runWithTenantDatabaseScope(db, seed.tenantId, async (scoped) => {
      const storedSession = await new SessionRepository(scoped).findById(session.session_id);
      const storedTask = await new TaskRepository(scoped).findById(taskId);
      if (storedTask) {
        expect(storedSession?.status).not.toBe(SessionStatus.FAILED);
        expect(storedSession?.scheduler_init_failure_code).toBeUndefined();
      } else {
        expect(storedSession).toMatchObject({
          status: SessionStatus.FAILED,
          scheduler_init_failure_code: 'mcp_server_not_usable',
        });
        expect(
          await new SessionRepository(scoped).markScheduledInitializationComplete(
            session.session_id
          )
        ).toBe(false);
      }
    });
  });

  it('serializes database-timed retry attempts inside the tenant boundary', async () => {
    const seed = await seedTenant(db, `scheduler-init-retry-${generateId()}`);
    const session = await runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
      new SessionRepository(scoped).create({
        session_id: generateId() as SessionID,
        branch_id: seed.branchId,
        created_by: seed.userId,
        agentic_tool: 'claude-code',
        scheduled_from_branch: true,
        scheduled_run_at: Date.now(),
        schedule_id: seed.scheduleId,
      })
    );
    const transitions = await Promise.all(
      Array.from({ length: 2 }, () =>
        runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
          new SessionRepository(scoped).markScheduledInitializationRetry({
            sessionId: session.session_id,
            code: 'initialization_transient',
            stage: 'prompt_admission',
          })
        )
      )
    );
    expect(transitions.map((transition) => transition.attempt).sort()).toEqual([1, 2]);
    await runWithTenantDatabaseScope(db, seed.tenantId, async (scoped) => {
      expect(await new SessionRepository(scoped).findById(session.session_id)).toMatchObject({
        scheduler_init_attempt_count: 2,
        scheduler_init_failure_code: 'initialization_transient',
      });
    });
  });

  it('keeps tenant reloads isolated while narrow system discovery returns routing refs', async () => {
    const a = await seedTenant(db, `scheduler-tenant-a-${generateId()}`);
    const b = await seedTenant(db, `scheduler-tenant-b-${generateId()}`);
    await seedTenant(db, `scheduler-disabled-${generateId()}`, false);

    const visibleToA = await runWithTenantDatabaseScope(db, a.tenantId, (scoped) =>
      new ScheduleRepository(scoped).findDueRefs(Date.now() + 60_000, 100)
    );
    expect(visibleToA.map((ref) => ref.schedule_id)).toEqual([a.scheduleId]);
    await runWithTenantDatabaseScope(db, a.tenantId, async (scoped) => {
      expect(await new ScheduleRepository(scoped).findById(b.scheduleId)).toBeNull();
    });

    const pendingA = await runWithTenantDatabaseScope(db, a.tenantId, (scoped) =>
      new SessionRepository(scoped).create({
        session_id: generateId() as SessionID,
        branch_id: a.branchId,
        created_by: a.userId,
        agentic_tool: 'claude-code',
        scheduled_from_branch: true,
        scheduled_run_at: Date.now(),
        schedule_id: a.scheduleId,
      })
    );
    const pendingB = await runWithTenantDatabaseScope(db, b.tenantId, (scoped) =>
      new SessionRepository(scoped).create({
        session_id: generateId() as SessionID,
        branch_id: b.branchId,
        created_by: b.userId,
        agentic_tool: 'claude-code',
        scheduled_from_branch: true,
        scheduled_run_at: Date.now(),
        schedule_id: b.scheduleId,
      })
    );
    const tenantARecoveries = await runWithTenantDatabaseScope(db, a.tenantId, (scoped) =>
      new SessionRepository(scoped).findIncompleteScheduledRefs(100)
    );
    expect(tenantARecoveries.map((ref) => ref.session_id)).toContain(pendingA.session_id);
    expect(tenantARecoveries.map((ref) => ref.session_id)).not.toContain(pendingB.session_id);

    const discovered = await runWithSystemDatabaseScope(
      db,
      'scheduler integration discovery',
      (systemDb) => new ScheduleRepository(systemDb).findDueRefs(Date.now() + 60_000, 100),
      { capability: 'scheduler_discovery' }
    );
    const byId = new Map(discovered.map((ref) => [ref.schedule_id, ref.tenant_id]));
    expect(byId.get(a.scheduleId)).toBe(a.tenantId);
    expect(byId.get(b.scheduleId)).toBe(b.tenantId);

    await runWithTenantDatabaseScope(db, a.tenantId, async (scoped) => {
      await new ScheduleRepository(scoped).delete(a.scheduleId);
      expect((await new SessionRepository(scoped).findById(pendingA.session_id))?.schedule_id).toBe(
        undefined
      );
    });

    const recoveries = await runWithSystemDatabaseScope(
      db,
      'scheduler integration recovery discovery',
      (systemDb) => new SessionRepository(systemDb).findIncompleteScheduledRefs(100),
      { capability: 'scheduler_discovery' }
    );
    const recoveryTenants = new Map(recoveries.map((ref) => [ref.session_id, ref.tenant_id]));
    expect(recoveryTenants.get(pendingA.session_id)).toBe(a.tenantId);
    expect(recoveryTenants.get(pendingB.session_id)).toBe(b.tenantId);
  });
});
