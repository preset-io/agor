import { rm } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { expect, it } from 'vitest';
import { createDatabase } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import {
  beforeKbNamespaceOthersCanMigration,
  KB_NAMESPACE_OTHERS_CAN_CASES,
  readKbNamespaceOthersCan,
  seedKbNamespaceOthersCanCases,
} from './kb-namespace-others-can-migration.test-support';
import { OfflineMigrationCutoverRequiredError, runMigrations } from './migrate';
import { runWithTenantDatabaseScope } from './tenant-scope';

const url = process.env.AGOR_TEST_POSTGRES_URL;
it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'normalizes every tenant under FORCE RLS and restores it',
  async () => {
    const folder = await beforeKbNamespaceOthersCanMigration('postgres');
    const db = createDatabase({ dialect: 'postgresql', url: url! });
    if (!isPostgresDatabase(db)) throw new Error('Expected PostgreSQL');
    try {
      await migrate(db, { migrationsFolder: folder });
      const tenants = ['default', 'kb-others-can-other'];
      const ids = new Map<string, string[]>();
      for (const tenant of tenants) {
        ids.set(
          tenant,
          await runWithTenantDatabaseScope(db, tenant, (scoped) =>
            seedKbNamespaceOthersCanCases(scoped, tenant)
          )
        );
      }
      await expect(runMigrations(db)).rejects.toBeInstanceOf(OfflineMigrationCutoverRequiredError);
      await runMigrations(db, { allowOfflineCutover: true });
      for (const tenant of tenants) {
        await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
          expect(await readKbNamespaceOthersCan(scoped, ids.get(tenant)!)).toEqual(
            KB_NAMESPACE_OTHERS_CAN_CASES.map(([, expected]) => expected)
          );
        });
      }
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.kb_namespaces'::regclass`
          )
        )
      ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
  60000
);
