/**
 * Shared SQL predicates for branch RBAC list scoping.
 *
 * Repository find/list paths for branches, sessions, schedules, and boards
 * must stay in lock-step with the central per-branch evaluator:
 *
 *   direct owner → highest non-none group grant → others_can fallback
 *
 * The owner check still relies on the caller joining branch_owners scoped to
 * the current user. Group access is intentionally modeled as an EXISTS
 * predicate so public/fallback-visible branches do not multiply by every group
 * membership a user has.
 */

import { BRANCH_PERMISSION_LEVELS, type UUID } from '@agor/core/types';
import { and, eq, exists, inArray, isNotNull, or, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { branches, branchGroupGrants, branchOwners, groupMemberships, groups } from '../schema';

export const VISIBLE_BRANCH_PERMISSION_LEVELS = BRANCH_PERMISSION_LEVELS.filter(
  (level) => level !== 'none'
);

/**
 * True when the user is in any active (non-archived) group with an explicit
 * non-none grant on the correlated branch.
 */
export function activeGroupGrantAccessExists(db: Database, userId: UUID) {
  return exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
    (db as any)
      .select({ _: sql`1` })
      .from(branchGroupGrants)
      .innerJoin(
        groupMemberships,
        and(
          eq(groupMemberships.group_id, branchGroupGrants.group_id),
          eq(groupMemberships.user_id, userId)
        )
      )
      .innerJoin(
        groups,
        and(eq(groups.group_id, branchGroupGrants.group_id), eq(groups.archived, false))
      )
      .where(
        and(
          eq(branchGroupGrants.branch_id, branches.branch_id),
          inArray(branchGroupGrants.can, VISIBLE_BRANCH_PERMISSION_LEVELS)
        )
      )
  );
}

/**
 * Branch is visible when the joined/correlated user is:
 * - a direct owner, OR
 * - in a group with an explicit non-none grant, OR
 * - covered by a public/fallback others_can level of view+
 */
export function visibleBranchAccessCondition(groupGrantAccessCondition: SQL) {
  return or(
    isNotNull(branchOwners.user_id),
    groupGrantAccessCondition,
    inArray(branches.others_can, VISIBLE_BRANCH_PERMISSION_LEVELS)
  );
}
