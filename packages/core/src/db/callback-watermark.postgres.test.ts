import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPreviousCallbackJournal } from './callback-watermark.test-support';
import { createDatabase, type Database } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import { checkMigrationStatus, runMigrations } from './migrate';
import { UsersRepository } from './repositories/users';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  '7475feacb callback watermark upgrade',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL required');
      const postgresDb = db;
      await withPreviousCallbackJournal('postgres', (migrationsFolder) =>
        migrate(postgresDb, { migrationsFolder })
      );
    });
    afterAll(async () => {
      await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    it('restores narrowly scoped API-key host discovery after watermark 1790129000214', async () => {
      const policy = () =>
        executeRaw(
          db,
          sql`SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_variables' AND policyname = 'api_key_host_tenant_discovery'`
        ).then(rawRows);
      expect(await policy()).toEqual([]);
      expect(await checkMigrationStatus(db)).toMatchObject({
        pending: ['0116_user_api_key_source', '0117_callback_ownership_reconciliation'],
      });
      await runMigrations(db);
      expect(await policy()).toEqual([
        { policyname: 'api_key_host_tenant_discovery', cmd: 'SELECT' },
      ]);
      await executeRaw(
        db,
        sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1790129000216`
      );
      await runMigrations(db);
      expect(await policy()).toHaveLength(1);
      expect(await checkMigrationStatus(db)).toMatchObject({ hasPending: false });
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);

      await runWithTenantDatabaseScope(db, 'watermark-a', async (scoped) => {
        const owner = await new UsersRepository(scoped).create({
          email: 'watermark@example.invalid',
        });
        await executeRaw(
          scoped,
          sql`INSERT INTO user_api_keys (tenant_id, id, user_id, name, prefix, key_hash, created_at)
          VALUES ('watermark-a', 'hidden-key', ${owner.user_id}, 'hidden', 'fixture', 'fixture-hash', now())`
        );
        await executeRaw(
          scoped,
          sql`INSERT INTO app_variables (variable_id, tenant_id, namespace, key, value_text, created_at, updated_at) VALUES
        ('watermark-routing', 'watermark-a', 'tenant.routing', 'public_url', 'https://watermark.example', now(), now()),
        ('watermark-private-key', 'watermark-a', 'tenant.routing', 'private', 'hidden', now(), now()),
        ('watermark-private-namespace', 'watermark-a', 'private', 'public_url', 'hidden', now(), now())`
        );
      });
      const rows = (scoped: Database) =>
        executeRaw(
          scoped,
          sql`SELECT namespace, key FROM app_variables WHERE tenant_id = 'watermark-a'`
        ).then(rawRows);
      await runWithTenantDatabaseScope(db, 'watermark-b', async (scoped) => {
        expect(await rows(scoped)).toEqual([]);
      });
      await runWithSystemDatabaseScope(db, 'watermark-no-capability', async (scoped) => {
        expect(await rows(scoped)).toEqual([]);
      });
      await runWithSystemDatabaseScope(
        db,
        'watermark-host-discovery',
        async (scoped) => {
          expect(await rows(scoped)).toEqual([{ namespace: 'tenant.routing', key: 'public_url' }]);
          expect(
            rawRows(
              await executeRaw(
                scoped,
                sql`UPDATE app_variables SET value_text = 'foreign' WHERE tenant_id = 'watermark-a' RETURNING key`
              )
            )
          ).toEqual([]);
          expect(
            rawRows(
              await executeRaw(
                scoped,
                sql`SELECT * FROM user_api_keys WHERE tenant_id = 'watermark-a'`
              )
            )
          ).toEqual([]);
        },
        { capability: 'api_key_host_tenant_discovery' }
      );
    });
  }
);
