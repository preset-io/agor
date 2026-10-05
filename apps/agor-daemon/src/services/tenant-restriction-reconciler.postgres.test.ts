/** Routing-only restriction discovery against real RLS: only closed tenants' live tasks are paged. */
import {
  applyTenantRestrictionIntent,
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { SessionID, TaskID, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const begin = vi.hoisted(() => vi.fn(async (_input: { taskId: string }) => ({})));
vi.mock('../termination-coordinator.js', () => ({ beginExecutorTermination: begin }));

import { TenantRestrictionReconciler } from './tenant-restriction-reconciler.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
let branchUnique = (Date.now() % 1_000_000) + 5_000_000;

async function seedRunningTask(db: Database): Promise<{ tenantId: string; taskId: string }> {
  const tenantId = `restriction-reconciler-${generateId()}`;
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}@example.com`,
      name: 'Restriction reconciler',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: tenantId,
      name: tenantId,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/restriction.git',
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
    const task = await new TaskRepository(scoped).create({
      task_id: generateId() as TaskID,
      session_id: session.session_id,
      created_by: user.user_id as UUID,
      full_prompt: 'live task',
      status: TaskStatus.RUNNING,
      message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
      git_state: { ref_at_start: 'main', sha_at_start: 'live' },
    });
    return { tenantId, taskId: task.task_id };
  });
}

describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'TenantRestrictionReconciler PostgreSQL discovery',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
    }, 60_000);
    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('pages only restricted tenants and stops only their live tasks', async () => {
      const open = await seedRunningTask(db);
      const closed = await seedRunningTask(db);
      const scoped = createTenantScopedDatabaseProxy(db, {
        requireScope: true,
        label: 'restriction reconciler',
      });
      const reconciler = new TenantRestrictionReconciler(scoped, {} as never);

      await reconciler.checkOnce();
      const stoppedBefore = begin.mock.calls.map(([input]) => input.taskId);
      expect(stoppedBefore).not.toContain(open.taskId);
      expect(stoppedBefore).not.toContain(closed.taskId);

      await applyTenantRestrictionIntent(db, closed.tenantId, {
        version: 1,
        controllerId: 'control-one',
        placementId: 'placement-one',
        operationId: 'suspend-one',
        revision: 1,
        action: 'restrict',
      });
      begin.mockClear();
      const stats = await reconciler.checkOnce();

      expect(begin.mock.calls.map(([input]) => input.taskId)).toEqual([closed.taskId]);
      expect(stats).toMatchObject({ candidates: 1, stopping: 1, failures: 0 });
    });
  }
);
