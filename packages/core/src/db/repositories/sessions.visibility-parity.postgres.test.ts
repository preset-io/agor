import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import {
  exerciseSessionVisibilityParity,
  seedSessionVisibilityFixture,
} from './sessions.visibility-parity-test-helpers';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'session per-row visibility parity (PostgreSQL/RLS)',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    it('matches the branch-set form and point checks, and never resolves another tenant', async () => {
      const foreign = await runWithTenantDatabaseScope(
        db,
        `visibility-foreign-${generateId()}`,
        seedSessionVisibilityFixture
      );
      await runWithTenantDatabaseScope(db, `visibility-local-${generateId()}`, async (scoped) => {
        const local = await seedSessionVisibilityFixture(scoped);
        expect(await exerciseSessionVisibilityParity(scoped, local, foreign)).toBeGreaterThan(1000);
      });
    }, 600_000);
  }
);
