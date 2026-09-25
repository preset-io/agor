import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { executeRaw, rawRows } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { dbTest } from './test-helpers';

dbTest('retains inert draft completion rows across SQLite initialization', async ({ db }) => {
  await executeRaw(
    db,
    sql`INSERT INTO completion_subscriptions
    (subscription_id, requested_by_user_id, origin_session_id, origin_task_id, path, created_at, updated_at)
    VALUES ('fixture-retained', 'fixture-user', 'fixture-session', 'fixture-task', '[]', 1, 1)`
  );
  await executeRaw(db, sql`DROP TABLE kb_import_receipts`);
  await executeRaw(db, sql`DROP INDEX messages_mcp_slack_connect_due_idx`);
  await executeRaw(db, sql`ALTER TABLE messages DROP COLUMN mcp_slack_connect_due_at`);
  await executeRaw(db, sql`ALTER TABLE user_api_keys DROP COLUMN source`);
  // The draft had the same timestamp as main's ownership-transfer migration.
  await executeRaw(db, sql`DELETE FROM __drizzle_migrations WHERE created_at > 1789344000005`);
  await executeRaw(
    db,
    sql`CREATE TRIGGER boards_primary_owner_immutable BEFORE UPDATE OF primary_owner_user_id ON boards BEGIN SELECT RAISE(ABORT, 'immutable'); END`
  );
  await executeRaw(
    db,
    sql`CREATE TRIGGER branches_primary_owner_immutable BEFORE UPDATE OF primary_owner_user_id ON branches BEGIN SELECT RAISE(ABORT, 'immutable'); END`
  );
  await initializeDatabase(db);
  expect(
    rawRows(
      await executeRaw(
        db,
        sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('boards_primary_owner_immutable', 'branches_primary_owner_immutable')`
      )
    )
  ).toEqual([]);
  expect(
    rawRows(
      await executeRaw(db, sql`SELECT subscription_id, state, path FROM completion_subscriptions`)
    )
  ).toEqual([{ subscription_id: 'fixture-retained', state: 'pending', path: '[]' }]);
});

dbTest('adds inert completion storage after current main migrations', async ({ db }) => {
  await executeRaw(db, sql`DROP TABLE completion_subscriptions`);
  await executeRaw(db, sql`DELETE FROM __drizzle_migrations WHERE created_at = 1790129000216`);
  await initializeDatabase(db);
  expect(rawRows(await executeRaw(db, sql`SELECT * FROM completion_subscriptions`))).toEqual([]);
});

for (const watermark of [1789344000006, 1789344000007]) {
  dbTest(`restores KB receipts skipped by draft watermark ${watermark}`, async ({ db }) => {
    await executeRaw(db, sql`DROP TABLE kb_import_receipts`);
    await executeRaw(db, sql`DROP INDEX messages_mcp_slack_connect_due_idx`);
    await executeRaw(db, sql`ALTER TABLE messages DROP COLUMN mcp_slack_connect_due_at`);
    await executeRaw(db, sql`ALTER TABLE user_api_keys DROP COLUMN source`);
    await executeRaw(db, sql`DELETE FROM __drizzle_migrations WHERE created_at > 1789344000005`);
    await executeRaw(
      db,
      sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('draft', ${watermark})`
    );
    await initializeDatabase(db);
    expect(rawRows(await executeRaw(db, sql`SELECT * FROM kb_import_receipts`))).toEqual([]);
    expect(rawRows(await executeRaw(db, sql`PRAGMA foreign_key_check`))).toEqual([]);
  });
}
