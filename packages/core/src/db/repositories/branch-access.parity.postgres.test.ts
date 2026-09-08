import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import {
  BOARD_POLICY_CAPABILITIES,
  BRANCH_POLICY_CAPABILITIES,
} from '../../types/capability-policy';
import { createDatabase, type Database } from '../client';
import { select } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { boards, branches } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { boardCapabilityCondition, branchCapabilityCondition } from './branch-access';
import { exerciseCapabilityPredicateParity } from './branch-access.parity-test-helpers';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'capability predicate parity (PostgreSQL/RLS)',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });
    it('matches point checks and cannot authorize foreign board/branch IDs, even with their owner ID', async () => {
      const foreign = await runWithTenantDatabaseScope(
        db,
        `foreign-${generateId()}`,
        exerciseCapabilityPredicateParity
      );
      await runWithTenantDatabaseScope(db, `local-${generateId()}`, async (scoped) => {
        const local = await exerciseCapabilityPredicateParity(scoped);
        for (const userId of [local.owner, local.member, local.admin, foreign.owner]) {
          for (const capability of BOARD_POLICY_CAPABILITIES) {
            expect(
              await select(scoped)
                .from(boards)
                .where(
                  and(
                    eq(boards.board_id, foreign.boardId),
                    boardCapabilityCondition(scoped, userId, capability)
                  )
                )
                .all()
            ).toEqual([]);
          }
          for (const capability of BRANCH_POLICY_CAPABILITIES) {
            expect(
              await select(scoped)
                .from(branches)
                .where(
                  and(
                    eq(branches.branch_id, foreign.branchId),
                    branchCapabilityCondition(scoped, userId, capability)
                  )
                )
                .all()
            ).toEqual([]);
          }
        }
      });
    }, 60000);
  }
);
