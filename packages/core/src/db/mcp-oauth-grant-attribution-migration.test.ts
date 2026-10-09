import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, it } from 'vitest';
import { createDatabase } from './client';
import { executeRaw, isSQLiteDatabase, rawRows } from './database-wrapper';
import {
  beforeAttributionMigrations,
  seedHistoricalGrants,
  stageFailingAttributionMigration,
} from './mcp-oauth-grant-attribution-migration.test-support';
import { getMigrationImpact, runMigrations } from './migrate';

it('upgrades real SQLite 0104, preserves personal grants and requires fresh shared consent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agor-attribution-sqlite-'));
  const folder = await beforeAttributionMigrations('sqlite');
  const db = createDatabase({ url: `file:${join(directory, 'test.db')}` });
  if (!isSQLiteDatabase(db)) throw new Error('Expected SQLite');
  try {
    await migrate(db, { migrationsFolder: folder });
    const fixture = await seedHistoricalGrants(db);
    await expect(runMigrations(db)).rejects.toThrow(/offline/i);
    await stageFailingAttributionMigration(folder, 'sqlite');
    await expect(migrate(db, { migrationsFolder: folder })).rejects.toThrow();
    expect(
      rawRows(await executeRaw(db, sql`SELECT user_id FROM user_mcp_oauth_tokens`))
    ).toHaveLength(2);
    await runMigrations(db, { allowOfflineCutover: true });
    const rows = rawRows(await executeRaw(db, sql`SELECT * FROM user_mcp_oauth_tokens`));
    expect(rows).toEqual([{ ...fixture.personal, granted_by_user_id: fixture.userId }]);
    expect(rawRows(await executeRaw(db, sql`PRAGMA foreign_key_check`))).toEqual([]);
    await expect(
      executeRaw(
        db,
        sql`INSERT INTO user_mcp_oauth_tokens
      (mcp_server_id, oauth_access_token, created_at)
      VALUES (${fixture.serverId}, 'unattributed', 1)`
      )
    ).rejects.toThrow();
    await runMigrations(db, { allowOfflineCutover: true });
    expect(rawRows(await executeRaw(db, sql`SELECT * FROM user_mcp_oauth_tokens`))).toEqual(rows);
    expect(getMigrationImpact('0105_mcp_oauth_grant_attribution')).toMatchObject({
      userAction: 'required',
      rollbackCompatibility: 'incompatible',
    });
  } finally {
    (db as typeof db & { $client: { close(): void } }).$client.close();
    await rm(folder, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
