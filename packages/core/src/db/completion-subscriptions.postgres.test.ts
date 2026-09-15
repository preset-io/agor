import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { CompletionSubscriptionID, SessionID, TaskID, UUID } from '../types/id';
import { TaskStatus } from '../types/task';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase } from './database-wrapper';
import { initializeDatabase } from './migrate';
import {
  BranchRepository,
  CompletionSubscriptionRepository,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from './repositories';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() % 1_000_000) + 4_000_000;

async function seedSubscription(db: Database, label: string, terminal = true) {
  const tenantId = `completion-${label}-${generateId()}`;
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}@example.invalid`,
      name: `Completion ${label}`,
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: tenantId,
      name: `Completion ${label}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/completion.git',
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
    });
    const task = await new TaskRepository(scoped).create({
      task_id: generateId() as TaskID,
      session_id: session.session_id,
      created_by: user.user_id,
      full_prompt: 'terminal routing fixture',
      status: TaskStatus.RUNNING,
      tool_use_count: 0,
    });
    const subscription = await new CompletionSubscriptionRepository(scoped).createRoot({
      requested_by_user_id: user.user_id as UUID,
      origin_session_id: session.session_id,
      origin_task_id: generateId() as TaskID,
      callback_session_id: session.session_id,
      root_session_id: session.session_id,
      root_task_id: task.task_id,
      root_branch_id: branch.branch_id,
    });
    if (terminal) {
      await new TaskRepository(scoped).update(task.task_id, {
        status: TaskStatus.COMPLETED,
        completed_at: new Date().toISOString(),
      });
    }
    return { tenantId, task, subscription };
  });
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Completion subscription RLS (PostgreSQL)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    });

    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('discovers terminal routing globally but rejects cross-tenant reads and mutation', async () => {
      const a = await seedSubscription(db, 'tenant-a');
      const b = await seedSubscription(db, 'tenant-b');
      const running = await seedSubscription(db, 'tenant-running', false);

      const refs = await runWithSystemDatabaseScope(
        db,
        'completion callback cross-tenant discovery',
        (systemDb) =>
          new CompletionSubscriptionRepository(systemDb).findActiveRefs(systemDb, { limit: 100 }),
        { capability: 'completion_callback_discovery' }
      );
      const routing = new Map(refs.map((ref) => [ref.subscription_id, ref.tenant_id]));
      expect(routing.get(a.subscription.subscription_id)).toBe(a.tenantId);
      expect(routing.get(b.subscription.subscription_id)).toBe(b.tenantId);
      expect(routing.has(running.subscription.subscription_id)).toBe(false);

      await runWithTenantDatabaseScope(db, a.tenantId, async (scoped) => {
        const subscriptions = new CompletionSubscriptionRepository(scoped);
        await expect(
          subscriptions.get(b.subscription.subscription_id as CompletionSubscriptionID)
        ).rejects.toThrow();
        await expect(
          subscriptions.markTerminalForTask(b.task.task_id, {
            session_id: b.task.session_id,
            task_id: b.task.task_id,
            status: 'completed',
            completed_at: new Date().toISOString(),
          })
        ).resolves.toBeNull();
      });
      await runWithTenantDatabaseScope(db, b.tenantId, async (scoped) => {
        await expect(
          new CompletionSubscriptionRepository(scoped).get(b.subscription.subscription_id)
        ).resolves.toMatchObject({ state: 'pending' });
      });
    });
  }
);
