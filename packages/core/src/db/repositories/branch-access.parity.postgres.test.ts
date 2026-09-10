import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import {
  BOARD_POLICY_CAPABILITIES,
  BRANCH_POLICY_CAPABILITIES,
} from '../../types/capability-policy';
import { createDatabase, type Database } from '../client';
import { executeRaw, select } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { boards, branches } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { boardCapabilityCondition, branchCapabilityCondition } from './branch-access';
import { exerciseCapabilityPredicateParity } from './branch-access.parity-test-helpers';
import { GroupRepository } from './groups';

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
        // The parity exercise ends by removing memberships. Restore its two
        // populated groups so this plan exercises real grants on both branches.
        const groups = new GroupRepository(scoped);
        for (const groupId of local.groupIds) {
          await groups.addMember(groupId, local.member, local.owner);
        }
        // Each matching-set InitPlan runs at most once, once when needed.
        // Short-circuited policy arms can leave their sets unused; internal
        // join nodes may legitimately execute more than once within a set.
        const plans = await executeRaw(
          scoped,
          sql`EXPLAIN (ANALYZE, FORMAT JSON)
            SELECT ${branches.branch_id} FROM ${branches}
            WHERE ${branchCapabilityCondition(scoped, local.member, 'branch.view')}`
        );
        const containsGroupMembership = (value: unknown): boolean => {
          if (!value || typeof value !== 'object') return false;
          const node = value as Record<string, unknown>;
          return (
            node['Relation Name'] === 'group_memberships' ||
            Object.values(node).some(containsGroupMembership)
          );
        };
        const matchingSets: Record<string, unknown>[] = [];
        const visit = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          const node = value as Record<string, unknown>;
          if (node['Parent Relationship'] === 'InitPlan' && containsGroupMembership(node)) {
            matchingSets.push(node);
          }
          for (const child of Object.values(node)) visit(child);
        };
        visit(plans);
        expect(matchingSets.length).toBeGreaterThan(0);
        expect(
          matchingSets.some((node) => node['Actual Loops'] === 1 && Number(node['Actual Rows']) > 0)
        ).toBe(true);
        for (const node of matchingSets) expect([0, 1]).toContain(node['Actual Loops']);
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
