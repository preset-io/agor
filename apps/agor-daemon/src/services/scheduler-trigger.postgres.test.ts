/**
 * PostgreSQL proof that a schedule trigger token is confined to its tenant in
 * hosted (`required_from_auth`) mode, where the scheduler has no static tenant
 * and must discover it from the token hash.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/daemon exec vitest run src/services/scheduler-trigger.postgres.test.ts
 */

import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  generateId,
  getCurrentTenantId,
  initializeDatabase,
  isPostgresDatabase,
  type RawDatabase,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  SessionRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Schedule, ScheduleID, Session } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateScheduleTriggerToken } from './schedule-trigger-token';
import { ScheduleBusyError, SchedulerService, ScheduleTriggerNotFoundError } from './scheduler';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

async function seedTriggeredSchedule(db: TenantScopeAwareDatabase, tenantId: string) {
  return runWithTenantDatabaseScope(db, tenantId, async () => {
    const user = await new UsersRepository(db).create({
      email: `${tenantId}@example.test`,
      name: `Owner ${tenantId}`,
    });
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: `trigger-${tenantId}`,
      name: 'Trigger',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/trigger.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `trigger-${tenantId}`,
      ref: 'main',
      branch_unique_id: Math.floor(Math.random() * 1_000_000),
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    const schedules = new ScheduleRepository(db);
    const schedule = await schedules.create({
      branch_id: branch.branch_id,
      created_by: user.user_id,
      name: 'Triggered',
      cron_expression: '0 0 1 1 *',
      timezone_mode: 'utc',
      prompt: 'noop',
      agentic_tool_config: { agentic_tool: 'claude-code' },
    });
    const { token, tokenHash } = generateScheduleTriggerToken();
    await schedules.setTriggerTokenHash(schedule.schedule_id, tokenHash);
    return { tenantId, ownerId: user.user_id, scheduleId: schedule.schedule_id, token };
  });
}

/** Minimal daemon app for real admissions: prompt dispatch is stubbed out. */
function daemonApp(handle: TenantScopeAwareDatabase) {
  const sessions = new SessionRepository(handle);
  const inTenant = <T>(work: () => Promise<T>) =>
    runWithTenantDatabaseScope(handle, getCurrentTenantId(), work);
  return {
    get: (name: string) =>
      name === 'distributedWorkIdentity' ? { instanceId: 'test', bootId: 'test' } : undefined,
    service: (path: string) => {
      if (path === 'sessions') {
        return {
          emit: () => {},
          patch: (id: string, data: Partial<Session>) => inTenant(() => sessions.update(id, data)),
          remove: (id: string) => inTenant(() => sessions.delete(id)),
        };
      }
      if (path === '/sessions/:id/prompt') {
        return {
          create: async (data: { prompt: string; idempotencyTaskId: string }, params: any) => ({
            task_id: data.idempotencyTaskId,
            session_id: params.route.id,
            status: TaskStatus.DISPATCHING,
            full_prompt: data.prompt,
          }),
        };
      }
      if (path === 'session-mcp-servers') return { emit: () => {} };
      throw new Error(`Unexpected service: ${path}`);
    },
  } as unknown as ConstructorParameters<typeof SchedulerService>[1];
}

type SchedulerInternals = {
  runOnDemand(opts: { scheduleId: ScheduleID; triggeredBy: string }): Promise<unknown>;
  spawnScheduledSession(
    schedule: Schedule,
    scheduledRunAt: number,
    now: number,
    options: { source: 'cron' | 'webhook'; triggeredBy?: string }
  ): Promise<{ created: boolean } | null>;
};

describe.skipIf(!postgresUrl || !usesPostgresSchema)('schedule trigger (PostgreSQL)', () => {
  let raw: RawDatabase;
  let rawB: RawDatabase;
  let db: TenantScopeAwareDatabase;
  let dbB: TenantScopeAwareDatabase;

  beforeAll(async () => {
    raw = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(raw);
    if (!isPostgresDatabase(raw)) throw new Error('PostgreSQL test requires PostgreSQL');
    db = createTenantScopedDatabaseProxy(raw, { requireScope: true, label: 'trigger daemon A' });
    // A second pool stands in for a second daemon.
    rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    dbB = createTenantScopedDatabaseProxy(rawB, { requireScope: true, label: 'trigger daemon B' });
  });

  afterAll(async () => {
    for (const handle of [raw, rawB]) {
      await (handle as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end();
    }
  });

  it("confines a token to its own tenant's schedule and runs it there as the owner", async () => {
    const a = await seedTriggeredSchedule(db, `trigger-a-${generateId()}`);
    const b = await seedTriggeredSchedule(db, `trigger-b-${generateId()}`);
    // No static tenant: hosted mode discovers the tenant from the token hash.
    const scheduler = new SchedulerService(db, daemonApp(db));
    const runs: Array<{
      tenantId: string | undefined;
      scheduleId: ScheduleID;
      triggeredBy: string;
    }> = [];
    vi.spyOn(scheduler as unknown as SchedulerInternals, 'runOnDemand').mockImplementation(
      async (opts) => {
        runs.push({
          tenantId: getCurrentTenantId(),
          scheduleId: opts.scheduleId,
          triggeredBy: opts.triggeredBy,
        });
        return { session: {} as Session, created: true };
      }
    );

    for (const [scheduleId, token] of [
      [b.scheduleId, a.token],
      [a.scheduleId, b.token],
    ] as const) {
      await expect(scheduler.triggerSchedule(scheduleId, token)).rejects.toBeInstanceOf(
        ScheduleTriggerNotFoundError
      );
    }
    expect(runs).toEqual([]);

    await expect(scheduler.triggerSchedule(a.scheduleId, a.token)).resolves.toEqual({
      status: 'started',
    });
    expect(runs).toEqual([
      { tenantId: a.tenantId, scheduleId: a.scheduleId, triggeredBy: a.ownerId },
    ]);
    await runWithTenantDatabaseScope(db, b.tenantId, async () => {
      expect((await new ScheduleRepository(db).findById(b.scheduleId))?.last_triggered_at).toBe(
        undefined
      );
    });
  });

  // allow_concurrent_runs=false: the locked admission check is the only guard.
  // The two daemons race occurrences in different minutes, so occurrence
  // uniqueness cannot save them; exactly one run may be admitted.
  for (const [label, sources] of [
    ['trigger vs cron', ['webhook', 'cron']],
    ['trigger vs trigger across a minute boundary', ['webhook', 'webhook']],
  ] as const) {
    it(`admits exactly one run for ${label} on a non-concurrent schedule`, async () => {
      for (let round = 0; round < 5; round++) {
        const seed = await seedTriggeredSchedule(db, `trigger-race-${generateId()}`);
        const handles = [db, dbB];
        const minute = Math.floor(Date.now() / 60_000) * 60_000;
        const results = await Promise.allSettled(
          sources.map((source, i) =>
            runWithTenantContext(seed.tenantId, async () => {
              const handle = handles[i];
              const daemon = new SchedulerService(
                handle,
                daemonApp(handle)
              ) as unknown as SchedulerInternals;
              const schedule = await runWithTenantDatabaseScope(handle, seed.tenantId, () =>
                new ScheduleRepository(handle).findById(seed.scheduleId)
              );
              return daemon.spawnScheduledSession(schedule!, minute + i * 60_000, Date.now(), {
                source,
                triggeredBy: seed.ownerId,
              });
            })
          )
        );
        const admitted = results.filter((r) => r.status === 'fulfilled' && r.value?.created);
        const refused = results.filter(
          (r) =>
            (r.status === 'rejected' && r.reason instanceof ScheduleBusyError) ||
            (r.status === 'fulfilled' && r.value === null)
        );
        expect({ admitted: admitted.length, refused: refused.length }).toEqual({
          admitted: 1,
          refused: 1,
        });
        const sessions = await runWithTenantDatabaseScope(db, seed.tenantId, () =>
          new SessionRepository(db).findByScheduleId(seed.scheduleId)
        );
        expect(sessions).toHaveLength(1);
      }
    });
  }
});
