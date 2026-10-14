import { describe, it } from 'vitest';
import { createDatabaseAsync } from './client';
import { initializeDatabase } from './migrate';
import { assertStampedPromptRoundTrips } from './prompt-provenance-persistence.test-support';

describe('stamped prompt persistence (SQLite)', () => {
  it('round-trips the rendered block and the graded stamp', async () => {
    const db = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    await initializeDatabase(db);
    try {
      await assertStampedPromptRoundTrips(db, 'prompt-provenance-sqlite');
    } finally {
      (db as unknown as { $client: { close(): void } }).$client.close();
    }
  });
});
