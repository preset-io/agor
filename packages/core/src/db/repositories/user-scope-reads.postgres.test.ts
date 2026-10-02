import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { SessionRepository } from './sessions';
import { exerciseUserScopeReads } from './user-scope-reads.test-helpers';

const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'user-scope reads (isolated PostgreSQL/RLS)',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    });

    it('composes with visibility and never crosses tenants', async () => {
      const foreign = await runWithTenantDatabaseScope(
        db,
        `user-scope-b-${generateId()}`,
        exerciseUserScopeReads
      );
      await runWithTenantDatabaseScope(db, `user-scope-a-${generateId()}`, async (scoped) => {
        const local = await exerciseUserScopeReads(scoped);
        const branches = new BranchRepository(scoped);
        const sessions = new SessionRepository(scoped);
        for (const visibleToUserId of [undefined, local.owner, local.viewer]) {
          expect(
            (await branches.findPage({ visibleToUserId, branchIds: foreign.branchIds })).data
          ).toEqual([]);
          expect(
            (await branches.findPage({ visibleToUserId, createdBy: foreign.owner })).data
          ).toEqual([]);
          expect(
            await sessions.findPage({ visibleToUserId, sessionIds: foreign.sessionIds, limit: 10 })
          ).toEqual({ data: [], total: 0 });
          const counted = (await branches.countActiveByBoard({ visibleToUserId })).map(
            (row) => row.board_id
          );
          for (const boardId of foreign.boardIds) expect(counted).not.toContain(boardId);
          const mates = (
            await branches.findTeammateBranches({ userId: visibleToUserId, limit: 1000 })
          ).map((b) => b.branch_id);
          for (const branchId of foreign.branchIds) expect(mates).not.toContain(branchId);
        }
      });
    }, 60000);
  }
);
