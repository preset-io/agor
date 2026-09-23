import { rm } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { expect, it } from 'vitest';
import { createDatabase } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import { runMigrations } from './migrate';
import {
  beforeSessionRecencyMigrations,
  seedHistoricalSessionRecency,
  stageFailingSessionRecencyMigration,
} from './session-recency-migration.test-support';
import { runWithTenantDatabaseScope } from './tenant-scope';

const url = process.env.AGOR_TEST_POSTGRES_URL;
it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'backfills every tenant atomically under FORCE RLS and leaves no migration authority',
  async () => {
    const folder = await beforeSessionRecencyMigrations('postgres');
    const db = createDatabase({ dialect: 'postgresql', url: url! });
    if (!isPostgresDatabase(db)) throw new Error('Expected PostgreSQL');
    try {
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await migrate(db, { migrationsFolder: folder });
      const fixtures = new Map<string, Awaited<ReturnType<typeof seedHistoricalSessionRecency>>>();
      for (const tenant of ['default', 'recency-other']) {
        fixtures.set(
          tenant,
          await runWithTenantDatabaseScope(db, tenant, seedHistoricalSessionRecency)
        );
      }
      const policies = async () =>
        rawRows(
          await executeRaw(
            db,
            sql`SELECT policyname,qual,with_check FROM pg_policies WHERE tablename='sessions' ORDER BY policyname`
          )
        );
      const beforePolicies = await policies();
      await stageFailingSessionRecencyMigration(folder, 'postgres');
      await expect(migrate(db, { migrationsFolder: folder })).rejects.toThrow();
      expect(await policies()).toEqual(beforePolicies);
      for (const [tenant, fixture] of fixtures) {
        await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
          expect(
            rawRows(await executeRaw(scoped, sql`SELECT * FROM sessions ORDER BY session_id`))
          ).toEqual(fixture.rows);
        });
      }
      await runMigrations(db);
      expect(await policies()).toEqual(beforePolicies);
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.sessions'::regclass`
          )
        )
      ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT attnotnull FROM pg_attribute WHERE attrelid='public.sessions'::regclass AND attname='updated_at'`
          )
        )
      ).toEqual([{ attnotnull: true }]);
      for (const [tenant, fixture] of fixtures) {
        await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
          expect(
            rawRows(await executeRaw(scoped, sql`SELECT * FROM sessions ORDER BY session_id`))
          ).toEqual(
            fixture.rows.map((row) => ({ ...row, updated_at: row.updated_at ?? row.created_at }))
          );
          expect(
            rawRows(
              await executeRaw(
                scoped,
                sql`SELECT * FROM tasks WHERE task_id=${fixture.task.task_id}`
              )
            )
          ).toEqual(fixture.taskRows);
        });
        await expect(
          runWithTenantDatabaseScope(db, tenant, (scoped) =>
            executeRaw(
              scoped,
              sql`UPDATE sessions SET updated_at=NULL WHERE session_id=${fixture.parent.session_id}`
            )
          )
        ).rejects.toThrow();
        await expect(
          runWithTenantDatabaseScope(db, tenant, (scoped) =>
            executeRaw(
              scoped,
              sql`INSERT INTO sessions(tenant_id,session_id,created_at,created_by,status,agentic_tool,branch_id,data)
          SELECT tenant_id,'missing-recency',created_at,created_by,status,agentic_tool,branch_id,data FROM sessions LIMIT 1`
            )
          )
        ).rejects.toThrow();
      }
      await runWithTenantDatabaseScope(db, 'recency-empty', async (scoped) => {
        // Replaying the now-removed migration scope must not expose other tenants.
        await executeRaw(
          scoped,
          sql`SELECT set_config('agor.system_scope','session_recency_0113',true)`
        );
        expect(rawRows(await executeRaw(scoped, sql`SELECT session_id FROM sessions`))).toEqual([]);
      });
      await runMigrations(db);
    } finally {
      await (db as typeof db & { $client: { end(): Promise<void> } }).$client.end();
      await rm(folder, { recursive: true, force: true });
    }
  },
  60000
);
