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
  messages,
  sessions,
  tasks,
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

/**
 * Board visibility predicate correlated against the `boards` table in scope.
 *
 * A board is visible if the user owns it, is an explicit board owner, the board
 * is shared, or at least one of its branches / primary assistant branch is
 * visible through the branch RBAC predicate. All branch-derived checks are
 * EXISTS-based so the outer row is never multiplied and no DISTINCT is needed.
 */
export function visibleBoardAccessCondition(db: Database, userId: UUID): SQL {
  const accessibleBranchExists = exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
    (db as any)
      .select({ _: sql`1` })
      .from(branches)
      .leftJoin(
        branchOwners,
        and(eq(branchOwners.branch_id, branches.branch_id), eq(branchOwners.user_id, userId))
      )
      .where(and(eq(branches.board_id, boards.board_id), visibleBranchAccessCondition(db, userId)))
  );
  const accessiblePrimaryAssistantExists = exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
    (db as any)
      .select({ _: sql`1` })
      .from(branches)
      .leftJoin(
        branchOwners,
        and(eq(branchOwners.branch_id, branches.branch_id), eq(branchOwners.user_id, userId))
      )
      .where(
        and(
          eq(branches.branch_id, boards.primary_assistant_id),
          visibleBranchAccessCondition(db, userId)
        )
      )
  );

  return (
    or(
      eq(boards.created_by, userId),
      exists(
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
        (db as any)
          .select({ _: sql`1` })
          .from(boardOwners)
          .where(and(eq(boardOwners.board_id, boards.board_id), eq(boardOwners.user_id, userId)))
      ),
      eq(sql`coalesce(${jsonExtract(db, boards.data, 'access_mode')}, 'shared')`, 'shared'),
      accessibleBranchExists,
      accessiblePrimaryAssistantExists
    ) ?? sql`false`
  );
}

/** Correlated board-visibility predicate for tables that carry a board_id. */
export function visibleBoardReferenceAccessExists(
  db: Database,
  userId: UUID,
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's eq accepts columns/SQL wrappers across dialects
  boardId: any
): SQL {
  return exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
    (db as any)
      .select({ _: sql`1` })
      .from(boards)
      .where(and(eq(boards.board_id, boardId), visibleBoardAccessCondition(db, userId)))
  );
}

/**
 * Correlated branch-visibility predicate for tables that carry a branch_id.
 *
 * This is the SQL-pushdown equivalent of resolving all accessible branch ids
 * first and applying `branch_id IN (...)`, but it avoids hydrating branch rows
 * and avoids very large parameter lists. The `branchId` expression is normally
 * a column from the outer query (for example `artifacts.branch_id`).
 */
export function visibleBranchReferenceAccessExists(
  db: Database,
  userId: UUID,
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's eq accepts columns/SQL wrappers across dialects
  branchId: any
): SQL {
  return exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
    (db as any)
      .select({ _: sql`1` })
      .from(branches)
      .leftJoin(
        branchOwners,
        and(eq(branchOwners.branch_id, branches.branch_id), eq(branchOwners.user_id, userId))
      )
      .where(and(eq(branches.branch_id, branchId), visibleBranchAccessCondition(db, userId)))
  );
}

/**
 * Correlated visibility predicate for tables that carry a session_id.
 *
 * The referenced session is visible when its branch is visible to the user.
 * This avoids resolving all accessible sessions into `session_id IN (...)` and
 * works for high-cardinality child tables such as messages and tasks.
 */
export function visibleSessionReferenceAccessExists(
  db: Database,
  userId: UUID,
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's eq accepts columns/SQL wrappers across dialects
  sessionId: any
): SQL {
  return exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
    (db as any)
      .select({ _: sql`1` })
      .from(sessions)
      .innerJoin(branches, eq(sessions.branch_id, branches.branch_id))
      .leftJoin(
        branchOwners,
        and(eq(branchOwners.branch_id, branches.branch_id), eq(branchOwners.user_id, userId))
      )
      .where(and(eq(sessions.session_id, sessionId), visibleBranchAccessCondition(db, userId)))
  );
}

/** Correlated visibility predicate for tables that carry a task_id. */
export function visibleTaskReferenceAccessExists(
  db: Database,
  userId: UUID,
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's eq accepts columns/SQL wrappers across dialects
  taskId: any
): SQL {
  return exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
    (db as any)
      .select({ _: sql`1` })
      .from(tasks)
      .where(
        and(
          eq(tasks.task_id, taskId),
          visibleSessionReferenceAccessExists(db, userId, tasks.session_id)
        )
      )
  );
}

/** Correlated visibility predicate for tables that carry a message_id. */
export function visibleMessageReferenceAccessExists(
  db: Database,
  userId: UUID,
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's eq accepts columns/SQL wrappers across dialects
  messageId: any
): SQL {
  return exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
    (db as any)
      .select({ _: sql`1` })
      .from(messages)
      .where(
        and(
          eq(messages.message_id, messageId),
          visibleSessionReferenceAccessExists(db, userId, messages.session_id)
        )
      )
  );
}
