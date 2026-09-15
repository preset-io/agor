import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRaw, rawRows } from './database-wrapper';
import { listManagedOAuthMaintenanceTenants } from './repositories/mcp-managed-oauth-maintenance';
import { MCPManagedOAuthOutboxRepository } from './repositories/mcp-managed-oauth-outbox';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';
import { seedManagedRefreshGrant } from './test-support/managed-oauth-fixture';
import { createOwnedPostgres, type OwnedPostgres } from './test-support/owned-postgres';

describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'IDs-only managed maintenance capability (real non-owner)',
  () => {
    let owned: OwnedPostgres;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30000);
    it('pages live grants and orphan jobs without granting handle, ciphertext or token SELECT', async () => {
      const [definer] =
        await owned.sql`SELECT p.prosecdef,r.rolsuper,r.rolbypassrls,has_column_privilege(p.proowner,'public.user_mcp_oauth_tokens','oauth_access_token','SELECT') AS can_read_token FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
        WHERE p.oid='public.agor_mcp_managed_oauth_maintenance_tenants(text,integer)'::regprocedure`;
      expect(definer).toEqual({
        prosecdef: true,
        rolsuper: false,
        rolbypassrls: false,
        can_read_token: false,
      });
      const live = await seedManagedRefreshGrant(owned.db, 'synthetic-maintenance-master');
      const orphan = await seedManagedRefreshGrant(owned.db, 'synthetic-maintenance-master');
      await seedManagedRefreshGrant(owned.db, 'synthetic-maintenance-master', 'default');
      await runWithTenantDatabaseScope(owned.db, orphan.tenant, async (db) => {
        await executeRaw(db, sql`DELETE FROM public.users WHERE user_id=${orphan.user}`);
        expect(
          (await new MCPManagedOAuthOutboxRepository(db).listPending(orphan.tenant))[0].kind
        ).toBe('close');
      });
      await expect(
        owned.sql`SELECT * FROM public.agor_mcp_managed_oauth_maintenance_tenants(NULL,100)`
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runWithTenantDatabaseScope(owned.db, live.tenant, (db) =>
          listManagedOAuthMaintenanceTenants(db)
        )
      ).rejects.toThrow('capability');
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await runWithSystemDatabaseScope(
          owned.db,
          'fixture routing only',
          async (db) => {
            const page = await listManagedOAuthMaintenanceTenants(db, cursor, 1);
            expect(Object.keys(page)).toEqual(['tenantIds', 'nextCursor']);
            expect(
              rawRows(
                await executeRaw(
                  db,
                  sql`SELECT oauth_access_token,managed_metadata FROM public.user_mcp_oauth_tokens WHERE credential_origin='cloud_managed_v1'`
                )
              )
            ).toEqual([]);
            expect(
              rawRows(
                await executeRaw(
                  db,
                  sql`SELECT sealed_material,managed_metadata FROM public.mcp_managed_oauth_outbox`
                )
              )
            ).toEqual([]);
            return page;
          },
          { capability: 'mcp_oauth_maintenance' }
        );
        ids.push(...page.tenantIds);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(ids).toEqual([live.tenant, orphan.tenant, 'default'].sort());
      await expect(
        runWithSystemDatabaseScope(
          owned.db,
          'fixture routing limit',
          (db) =>
            executeRaw(
              db,
              sql`SELECT * FROM public.agor_mcp_managed_oauth_maintenance_tenants(NULL,101)`
            ),
          { capability: 'mcp_oauth_maintenance' }
        )
      ).rejects.toThrow();
    });
  }
);
