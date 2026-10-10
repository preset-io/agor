/**
 * PostgreSQL proof for the same assertions as the SQLite sibling.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/prompt-provenance-persistence.postgres.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { assertStampedPromptRoundTrips } from './prompt-provenance-persistence.test-support';
import { BranchRepository, TaskRepository } from './repositories';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'stamped prompt persistence (PostgreSQL)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    });

    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('round-trips the rendered block and the graded stamp', async () => {
      await assertStampedPromptRoundTrips(db, `prompt-provenance-pg-${generateId()}`);
    });

    /**
     * The stamped Task derives its tenant from its Session, and the admission
     * route resolves origin branch/teammate names with the same tenant-scoped
     * `BranchRepository.findById` used here. Another tenant must see neither,
     * so a stamp can never surface a foreign tenant's branch name.
     */
    it('keeps the stamped Task and its origin branch invisible to another tenant', async () => {
      const { taskId, originBranchId } = await assertStampedPromptRoundTrips(
        db,
        `prompt-provenance-pg-a-${generateId()}`
      );
      const otherTenant = `prompt-provenance-pg-b-${generateId()}`;

      const [task, branch] = await runWithTenantDatabaseScope(db, otherTenant, async (scoped) => [
        await new TaskRepository(scoped).findById(taskId),
        await new BranchRepository(scoped).findById(originBranchId),
      ]);
      expect(task).toBeNull();
      expect(branch).toBeNull();
    });
  }
);
