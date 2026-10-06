/**
 * PostgreSQL proof that a Session settings patch racing a dispatch claim never
 * drops the Task the claim appends to Session.tasks: both serialize on the
 * Session row lock and each merges the row it re-reads under that lock.
 */
import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  SessionRepository,
  sql,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() + 500_000) % 1_000_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Session.tasks dispatch vs settings patch (PostgreSQL/RLS)',
  () => {
    let rawA: Database;
    let rawB: Database;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      dbA = createTenantScopedDatabaseProxy(rawA, { requireScope: true, label: 'session-tasks-a' });
      dbB = createTenantScopedDatabaseProxy(rawB, { requireScope: true, label: 'session-tasks-b' });
    }, 60_000);

    afterAll(async () => {
      await Promise.all(
        [rawA, rawB].map((db) =>
          (db as Database & { $client: { end: () => Promise<void> } }).$client.end()
        )
      );
    });

    async function seed(tenantId: string) {
      return runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const owner = await new UsersRepository(scoped).create({
          email: `session-tasks-${generateId()}@example.invalid`,
          role: 'member',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId(),
          slug: `session-tasks-${generateId()}`,
          name: 'session-tasks',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/session-tasks.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: 'session-tasks',
          ref: 'main',
          branch_unique_id: branchUnique++,
          path: `/tmp/${generateId()}`,
          created_by: owner.user_id,
        });
        const session = await new SessionRepository(scoped).create({
          session_id: generateId(),
          branch_id: branch.branch_id,
          agentic_tool: 'claude-code',
          created_by: owner.user_id,
        });
        const queue = new TaskRepository(scoped);
        const first = await queue.createPending({
          session_id: session.session_id,
          full_prompt: 'first',
          created_by: owner.user_id,
          status: TaskStatus.QUEUED,
        });
        const second = await queue.createPending({
          session_id: session.session_id,
          full_prompt: 'second',
          created_by: owner.user_id,
          status: TaskStatus.QUEUED,
        });
        return { session, first, second };
      });
    }

    it('keeps every appended Task whichever of the two takes the Session lock first', async () => {
      const tenant = `session-tasks-${generateId()}`;
      const { session, first, second } = await seed(tenant);

      // A settings patch holds the Session lock; the dispatch claim waits on it.
      const patchLocked = deferred();
      const releasePatch = deferred();
      const patch = runWithTenantDatabaseTransaction(dbA, tenant, async (scoped) => {
        await executeRaw(
          scoped,
          sql`SELECT 1 FROM sessions WHERE session_id = ${session.session_id} FOR UPDATE`
        );
        patchLocked.resolve();
        await releasePatch.promise;
        return new SessionRepository(scoped).update(session.session_id, { title: 'patched first' });
      });
      await patchLocked.promise;
      let claimed = false;
      const claim = runWithTenantDatabaseTransaction(dbB, tenant, async (scoped) => {
        const result = await new TaskRepository(scoped).claimDispatchAndProjectSession(
          first.task_id,
          TaskStatus.QUEUED,
          { status: TaskStatus.DISPATCHING }
        );
        claimed = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(claimed).toBe(false);
      releasePatch.resolve();
      await expect(patch).resolves.toMatchObject({ title: 'patched first' });
      await expect(claim).resolves.toMatchObject({ outcome: 'claimed' });

      // The claim holds the lock; a settings patch read before it committed waits.
      // The first turn completes and the Session is ready for the next.
      await runWithTenantDatabaseScope(dbA, tenant, async (scoped) => {
        await new TaskRepository(scoped).update(first.task_id, { status: TaskStatus.COMPLETED });
        await new SessionRepository(scoped).update(session.session_id, {
          status: SessionStatus.IDLE,
          ready_for_prompt: true,
        });
      });
      const claimLocked = deferred();
      const releaseClaim = deferred();
      const secondClaim = runWithTenantDatabaseTransaction(dbA, tenant, async (scoped) => {
        const result = await new TaskRepository(scoped).claimDispatchAndProjectSession(
          second.task_id,
          TaskStatus.QUEUED,
          { status: TaskStatus.DISPATCHING }
        );
        claimLocked.resolve();
        await releaseClaim.promise;
        return result;
      });
      await claimLocked.promise;
      let patchedSecond = false;
      const secondPatch = runWithTenantDatabaseScope(dbB, tenant, async (scoped) => {
        const stale = await new SessionRepository(scoped).findById(session.session_id);
        expect(stale?.tasks).toEqual([first.task_id]);
        const result = await new SessionRepository(scoped).update(session.session_id, {
          title: 'patched second',
        });
        patchedSecond = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(patchedSecond).toBe(false);
      releaseClaim.resolve();
      await expect(secondClaim).resolves.toMatchObject({ outcome: 'claimed' });
      await expect(secondPatch).resolves.toMatchObject({
        title: 'patched second',
        tasks: [first.task_id, second.task_id],
      });

      const final = await runWithTenantDatabaseScope(dbA, tenant, (scoped) =>
        new SessionRepository(scoped).findById(session.session_id)
      );
      expect(final?.tasks).toEqual([first.task_id, second.task_id]);
    });
  }
);
