import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import { checkMigrationStatus, runMigrations } from './migrate';
import { applyTenantRestrictionIntent, readTenantRestrictionIntents } from './tenant-restriction';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'restriction migration upgrade (PostgreSQL)',
  () => {
    it('upgrades main and historical feature watermarks without losing restriction state', async () => {
      const db = createDatabase({ url: url! });
      const folder = await mkdtemp(join(tmpdir(), 'agor-restriction-pg-'));
      try {
        if (!isPostgresDatabase(db)) throw new Error('PostgreSQL required');
        await cp(new URL('../../drizzle/postgres/', import.meta.url), folder, { recursive: true });
        const path = join(folder, 'meta/_journal.json');
        const journal = JSON.parse(await readFile(path, 'utf8'));
        journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 115);
        await writeFile(path, JSON.stringify(journal));
        await migrate(db, { migrationsFolder: folder });
        // Main's watermark is already beyond the feature's old timestamp.
        await runMigrations(db);
        expect((await checkMigrationStatus(db)).pending).toEqual([]);
        // Reconstruct the old feature ledger/schema after proving main upgrade.
        // Restriction rows existed, but neither later API-key change did.
        await executeRaw(db, sql`DROP POLICY api_key_host_tenant_discovery ON app_variables`);
        await executeRaw(db, sql`ALTER TABLE user_api_keys DROP COLUMN source`);
        await executeRaw(
          db,
          sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= 1790129000214`
        );
        await executeRaw(
          db,
          sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('historical-tenant-restrictions', 1790129000214)`
        );
        await applyTenantRestrictionIntent(db, 'migration-tenant', {
          version: 1,
          controllerId: 'controller',
          placementId: 'placement',
          operationId: 'operation',
          revision: 7,
          action: 'restrict',
        });
        await runMigrations(db);
        expect(await readTenantRestrictionIntents(db, 'migration-tenant')).toEqual([
          expect.objectContaining({ revision: 7, phase: 'restricted' }),
        ]);
        expect(
          rawRows(
            await executeRaw(
              db,
              sql`SELECT policyname FROM pg_policies WHERE tablename = 'app_variables' AND policyname = 'api_key_host_tenant_discovery'`
            )
          )
        ).toHaveLength(1);
        expect(
          rawRows(
            await executeRaw(
              db,
              sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_api_keys' AND column_name = 'source'`
            )
          )
        ).toHaveLength(1);
        expect(
          rawRows(
            await executeRaw(
              db,
              sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'tenant_restrictions'::regclass`
            )
          )
        ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
        await runMigrations(db);
        expect((await checkMigrationStatus(db)).pending).toEqual([]);
      } finally {
        await (db as typeof db & { $client: { end(): Promise<void> } }).$client.end();
        await rm(folder, { recursive: true, force: true });
      }
    }, 60_000);
  }
);
