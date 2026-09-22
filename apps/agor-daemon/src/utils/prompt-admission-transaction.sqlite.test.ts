import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  enqueueAfterTenantDatabaseCommit,
  executeRaw,
  rawRows,
  sql,
} from '@agor/core/db';
import { expect, it } from 'vitest';
import { runPromptAdmissionTransaction } from './prompt-admission-transaction.js';

it('retains native SQLite commit/rollback and never retries PostgreSQL-shaped errors', async () => {
  const raw = createDatabase({ dialect: 'sqlite', url: ':memory:' });
  const db = createTenantScopedDatabaseProxy(raw);
  try {
    await executeRaw(raw, sql`CREATE TABLE admission_fixture (id TEXT PRIMARY KEY)`);
    let effects = 0;
    await runPromptAdmissionTransaction(db, 'sqlite-tenant', async (tx) => {
      await executeRaw(tx, sql`INSERT INTO admission_fixture VALUES ('committed')`);
      enqueueAfterTenantDatabaseCommit(() => {
        effects++;
      });
    });
    let attempts = 0;
    const original = Object.assign(new Error('fixture error'), { code: '40001' });
    await expect(
      runPromptAdmissionTransaction(db, 'sqlite-tenant', async (tx) => {
        attempts++;
        await executeRaw(tx, sql`INSERT INTO admission_fixture VALUES ('rolled-back')`);
        enqueueAfterTenantDatabaseCommit(() => {
          effects++;
        });
        throw original;
      })
    ).rejects.toBe(original);
    expect(attempts).toBe(1);
    expect(effects).toBe(1);
    expect(rawRows(await executeRaw(raw, sql`SELECT id FROM admission_fixture`))).toEqual([
      { id: 'committed' },
    ]);
  } finally {
    (raw as typeof raw & { $client: { close(): void } }).$client.close();
  }
});
