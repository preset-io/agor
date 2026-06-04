/**
 * Shared SQL predicates for branch RBAC list scoping.
 *
 * Repository find/list paths for branches, sessions, schedules, and boards
 * must stay in lock-step with the central per-branch evaluator:
 *
 *   direct owner → highest non-none group grant → others_can fallback
 *
 * These helpers assume the caller has already joined:
 * - branch_owners scoped to the current user
 * - group_memberships scoped to the current user
 * - branch_group_grants scoped to matching branch + group membership
 */

import { BRANCH_PERMISSION_LEVELS } from '@agor/core/types';
import { and, inArray, isNotNull, ne, or } from 'drizzle-orm';
import { branches, branchGroupGrants, branchOwners } from '../schema';

export const VISIBLE_BRANCH_PERMISSION_LEVELS = BRANCH_PERMISSION_LEVELS.filter(
  (level) => level !== 'none'
);

/**
 * Branch is visible when the joined user is:
 * - a direct owner, OR
 * - in a group with an explicit non-none grant, OR
 * - covered by a public/fallback others_can level of view+
 */
export function visibleBranchAccessCondition() {
  return or(
    isNotNull(branchOwners.user_id),
    and(isNotNull(branchGroupGrants.group_id), ne(branchGroupGrants.can, 'none')),
    inArray(branches.others_can, VISIBLE_BRANCH_PERMISSION_LEVELS)
  );
}
