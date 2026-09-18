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
  await initializeDatabase(db);
  expect(
    rawRows(
      await executeRaw(db, sql`SELECT subscription_id, state, path FROM completion_subscriptions`)
    )
  ).toEqual([{ subscription_id: 'fixture-retained', state: 'pending', path: '[]' }]);
});
