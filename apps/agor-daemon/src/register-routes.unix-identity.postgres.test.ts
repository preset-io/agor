import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  type TaskDispatchClaimResult,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Task, TaskPendingDispatchStatus, TenantID, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launchPendingTask } from './utils/session-unix-identity.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUniqueId = 100_000;

const tenantHiddenMatrix = (['delegated', 'strict'] as const).flatMap((mode) =>
  [false, true].flatMap((branchRbac) =>
    ([TaskStatus.CREATED, TaskStatus.QUEUED] as const).map((status) => ({
      mode,
      branchRbac,
      status,
    }))
  )
);

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'production pre-claim Unix identity tenant isolation (PostgreSQL RLS)',
  () => {
    let rawDb: Database;
    let db: ReturnType<typeof createTenantScopedDatabaseProxy>;

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL test requires PostgreSQL');
      db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'Unix identity launch RLS test database',
      });
    });

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it.each(tenantHiddenMatrix)(
      '$mode with branch_rbac=$branchRbac rejects a creator visible only to another tenant and leaves $status pending',
      async ({ mode, branchRbac, status }) => {
        const activeTenantId = `unix-launch-active-${generateId()}` as TenantID;
        const outsideTenantId = `unix-launch-outside-${generateId()}` as TenantID;
        const creatorId = generateId() as UUID;
        const suffix = creatorId.slice(-12);
        const stampedUsername = `alice-${suffix}`;

        await runWithTenantDatabaseScope(db, outsideTenantId, (tenantDb) =>
          new UsersRepository(tenantDb).create({
            user_id: creatorId,
            email: `${suffix}@outside.example`,
            unix_username: stampedUsername,
          })
        );
        await expect(
          runWithTenantDatabaseScope(db, outsideTenantId, (tenantDb) =>
            new UsersRepository(tenantDb).findById(creatorId)
          )
        ).resolves.toMatchObject({
          user_id: creatorId,
          unix_username: stampedUsername,
        });
        await expect(
          runWithTenantDatabaseScope(db, activeTenantId, (tenantDb) =>
            new UsersRepository(tenantDb).findById(creatorId)
          )
        ).resolves.toBeNull();

        const { session, task } = await runWithTenantDatabaseScope(
          db,
          activeTenantId,
          async (tenantDb) => {
            const repo = await new RepoRepository(tenantDb).create({
              repo_id: generateId(),
              slug: `unix-launch-${generateId()}`,
              name: 'Unix launch RLS test',
              repo_type: 'remote',
              remote_url: 'https://example.invalid/unix-launch.git',
              local_path: `/tmp/${generateId()}`,
              default_branch: 'main',
            });
            const branch = await new BranchRepository(tenantDb).create({
              branch_id: generateId(),
              repo_id: repo.repo_id,
              name: `unix-launch-${suffix}`,
              ref: 'main',
              branch_unique_id: branchUniqueId++,
              path: `/tmp/${generateId()}`,
              created_by: creatorId,
            });
            const session = await new SessionRepository(tenantDb).create({
              session_id: generateId(),
              branch_id: branch.branch_id,
              created_by: creatorId,
              agentic_tool: 'codex',
              unix_username: stampedUsername,
            });
            const task = await new TaskRepository(tenantDb).createPending({
              session_id: session.session_id,
              created_by: creatorId,
              full_prompt: 'prove RLS-hidden creator rejection',
              status,
            });
            return { session, task };
          }
        );

        const events: string[] = [];
        const originalFindById = UsersRepository.prototype.findById;
        const creatorLookup = vi
          .spyOn(UsersRepository.prototype, 'findById')
          .mockImplementation(async function (id: string) {
            events.push('lookup');
            return originalFindById.call(this, id);
          });
        const claimDispatch = vi.fn(
          async (pendingTask: Task & { status: TaskPendingDispatchStatus }) => {
            events.push('claim');
            return new TaskRepository(db).claimDispatchAndProjectSession(
              pendingTask.task_id,
              pendingTask.status,
              { status: TaskStatus.DISPATCHING }
            );
          }
        );
        const deferExecutorSpawn = vi.fn(() => events.push('defer'));
        const continueClaimedLaunch = vi.fn(async (claimedTask: Task) => {
          deferExecutorSpawn();
          return claimedTask;
        });
        const onClaimNotWon = vi.fn(async (claim: TaskDispatchClaimResult) => claim.task);

        let error: unknown;
        let creatorLookupCalls: string[][] = [];
        try {
          await launchPendingTask({
            db,
            tenantId: activeTenantId,
            execution: { unix_user_mode: mode, branch_rbac: branchRbac },
            task,
            session,
            claimDispatch,
            onClaimed: continueClaimedLaunch,
            onClaimNotWon,
          });
        } catch (cause) {
          error = cause;
        } finally {
          creatorLookupCalls = creatorLookup.mock.calls.map(([id]) => [id]);
          creatorLookup.mockRestore();
        }

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/Session creator not found/);
        expect(events).toEqual(['lookup']);
        expect(creatorLookupCalls).toEqual([[creatorId]]);
        expect(claimDispatch).not.toHaveBeenCalled();
        expect(continueClaimedLaunch).not.toHaveBeenCalled();
        expect(deferExecutorSpawn).not.toHaveBeenCalled();
        expect(onClaimNotWon).not.toHaveBeenCalled();
        await expect(
          runWithTenantDatabaseScope(db, activeTenantId, (tenantDb) =>
            new TaskRepository(tenantDb).findById(task.task_id)
          )
        ).resolves.toMatchObject({ status });
      }
    );
  }
);
