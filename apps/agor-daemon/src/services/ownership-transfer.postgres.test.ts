import {
  CapabilityPolicyRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  initializeDatabase,
  runWithTenantContext,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import { OWNERSHIP_TRANSFER_SERVICES } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownershipApp, ownershipFixture, ownershipParams } from './ownership-transfer.test-support';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'ownership transfer (PostgreSQL RLS)',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    for (const kind of ['board', 'branch'] as const) {
      it(`allows same-tenant ${kind} transfer but rejects foreign resources, successors and actors`, async () => {
        const tenantA = `transfer-a-${generateId()}`;
        const tenantB = `transfer-b-${generateId()}`;
        const a = await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
          ownershipFixture(scoped)
        );
        const b = await runWithTenantDatabaseScope(db, tenantB, (scoped) =>
          ownershipFixture(scoped)
        );
        const app = ownershipApp(createTenantScopedDatabaseProxy(db));
        const service = app.service(OWNERSHIP_TRANSFER_SERVICES[kind]);
        const idA = kind === 'board' ? a.board.board_id : a.branch.branch_id;
        const idB = kind === 'board' ? b.board.board_id : b.branch.branch_id;
        const patch = (actor: typeof a.admin, id: string, expected: string, target: string) =>
          runWithTenantContext(tenantA, () =>
            service.patch(
              null,
              { expected_owner_user_id: expected, target_user_id: target },
              ownershipParams(actor.user_id, id, tenantA)
            )
          );
        await expect(
          patch(a.admin, idB, b.owner.user_id, a.successor.user_id)
        ).rejects.toMatchObject({ code: 403 });
        await expect(
          patch(a.admin, idA, a.owner.user_id, b.successor.user_id)
        ).rejects.toMatchObject({ code: 400 });
        await expect(
          patch(b.admin, idA, a.owner.user_id, a.successor.user_id)
        ).rejects.toMatchObject({ code: 401 });
        await expect(
          patch(a.admin, idA, a.owner.user_id, a.successor.user_id)
        ).resolves.toMatchObject({ primary_owner_user_id: a.successor.user_id });
        const foreign = await runWithTenantDatabaseScope(db, tenantB, (scoped) =>
          kind === 'board'
            ? new CapabilityPolicyRepository(scoped).getBoardPolicies(b.board.board_id)
            : new CapabilityPolicyRepository(scoped).getBranchPolicy(b.branch.branch_id)
        );
        expect(foreign.primary_owner_user_id).toBe(b.owner.user_id);
      });

      it(`serializes competing ${kind} transfers and rejects the stale expected owner`, async () => {
        const tenant = `transfer-race-${generateId()}`;
        const f = await runWithTenantDatabaseScope(db, tenant, (scoped) =>
          ownershipFixture(scoped)
        );
        const app = ownershipApp(createTenantScopedDatabaseProxy(db));
        const id = kind === 'board' ? f.board.board_id : f.branch.branch_id;
        const transfer = (target: string) =>
          runWithTenantContext(tenant, () =>
            app.service(OWNERSHIP_TRANSFER_SERVICES[kind]).patch(
              null,
              {
                expected_owner_user_id: f.owner.user_id,
                target_user_id: target,
              },
              ownershipParams(f.admin.user_id, id, tenant)
            )
          );
        const results = await Promise.allSettled([
          transfer(f.successor.user_id),
          transfer(f.admin.user_id),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(failure.reason).toMatchObject({ code: 409 });
      });
    }
  }
);
