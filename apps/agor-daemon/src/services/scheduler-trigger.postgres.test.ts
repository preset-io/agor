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
  runWithTenantDatabaseScope,
  ScheduleRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { ScheduleID, Session } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateScheduleTriggerToken } from './schedule-trigger-token';
import { SchedulerService, ScheduleTriggerNotFoundError } from './scheduler';

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

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'schedule trigger tenancy (PostgreSQL)',
  () => {
    let raw: RawDatabase;
    let db: TenantScopeAwareDatabase;

    beforeAll(async () => {
      raw = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(raw);
      if (!isPostgresDatabase(raw)) throw new Error('PostgreSQL test requires PostgreSQL');
      db = createTenantScopedDatabaseProxy(raw, { requireScope: true, label: 'trigger test' });
    });

    afterAll(async () => {
      await (raw as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it("confines a token to its own tenant's schedule and runs it there as the owner", async () => {
      const a = await seedTriggeredSchedule(db, `trigger-a-${generateId()}`);
      const b = await seedTriggeredSchedule(db, `trigger-b-${generateId()}`);
      const app = {
        get: (name: string) =>
          name === 'distributedWorkIdentity' ? { instanceId: 'test', bootId: 'test' } : undefined,
      } as unknown as ConstructorParameters<typeof SchedulerService>[1];
      // No static tenant: hosted mode discovers the tenant from the token hash.
      const scheduler = new SchedulerService(db, app);
      const runs: Array<{
        tenantId: string | undefined;
        scheduleId: ScheduleID;
        triggeredBy: string;
      }> = [];
      vi.spyOn(scheduler, 'executeScheduleNow').mockImplementation(async (opts) => {
        runs.push({
          tenantId: getCurrentTenantId(),
          scheduleId: opts.scheduleId,
          triggeredBy: opts.triggeredBy,
        });
        return {} as Session;
      });

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
  }
);
