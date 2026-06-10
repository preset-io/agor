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
import { jsonExtract } from '../database-wrapper';
import {
  boardGroupGrants,
  boardOwners,
  boards,
  branches,
  branchGroupGrants,
  branchOwners,
  groupMemberships,
  groups,
} from '../schema';

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

export function activeBoardGroupGrantAccessExists(db: Database, userId: UUID) {
  return exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
    (db as any)
      .select({ _: sql`1` })
      .from(boardGroupGrants)
      .innerJoin(
        groupMemberships,
        and(
          eq(groupMemberships.group_id, boardGroupGrants.group_id),
          eq(groupMemberships.user_id, userId)
        )
      )
      .innerJoin(
        groups,
        and(eq(groups.group_id, boardGroupGrants.group_id), eq(groups.archived, false))
      )
      .innerJoin(
        boards,
        and(
          eq(boards.board_id, boardGroupGrants.board_id),
          eq(sql`coalesce(${jsonExtract(db, boards.data, 'access_mode')}, 'shared')`, 'shared')
        )
      )
      .where(
        and(
          eq(boardGroupGrants.board_id, branches.board_id),
          inArray(boardGroupGrants.can, VISIBLE_BRANCH_PERMISSION_LEVELS)
        )
      )
  );
}

export function activeBoardOwnerAccessExists(db: Database, userId: UUID) {
  return exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
    (db as any)
      .select({ _: sql`1` })
      .from(boardOwners)
      .where(and(eq(boardOwners.board_id, branches.board_id), eq(boardOwners.user_id, userId)))
  );
}

export function alignedBoardDefaultVisible(db: Database) {
  return exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
    (db as any)
      .select({ _: sql`1` })
      .from(boards)
      .where(
        and(
          eq(boards.board_id, branches.board_id),
          eq(sql`coalesce(${jsonExtract(db, boards.data, 'access_mode')}, 'shared')`, 'shared'),
          inArray(
            sql`coalesce(${jsonExtract(db, boards.data, 'default_others_can')}, 'session')`,
            VISIBLE_BRANCH_PERMISSION_LEVELS
          )
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
export function visibleBranchAccessCondition(db: Database, userId: UUID): SQL {
  return (
    or(
      isNotNull(branchOwners.user_id),
      activeGroupGrantAccessExists(db, userId),
      and(eq(branches.permission_source, 'board'), activeBoardOwnerAccessExists(db, userId)),
      and(eq(branches.permission_source, 'board'), activeBoardGroupGrantAccessExists(db, userId)),
      and(eq(branches.permission_source, 'board'), alignedBoardDefaultVisible(db)),
      and(
        eq(branches.permission_source, 'override'),
        inArray(branches.others_can, VISIBLE_BRANCH_PERMISSION_LEVELS)
      )
    ) ?? sql`false`
  );
}
