import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { executeRaw, rawRows } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'Withdrawn completion storage compatibility (PostgreSQL)',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    async function policies() {
      return rawRows(
        await executeRaw(
          db,
          sql`SELECT policyname FROM pg_policies
        WHERE tablename IN ('completion_subscriptions', 'tasks')`
        )
      ).map((row) => row.policyname);
    }

    it('fresh schema keeps tenant isolation but no root discovery', async () => {
      const roles = rawRows(
        await executeRaw(
          db,
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      );
      expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      expect(await policies()).toContain('tenant_isolation_completion_subscriptions');
      expect(await policies()).not.toContain('completion_callback_discovery');
      expect(await policies()).not.toContain('completion_callback_task_discovery');
    });

    it('upgrades the draft ledger without deleting rows and denies foreign tenant access', async () => {
      // Reconstruct only the withdrawn discovery policies and last ledger step in
      // this file's disposable DB. Original 0111 DDL and watermark stay unchanged.
      const original = await readFile(
        new URL(
          '../../drizzle/postgres/0111_transitive_completion_subscriptions.sql',
          import.meta.url
        ),
        'utf8'
      );
      for (const statement of original
        .slice(original.indexOf('CREATE POLICY "completion_callback_discovery"'))
        .split('--> statement-breakpoint')) {
        await executeRaw(db, sql.raw(statement));
      }
      await executeRaw(
        db,
        sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT MAX(created_at) FROM drizzle.__drizzle_migrations)`
      );
      await runWithTenantDatabaseScope(db, 'fixture-a', async (scoped) => {
        await executeRaw(
          scoped,
          sql`INSERT INTO completion_subscriptions
          (tenant_id, subscription_id, requested_by_user_id, origin_session_id, origin_task_id, path, created_at, updated_at)
          VALUES ('fixture-a', 'retained', 'fixture-user', 'fixture-session', 'fixture-task', '[]', now(), now())`
        );
      });
      await initializeDatabase(db);
      expect(await policies()).not.toContain('completion_callback_discovery');
      expect(await policies()).not.toContain('completion_callback_task_discovery');
      await runWithTenantDatabaseScope(db, 'fixture-b', async (scoped) => {
        expect(
          rawRows(
            await executeRaw(
              scoped,
              sql`SELECT * FROM completion_subscriptions WHERE subscription_id = 'retained'`
            )
          )
        ).toEqual([]);
        expect(
          rawRows(
            await executeRaw(
              scoped,
              sql`UPDATE completion_subscriptions SET state = 'delivered' WHERE subscription_id = 'retained' RETURNING subscription_id`
            )
          )
        ).toEqual([]);
        // Even explicitly naming the retired capability grants no foreign reads.
        await executeRaw(
          scoped,
          sql`SELECT set_config('agor.system_scope', 'completion_callback_discovery', true)`
        );
        expect(
          rawRows(
            await executeRaw(
              scoped,
              sql`SELECT * FROM completion_subscriptions WHERE subscription_id = 'retained'`
            )
          )
        ).toEqual([]);
      });
      await runWithTenantDatabaseScope(db, 'fixture-a', async (scoped) => {
        expect(
          rawRows(
            await executeRaw(
              scoped,
              sql`SELECT state, path FROM completion_subscriptions WHERE subscription_id = 'retained'`
            )
          )
        ).toEqual([{ state: 'pending', path: [] }]);
      });
    });
  }
);
