import { rm } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { expect, it } from 'vitest';
import { createDatabase } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import {
  beforeAttributionMigrations,
  seedHistoricalGrants,
  stageFailingAttributionMigration,
} from './mcp-oauth-grant-attribution-migration.test-support';
import { runMigrations } from './migrate';
import { runWithTenantDatabaseScope } from './tenant-scope';

const url = process.env.AGOR_TEST_POSTGRES_URL;

it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'upgrades PostgreSQL 0104 across tenants under FORCE RLS without guessing shared consenters',
  async () => {
    const folder = await beforeAttributionMigrations('postgres');
    const db = createDatabase({ dialect: 'postgresql', url: url! });
    if (!isPostgresDatabase(db)) throw new Error('Expected PostgreSQL');
    try {
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT rolsuper, rolbypassrls
        FROM pg_roles WHERE rolname = current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await migrate(db, { migrationsFolder: folder });
      const fixtures = new Map<string, Awaited<ReturnType<typeof seedHistoricalGrants>>>();
      for (const tenant of ['default', 'attribution-migration-other']) {
        fixtures.set(tenant, await runWithTenantDatabaseScope(db, tenant, seedHistoricalGrants));
      }
      await expect(runMigrations(db)).rejects.toThrow(/offline/i);
      await stageFailingAttributionMigration(folder, 'postgres');
      await expect(migrate(db, { migrationsFolder: folder })).rejects.toThrow();
      for (const tenant of fixtures.keys()) {
        await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
          expect(
            rawRows(await executeRaw(scoped, sql`SELECT user_id FROM user_mcp_oauth_tokens`))
          ).toHaveLength(2);
        });
      }
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT polname FROM pg_policy WHERE polname LIKE 'grant_attribution_0105_%'`
          )
        )
      ).toEqual([]);
      await runMigrations(db, { allowOfflineCutover: true });
      for (const [tenant, fixture] of fixtures) {
        await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
          expect(
            rawRows(await executeRaw(scoped, sql`SELECT * FROM user_mcp_oauth_tokens`))
          ).toEqual([{ ...fixture.personal, granted_by_user_id: fixture.userId }]);
        });
      }
      await runWithTenantDatabaseScope(db, 'not-a-fixture-tenant', async (scoped) => {
        // Even replaying the migration GUC cannot reopen its temporary policy.
        await executeRaw(
          scoped,
          sql`SELECT set_config('agor.system_scope', 'grant_attribution_0105', true)`
        );
        expect(rawRows(await executeRaw(scoped, sql`SELECT * FROM user_mcp_oauth_tokens`))).toEqual(
          []
        );
      });
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT polname FROM pg_policy
        WHERE polname LIKE 'grant_attribution_0105_%'`
          )
        )
      ).toEqual([]);
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE relname = 'user_mcp_oauth_tokens'`
          )
        )
      ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      await runMigrations(db, { allowOfflineCutover: true });
    } finally {
      await (db as typeof db & { $client: { end(): Promise<void> } }).$client.end();
      await rm(folder, { recursive: true, force: true });
    }
  },
  60_000
);
