import {
  BoardObjectRepository,
  BoardRepository,
  BranchDeletionRepository,
  BranchMaintenanceRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  lockBranchReferenceMutation,
  RepoRepository,
  rawRows,
  runWithoutTenantDatabaseScope,
  runWithTenantDatabaseScope,
  sql,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { BranchID, TenantID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoardObjectsService } from './board-objects';
import { BoardsService } from './boards';
import { BranchesService } from './branches';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'branch board moves (PostgreSQL/RLS)',
  () => {
    let raw: Database;
    beforeAll(async () => {
      raw = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(raw);
      const result = await executeRaw(
        raw,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      expect(
        (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0]
      ).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
      });
    }, 60_000);
    afterAll(async () => {
      await (raw as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('isolates board moves and serializes teammate movement against deletion reference scans', async () => {
      const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
      const a = `move-a-${generateId()}` as TenantID;
      const b = `move-b-${generateId()}` as TenantID;
      const seed = (tenant: TenantID) =>
        runWithTenantDatabaseScope(db, tenant, async () => {
          const user = await new UsersRepository(db).create({
            email: `${tenant}@example.test`,
            role: 'member',
          });
          const boards = new BoardRepository(db);
          const source = await boards.create({ name: 'Source', created_by: user.user_id });
          const target = await boards.create({ name: 'Target', created_by: user.user_id });
          const repo = await new RepoRepository(db).create({
            name: tenant,
            slug: tenant,
            repo_type: 'local',
            local_path: `/tmp/${tenant}`,
            default_branch: 'main',
          });
          const branch = await new BranchRepository(db).create({
            branch_id: generateId() as BranchID,
            repo_id: repo.repo_id,
            board_id: source.board_id,
            permission_binding: 'inherit',
            created_by: user.user_id,
            name: 'branch',
            ref: 'main',
            path: `/tmp/${tenant}/branch`,
            branch_unique_id: 1,
          });
          const object = await new BoardObjectRepository(db).create({
            board_id: source.board_id,
            branch_id: branch.branch_id,
            position: { x: 1, y: 2 },
            zone_id: 'source-zone',
          });
          return { user, source, target, branch, object };
        });
      const fa = await seed(a);
      const fb = await seed(b);
      const app = feathers();
      app.set('config', {});
      const service = new BranchesService(db, app);
      app.use('branches', service);
      app.use('boards', new BoardsService(db));
      app.use('board-objects', new BoardObjectsService(db));
      const params = {
        tenant: { tenant_id: a, source: 'auth_claim' as const },
        provider: 'rest',
        user: { user_id: fa.user.user_id, email: fa.user.email, role: 'member' },
      };
      await runWithTenantDatabaseScope(db, a, async () => {
        await expect(
          service.patch(fa.branch.branch_id, { board_id: fb.target.board_id }, params)
        ).rejects.toThrow();
        await expect(
          service.patch(fb.branch.branch_id, { board_id: fa.target.board_id }, params)
        ).rejects.toThrow();
        expect(await new BranchRepository(db).findById(fa.branch.branch_id)).toEqual(fa.branch);
        expect(await new BoardObjectRepository(db).findByBranchId(fa.branch.branch_id)).toEqual(
          fa.object
        );
        await expect(
          service.patch(fa.branch.branch_id, { board_id: fa.target.board_id }, params)
        ).resolves.toMatchObject({ board_id: fa.target.board_id, permission_binding: 'inherit' });
        const policy = await new CapabilityPolicyRepository(db).getBranchPolicy(
          fa.branch.branch_id
        );
        expect(policy.inherited_config).toEqual(
          (await new CapabilityPolicyRepository(db).getBoardPolicies(fa.target.board_id))
            .branch_template
        );
        const placement = await new BoardObjectRepository(db).findByBranchId(fa.branch.branch_id);
        expect(placement?.board_id).toBe(fa.target.board_id);
        expect(placement?.zone_id).toBeUndefined();
      });
      // Hold deletion's reference lock, then admit a move on an independent
      // connection. The move must wait BEFORE taking this same actor's User row.
      const peerRaw = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      const peer = createTenantScopedDatabaseProxy(peerRaw, { requireScope: true });
      try {
        const fixture = await runWithTenantDatabaseScope(db, a, async (scoped) => {
          const branches = new BranchRepository(scoped);
          const victim = await branches.create({
            repo_id: fa.branch.repo_id,
            ref: fa.branch.ref,
            created_by: fa.branch.created_by,
            board_id: fa.branch.board_id,
            permission_binding: fa.branch.permission_binding,
            branch_id: generateId() as BranchID,
            name: 'victim',
            path: `/tmp/${a}/victim`,
            branch_unique_id: 2,
          });
          const teammate = await branches.create({
            repo_id: fa.branch.repo_id,
            ref: fa.branch.ref,
            created_by: fa.branch.created_by,
            board_id: fa.branch.board_id,
            permission_binding: fa.branch.permission_binding,
            branch_id: generateId() as BranchID,
            name: 'teammate',
            path: `/tmp/${a}/teammate`,
            branch_unique_id: 3,
            custom_context: { teammate: { kind: 'teammate', displayName: 'Fixture' } },
          });
          const maintenance = new BranchMaintenanceRepository(scoped);
          const { claim } = await maintenance.claim(victim.branch_id, 'delete');
          const invocation = await maintenance.beginExecution(claim);
          await maintenance.claimExecution(claim, invocation);
          // Disposable fixture starts exactly at the user-reference page.
          await executeRaw(
            scoped,
            sql`UPDATE branches SET data = jsonb_set(data,
            '{maintenance,reference_cursor}', '{"table":3}'::jsonb)
            WHERE branch_id = ${victim.branch_id}`
          );
          return { claim, invocation, teammate };
        });
        const peerApp = feathers();
        peerApp.set('config', {});
        const movingService = new BranchesService(peer, peerApp);
        peerApp.use('branches', movingService);
        peerApp.use('boards', new BoardsService(peer));
        peerApp.use('board-objects', new BoardObjectsService(peer));
        let moving: Promise<unknown> | undefined;
        let pid: number | undefined;
        try {
          await runWithTenantDatabaseScope(db, a, async (scoped) => {
            const deletionPid = Number(
              rawRows(await executeRaw(scoped, sql`SELECT pg_backend_pid() AS pid`))[0]!.pid
            );
            await lockBranchReferenceMutation(scoped);
            // AsyncLocalStorage otherwise reuses the deletion transaction even
            // when a second pool is supplied; force a genuinely independent unit.
            moving = runWithoutTenantDatabaseScope(() =>
              runWithTenantDatabaseScope(peer, a, async (movingDb) => {
                pid = Number(
                  rawRows(await executeRaw(movingDb, sql`SELECT pg_backend_pid() AS pid`))[0]!.pid
                );
                expect(pid).not.toBe(deletionPid);
                return movingService.patch(
                  fixture.teammate.branch_id,
                  {
                    board_id: fa.target.board_id,
                    custom_context: {
                      teammate: { kind: 'teammate', displayName: 'Moved fixture' },
                    },
                  },
                  params
                );
              })
            );
            // Attach a rejection handler immediately; await the original below.
            void moving.catch(() => {});
            const deadline = Date.now() + 5000;
            for (;;) {
              const waiting =
                pid &&
                rawRows(
                  await executeRaw(
                    raw,
                    sql`SELECT 1 FROM pg_locks WHERE pid = ${pid} AND locktype = 'advisory' AND NOT granted`
                  )
                ).length;
              if (waiting) break;
              if (Date.now() > deadline)
                throw new Error('Move did not reach the reference-lock boundary');
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            // Under the old lock order this page and the move deadlock on User.
            await new BranchDeletionRepository(scoped).quiescePage(
              fixture.claim,
              fixture.invocation
            );
          });
        } finally {
          // Releasing the deletion transaction lets the admitted move finish.
          await moving;
        }
        await runWithTenantDatabaseScope(peer, a, async (scoped) => {
          expect(
            (await new BranchRepository(scoped).findById(fixture.teammate.branch_id))?.board_id
          ).toBe(fa.target.board_id);
        });
      } finally {
        await (peerRaw as Database & { $client: { end: () => Promise<void> } }).$client.end();
      }
      await runWithTenantDatabaseScope(db, b, async () => {
        expect(await new BranchRepository(db).findById(fb.branch.branch_id)).toEqual(fb.branch);
        expect(await new BoardObjectRepository(db).findByBranchId(fb.branch.branch_id)).toEqual(
          fb.object
        );
      });
    });
  }
);
