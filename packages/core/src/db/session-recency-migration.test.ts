import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, it } from 'vitest';
import { createDatabase } from './client';
import { executeRaw, isSQLiteDatabase, rawRows } from './database-wrapper';
import { runMigrations } from './migrate';
import {
  beforeSessionRecencyMigrations,
  seedHistoricalSessionRecency,
  stageFailingSessionRecencyMigration,
} from './session-recency-migration.test-support';

it('backfills SQLite recency atomically without losing children, indexes or fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agor-recency-sqlite-'));
  const folder = await beforeSessionRecencyMigrations('sqlite');
  const db = createDatabase({ url: `file:${join(directory, 'test.db')}` });
  if (!isSQLiteDatabase(db)) throw new Error('Expected SQLite');
  const rows = async () =>
    rawRows(await executeRaw(db, sql`SELECT * FROM sessions ORDER BY session_id`));
  const indexes = async () =>
    rawRows(
      await executeRaw(
        db,
        sql`SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='sessions' ORDER BY name`
      )
    );
  try {
    await migrate(db, { migrationsFolder: folder });
    const fixture = await seedHistoricalSessionRecency(db);
    const beforeIndexes = await indexes();
    const beforeForeignKeys = rawRows(await executeRaw(db, sql`PRAGMA foreign_key_list(sessions)`));
    await stageFailingSessionRecencyMigration(folder, 'sqlite');
    await expect(migrate(db, { migrationsFolder: folder })).rejects.toThrow();
    expect(await rows()).toEqual(fixture.rows);
    expect(await indexes()).toEqual(beforeIndexes);
    await runMigrations(db);
    expect(await rows()).toEqual(
      fixture.rows.map((row) => ({ ...row, updated_at: row.updated_at ?? row.created_at }))
    );
    expect(
      rawRows(
        await executeRaw(db, sql`SELECT * FROM tasks WHERE task_id = ${fixture.task.task_id}`)
      )
    ).toEqual(fixture.taskRows);
    expect(await indexes()).toEqual(beforeIndexes);
    expect(rawRows(await executeRaw(db, sql`PRAGMA foreign_key_check`))).toEqual([]);
    expect(rawRows(await executeRaw(db, sql`PRAGMA foreign_key_list(sessions)`))).toEqual(
      beforeForeignKeys
    );
    expect(
      rawRows(await executeRaw(db, sql`PRAGMA table_info(sessions)`)).find(
        (row) => row.name === 'updated_at'
      )?.notnull
    ).toBe(1);
    await expect(
      executeRaw(
        db,
        sql`UPDATE sessions SET updated_at=NULL WHERE session_id=${fixture.parent.session_id}`
      )
    ).rejects.toThrow();
    await expect(
      executeRaw(
        db,
        sql`INSERT INTO sessions(session_id,created_at,created_by,status,agentic_tool,branch_id,data)
      SELECT 'missing-recency',created_at,created_by,status,agentic_tool,branch_id,data FROM sessions LIMIT 1`
      )
    ).rejects.toThrow();
    await runMigrations(db);
    expect(await rows()).toHaveLength(2);
  } finally {
    (db as typeof db & { $client: { close(): void } }).$client.close();
    await rm(folder, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
