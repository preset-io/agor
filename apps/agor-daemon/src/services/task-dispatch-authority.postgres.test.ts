/**
 * PostgreSQL proof that hard user deletion and queued Task dispatch share the
 * tenant authorization fence and the Session -> Task row-lock boundary.
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
  runWithTenantDatabaseTransaction,
  SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { AuthenticatedParams, User, UserID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockTenantAuthorizationFence } from './tenant-authorization-fence.js';
import { UsersService } from './users.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = Date.now() % 1_000_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function params(actor: User, tenantId: string): AuthenticatedParams {
  return {
    provider: 'rest',
    user: { user_id: actor.user_id, email: actor.email, role: actor.role },
    tenant: { tenant_id: tenantId, source: 'auth_claim' },
  };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Task dispatch authority (PostgreSQL/RLS)',
  () => {
    let rawA: Database;
    let rawB: Database;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'task-dispatch-authority-a',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'task-dispatch-authority-b',
      });
    }, 60_000);

    afterAll(async () => {
      await Promise.all([
        (rawA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (rawB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    async function seedQueuedTask(tenantId: string, label: string) {
      return runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const users = new UsersRepository(scoped);
        const admin = await users.create({
          email: `${label}-admin-${generateId()}@example.invalid`,
          role: 'admin',
        });
        const owner = await users.create({
          email: `${label}-owner-${generateId()}@example.invalid`,
          role: 'member',
        });
        const actor = await users.create({
          email: `${label}-actor-${generateId()}@example.invalid`,
          role: 'member',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId(),
          slug: `${label}-${generateId()}`,
          name: label,
          repo_type: 'remote',
          remote_url: `https://example.invalid/${label}.git`,
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: label,
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
        const task = await new TaskRepository(scoped).createPending({
          session_id: session.session_id,
          full_prompt: label,
          created_by: actor.user_id,
          status: TaskStatus.QUEUED,
        });
        return { admin, actor, task };
      });
    }

    it('produces one durable outcome when deletion races queued dispatch', async () => {
      const deleteFirstTenant = `task-dispatch-delete-first-${generateId()}`;
      const deleteFirst = await seedQueuedTask(deleteFirstTenant, 'delete-first');
      const deletedBeforeCommit = deferred();
      const releaseDeletion = deferred();

      const deletion = runWithTenantDatabaseTransaction(dbA, deleteFirstTenant, async (scoped) => {
        const removed = await new UsersService(scoped).remove(
          deleteFirst.actor.user_id as UserID,
          params(deleteFirst.admin, deleteFirstTenant)
        );
        deletedBeforeCommit.resolve();
        await releaseDeletion.promise;
        return removed;
      });
      await deletedBeforeCommit.promise;

      let dispatchPassedFence = false;
      const dispatchAfterDeletion = runWithTenantDatabaseTransaction(
        dbB,
        deleteFirstTenant,
        async (scoped) => {
          await lockTenantAuthorizationFence(scoped, params(deleteFirst.admin, deleteFirstTenant));
          dispatchPassedFence = true;
          return new TaskRepository(scoped).claimDispatchAndProjectSession(
            deleteFirst.task.task_id,
            TaskStatus.QUEUED,
            { status: TaskStatus.DISPATCHING }
          );
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(dispatchPassedFence).toBe(false);
      releaseDeletion.resolve();

      await expect(deletion).resolves.toMatchObject({ user_id: deleteFirst.actor.user_id });
      await expect(dispatchAfterDeletion).resolves.toMatchObject({
        outcome: 'actor_missing',
        task: { status: TaskStatus.FAILED, queue_position: undefined },
      });

      const claimFirstTenant = `task-dispatch-claim-first-${generateId()}`;
      const claimFirst = await seedQueuedTask(claimFirstTenant, 'claim-first');
      const claimedBeforeCommit = deferred();
      const releaseClaim = deferred();

      const dispatch = runWithTenantDatabaseTransaction(dbA, claimFirstTenant, async (scoped) => {
        await lockTenantAuthorizationFence(scoped, params(claimFirst.admin, claimFirstTenant));
        const result = await new TaskRepository(scoped).claimDispatchAndProjectSession(
          claimFirst.task.task_id,
          TaskStatus.QUEUED,
          { status: TaskStatus.DISPATCHING }
        );
        claimedBeforeCommit.resolve();
        await releaseClaim.promise;
        return result;
      });
      await claimedBeforeCommit.promise;

      let deletionPassedFence = false;
      const deletionAfterClaim = runWithTenantDatabaseTransaction(
        dbB,
        claimFirstTenant,
        async (scoped) => {
          const removed = await new UsersService(scoped).remove(
            claimFirst.actor.user_id as UserID,
            params(claimFirst.admin, claimFirstTenant)
          );
          deletionPassedFence = true;
          return removed;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deletionPassedFence).toBe(false);
      releaseClaim.resolve();

      await expect(dispatch).resolves.toMatchObject({
        outcome: 'claimed',
        task: { status: TaskStatus.DISPATCHING, queue_position: undefined },
      });
      await expect(deletionAfterClaim).resolves.toMatchObject({
        user_id: claimFirst.actor.user_id,
      });
      await runWithTenantDatabaseScope(dbA, claimFirstTenant, async (scoped) => {
        await expect(
          new TaskRepository(scoped).findById(claimFirst.task.task_id)
        ).resolves.toMatchObject({
          status: TaskStatus.DISPATCHING,
          queue_position: undefined,
        });
      });
    });
  }
);
