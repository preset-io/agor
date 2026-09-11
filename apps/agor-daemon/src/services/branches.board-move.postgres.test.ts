import {
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  RepoRepository,
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

    it('allows same-tenant inherited movement and refuses a foreign board or branch without mutation', async () => {
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
      await runWithTenantDatabaseScope(db, b, async () => {
        expect(await new BranchRepository(db).findById(fb.branch.branch_id)).toEqual(fb.branch);
        expect(await new BoardObjectRepository(db).findByBranchId(fb.branch.branch_id)).toEqual(
          fb.object
        );
      });
    });
  }
);
