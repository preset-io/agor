import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, it } from 'vitest';
import { createDatabase } from './client';
import { isSQLiteDatabase } from './database-wrapper';
import {
  beforeKbNamespaceOthersCanMigration,
  KB_NAMESPACE_OTHERS_CAN_CASES,
  readKbNamespaceOthersCan,
  seedKbNamespaceOthersCanCases,
} from './kb-namespace-others-can-migration.test-support';
import { OfflineMigrationCutoverRequiredError, runMigrations } from './migrate';

it('stops personal, teammate and private-default namespaces granting write to everyone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agor-kb-others-can-sqlite-'));
  const folder = await beforeKbNamespaceOthersCanMigration('sqlite');
  const db = createDatabase({ url: `file:${join(directory, 'test.db')}` });
  if (!isSQLiteDatabase(db)) throw new Error('Expected SQLite');
  try {
    await migrate(db, { migrationsFolder: folder });
    const ids = await seedKbNamespaceOthersCanCases(db, 'case');
    expect(await readKbNamespaceOthersCan(db, ids)).toEqual(
      KB_NAMESPACE_OTHERS_CAN_CASES.map(([row]) => row.others_can)
    );
    // An existing database refuses this migration until every older daemon is stopped.
    await expect(runMigrations(db)).rejects.toBeInstanceOf(OfflineMigrationCutoverRequiredError);
    expect(await readKbNamespaceOthersCan(db, ids)).toEqual(
      KB_NAMESPACE_OTHERS_CAN_CASES.map(([row]) => row.others_can)
    );
    await runMigrations(db, { allowOfflineCutover: true });
    expect(await readKbNamespaceOthersCan(db, ids)).toEqual(
      KB_NAMESPACE_OTHERS_CAN_CASES.map(([, expected]) => expected)
    );
  } finally {
    (db as typeof db & { $client: { close(): void } }).$client.close();
    await rm(folder, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
