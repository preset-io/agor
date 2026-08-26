/** Shared SQL predicates for normalized board/branch capability policies. */

import type { UUID } from '@agor/core/types';
import { and, eq, exists, inArray, or, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { Database } from '../client';
import {
  boardAccessEntries,
  boardAccessPolicies,
  boards,
  branches,
  branchPermissionConfigs,
  branchPermissionEntries,
  groupMemberships,
  groups,
  messages,
  sessions,
  tasks,
} from '../schema';

type UserIdExpression = UUID | SQLWrapper;

const BOARD_ROLES_BY_CAPABILITY = {
  'board.view': ['viewer', 'editor', 'manager'],
  'board.edit': ['editor', 'manager'],
  'board.attach_branch': ['editor', 'manager'],
  'board.policy.manage': ['manager'],
} as const;

const BRANCH_ROLES_BY_CAPABILITY = {
  'branch.view': ['viewer', 'collaborator', 'manager'],
  'sessions.create': ['collaborator', 'manager'],
  'sessions.prompt_own': ['collaborator', 'manager'],
  'sessions.manage_others': ['manager'],
  'branch.manage': ['manager'],
  'environment.control': ['manager'],
  'terminal.open': ['collaborator', 'manager'],
  'branch.policy.manage': ['manager'],
} as const;

function roleGrantsCapability(
  column: SQLWrapper,
  kind: 'board' | 'branch',
  capability: string
): SQL {
  const roles =
    kind === 'board'
      ? BOARD_ROLES_BY_CAPABILITY[capability as keyof typeof BOARD_ROLES_BY_CAPABILITY]
      : BRANCH_ROLES_BY_CAPABILITY[capability as keyof typeof BRANCH_ROLES_BY_CAPABILITY];
  if (!roles) return sql`false`;
  return inArray(column, [...roles]);
}

function branchRoleGrantsCapability(
  roleColumn: SQLWrapper,
  fsAccessColumn: SQLWrapper,
  capability: string
): SQL {
  const roleCondition = roleGrantsCapability(roleColumn, 'branch', capability);
  return capability === 'terminal.open'
    ? (and(roleCondition, inArray(fsAccessColumn, ['read', 'write'])) ?? sql`false`)
    : roleCondition;
}

function effectiveConfigCondition(): SQL {
  return (
    or(
      and(
        eq(branches.permission_binding, 'override'),
        eq(branchPermissionConfigs.branch_id, branches.branch_id)
      ),
      and(
        eq(branches.permission_binding, 'inherit'),
        eq(branchPermissionConfigs.board_id, branches.board_id)
      )
    ) ?? sql`false`
  );
}

function directBranchEntryExists(db: Database, userId: UserIdExpression, capability?: string): SQL {
  return exists(
    selectRaw(db)
      .from(branchPermissionConfigs)
      .innerJoin(
        branchPermissionEntries,
        eq(branchPermissionEntries.config_id, branchPermissionConfigs.config_id)
      )
      .where(
        and(
          effectiveConfigCondition(),
          eq(branchPermissionConfigs.sharing_mode, 'shared'),
          eq(branchPermissionEntries.user_id, userId),
          ...(capability
            ? [
                branchRoleGrantsCapability(
                  branchPermissionEntries.role,
                  branchPermissionEntries.fs_access,
                  capability
                ),
              ]
            : [])
        )
      )
  );
}

function activeBranchGroupEntryExists(
  db: Database,
  userId: UserIdExpression,
  capability?: string
): SQL {
  return exists(
    selectRaw(db)
      .from(branchPermissionConfigs)
      .innerJoin(
        branchPermissionEntries,
        eq(branchPermissionEntries.config_id, branchPermissionConfigs.config_id)
      )
      .innerJoin(
        groupMemberships,
        and(
          eq(groupMemberships.group_id, branchPermissionEntries.group_id),
          eq(groupMemberships.user_id, userId)
        )
      )
      .innerJoin(
        groups,
        and(eq(groups.group_id, branchPermissionEntries.group_id), eq(groups.archived, false))
      )
      .where(
        and(
          effectiveConfigCondition(),
          eq(branchPermissionConfigs.sharing_mode, 'shared'),
          ...(capability
            ? [
                branchRoleGrantsCapability(
                  branchPermissionEntries.role,
                  branchPermissionEntries.fs_access,
                  capability
                ),
              ]
            : [])
        )
      )
  );
}

function branchOthersHasCapability(db: Database, capability: string): SQL {
  return exists(
    selectRaw(db)
      .from(branchPermissionConfigs)
      .where(
        and(
          effectiveConfigCondition(),
          eq(branchPermissionConfigs.sharing_mode, 'shared'),
          branchRoleGrantsCapability(
            branchPermissionConfigs.others_role,
            branchPermissionConfigs.others_fs_access,
            capability
          )
        )
      )
  );
}

// Drizzle's cross-dialect select overload is intentionally contained here.
// biome-ignore lint/suspicious/noExplicitAny: SQLite/PostgreSQL query builders have incompatible generic overloads.
function selectRaw(db: Database): any {
  // biome-ignore lint/suspicious/noExplicitAny: See the cross-dialect boundary above.
  return (db as any).select({ _: sql`1` });
}

function branchCapabilityCondition(
  db: Database,
  userId: UserIdExpression,
  capability: string
): SQL {
  const directMatch = directBranchEntryExists(db, userId);
  const groupMatch = activeBranchGroupEntryExists(db, userId);
  return (
    or(
      eq(branches.primary_owner_user_id, userId),
      directBranchEntryExists(db, userId, capability),
      and(sql`NOT ${directMatch}`, activeBranchGroupEntryExists(db, userId, capability)),
      and(
        sql`NOT ${directMatch}`,
        sql`NOT ${groupMatch}`,
        branchOthersHasCapability(db, capability)
      )
    ) ?? sql`false`
  );
}

export function visibleBranchAccessCondition(db: Database, userId: UserIdExpression): SQL {
  return branchCapabilityCondition(db, userId, 'branch.view');
}

export function sessionBranchAccessCondition(db: Database, userId: UserIdExpression): SQL {
  return branchCapabilityCondition(db, userId, 'sessions.create');
}

export function minimumBranchAccessCondition(
  db: Database,
  userId: UserIdExpression,
  minimumPermission: 'none' | 'view' | 'session' | 'prompt' | 'all'
): SQL {
  if (minimumPermission === 'none') return sql`true`;
  const capability =
    minimumPermission === 'view'
      ? 'branch.view'
      : minimumPermission === 'all'
        ? 'branch.manage'
        : 'sessions.create';
  return branchCapabilityCondition(db, userId, capability);
}

function directBoardEntryExists(db: Database, userId: UserIdExpression, capability?: string): SQL {
  return exists(
    selectRaw(db)
      .from(boardAccessEntries)
      .innerJoin(boardAccessPolicies, eq(boardAccessPolicies.board_id, boardAccessEntries.board_id))
      .where(
        and(
          eq(boardAccessEntries.board_id, boards.board_id),
          eq(boardAccessPolicies.sharing_mode, 'shared'),
          eq(boardAccessEntries.user_id, userId),
          ...(capability
            ? [roleGrantsCapability(boardAccessEntries.role, 'board', capability)]
            : [])
        )
      )
  );
}

function activeBoardGroupEntryExists(
  db: Database,
  userId: UserIdExpression,
  capability?: string
): SQL {
  return exists(
    selectRaw(db)
      .from(boardAccessEntries)
      .innerJoin(boardAccessPolicies, eq(boardAccessPolicies.board_id, boardAccessEntries.board_id))
      .innerJoin(
        groupMemberships,
        and(
          eq(groupMemberships.group_id, boardAccessEntries.group_id),
          eq(groupMemberships.user_id, userId)
        )
      )
      .innerJoin(
        groups,
        and(eq(groups.group_id, boardAccessEntries.group_id), eq(groups.archived, false))
      )
      .where(
        and(
          eq(boardAccessEntries.board_id, boards.board_id),
          eq(boardAccessPolicies.sharing_mode, 'shared'),
          ...(capability
            ? [roleGrantsCapability(boardAccessEntries.role, 'board', capability)]
            : [])
        )
      )
  );
}

export function visibleBoardAccessCondition(db: Database, userId: UserIdExpression): SQL {
  const directMatch = directBoardEntryExists(db, userId);
  const groupMatch = activeBoardGroupEntryExists(db, userId);
  return (
    or(
      eq(boards.primary_owner_user_id, userId),
      directBoardEntryExists(db, userId, 'board.view'),
      and(sql`NOT ${directMatch}`, activeBoardGroupEntryExists(db, userId, 'board.view')),
      and(
        sql`NOT ${directMatch}`,
        sql`NOT ${groupMatch}`,
        exists(
          selectRaw(db)
            .from(boardAccessPolicies)
            .where(
              and(
                eq(boardAccessPolicies.board_id, boards.board_id),
                eq(boardAccessPolicies.sharing_mode, 'shared'),
                roleGrantsCapability(boardAccessPolicies.others_role, 'board', 'board.view')
              )
            )
        )
      )
    ) ?? sql`false`
  );
}

export function visibleBoardReferenceAccessExists(
  db: Database,
  userId: UserIdExpression,
  boardId: SQLWrapper
): SQL {
  return exists(
    selectRaw(db)
      .from(boards)
      .where(and(eq(boards.board_id, boardId), visibleBoardAccessCondition(db, userId)))
  );
}

export function visibleBranchReferenceAccessExists(
  db: Database,
  userId: UserIdExpression,
  branchId: SQLWrapper
): SQL {
  return exists(
    selectRaw(db)
      .from(branches)
      .where(and(eq(branches.branch_id, branchId), visibleBranchAccessCondition(db, userId)))
  );
}

export function visibleSessionReferenceAccessExists(
  db: Database,
  userId: UserIdExpression,
  sessionId: SQLWrapper
): SQL {
  return exists(
    selectRaw(db)
      .from(sessions)
      .innerJoin(branches, eq(sessions.branch_id, branches.branch_id))
      .where(and(eq(sessions.session_id, sessionId), visibleBranchAccessCondition(db, userId)))
  );
}

export function visibleTaskReferenceAccessExists(
  db: Database,
  userId: UserIdExpression,
  taskId: SQLWrapper
): SQL {
  return exists(
    selectRaw(db)
      .from(tasks)
      .where(
        and(
          eq(tasks.task_id, taskId),
          visibleSessionReferenceAccessExists(db, userId, tasks.session_id)
        )
      )
  );
}

export function visibleMessageReferenceAccessExists(
  db: Database,
  userId: UserIdExpression,
  messageId: SQLWrapper
): SQL {
  return exists(
    selectRaw(db)
      .from(messages)
      .where(
        and(
          eq(messages.message_id, messageId),
          visibleSessionReferenceAccessExists(db, userId, messages.session_id)
        )
      )
  );
}
