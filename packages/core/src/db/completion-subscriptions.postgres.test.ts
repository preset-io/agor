import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { executeRaw, rawRows } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { UsersRepository } from './repositories/users';
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

    it('adds tenant-isolated storage after current main migrations', async () => {
      await executeRaw(db, sql`DROP TABLE completion_subscriptions`);
      await executeRaw(
        db,
        sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1790129000216`
      );
      await initializeDatabase(db);
      expect(await policies()).toContain('tenant_isolation_completion_subscriptions');
      expect(await policies()).not.toContain('completion_callback_discovery');
      expect(await policies()).not.toContain('completion_callback_task_discovery');
    });

    for (const watermark of [1789344000006, 1789344000007]) {
      it(`restores tenant-isolated KB receipts skipped by draft watermark ${watermark}`, async () => {
        await executeRaw(db, sql`DROP TABLE kb_import_receipts`);
        await executeRaw(db, sql`ALTER TABLE messages DROP COLUMN mcp_slack_connect_due_at`);
        await executeRaw(db, sql`ALTER TABLE user_api_keys DROP COLUMN source`);
        await executeRaw(
          db,
          sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at > 1789344000005`
        );
        await executeRaw(
          db,
          sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('draft', ${watermark})`
        );
        await initializeDatabase(db);
        await runWithTenantDatabaseScope(db, 'fixture-a', async (scoped) => {
          const owner = await new UsersRepository(scoped).create({
            email: `receipt-${watermark}@example.invalid`,
          });
          await executeRaw(
            scoped,
            sql`INSERT INTO kb_import_receipts
            (tenant_id, receipt_id, owner_user_id, bundle, slug, entry_key, target_id, digest, created_at)
            VALUES ('fixture-a', 'retained-receipt', ${owner.user_id}, 'bundle', 'slug', 'entry', 'target', 'digest', now())`
          );
        });
        // Replaying reconciliation must preserve main's existing receipt rows.
        await executeRaw(
          db,
          sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1790129000216`
        );
        await initializeDatabase(db);
        await runWithTenantDatabaseScope(db, 'fixture-b', async (scoped) => {
          expect(
            rawRows(
              await executeRaw(
                scoped,
                sql`SELECT * FROM kb_import_receipts WHERE receipt_id = 'retained-receipt'`
              )
            )
          ).toEqual([]);
          expect(
            rawRows(
              await executeRaw(
                scoped,
                sql`UPDATE kb_import_receipts SET digest = 'foreign' WHERE receipt_id = 'retained-receipt' RETURNING receipt_id`
              )
            )
          ).toEqual([]);
        });
        await runWithTenantDatabaseScope(db, 'fixture-a', async (scoped) => {
          expect(
            rawRows(
              await executeRaw(
                scoped,
                sql`SELECT digest FROM kb_import_receipts WHERE receipt_id = 'retained-receipt'`
              )
            )
          ).toEqual([{ digest: 'digest' }]);
        });
      });
    }

    it('upgrades the draft ledger without deleting rows and denies foreign tenant access', async () => {
      // Reconstruct only the withdrawn discovery policies and last ledger step in
      // this file's disposable DB. The original draft SQL remains a fixture.
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
      const ownershipGuards = await readFile(
        new URL(
          '../../drizzle/postgres/0095_board_branch_capability_policies.sql',
          import.meta.url
        ),
        'utf8'
      );
      for (const statement of ownershipGuards
        .split('--> statement-breakpoint')
        .filter((statement) =>
          /^\s*CREATE (?:FUNCTION agor_reject_primary_owner_change\(|TRIGGER (?:boards|branches)_primary_owner_immutable\b)/.test(
            statement
          )
        )) {
        await executeRaw(db, sql.raw(statement));
      }
      // Also cover the retired draft's later watermark; reconciliation must
      // remain pending beyond both conflicting histories.
      await executeRaw(
        db,
        sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('draft-retirement', 1789344000006)`
      );
      await initializeDatabase(db);
      expect(await policies()).not.toContain('completion_callback_discovery');
      expect(await policies()).not.toContain('completion_callback_task_discovery');
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT tgname FROM pg_trigger WHERE tgname IN ('boards_primary_owner_immutable', 'branches_primary_owner_immutable')`
          )
        )
      ).toEqual([]);
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
