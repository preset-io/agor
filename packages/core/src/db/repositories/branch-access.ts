/** Shared SQL predicates for normalized board/branch capability policies. */

import type { CapabilityPolicyFsAccess, SessionID, UserID, UUID } from '@agor/core/types';
import { and, eq, exists, inArray, or, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import {
  CAPABILITY_POLICY_SESSION_SHARING_KEY,
  CAPABILITY_POLICY_WORKSPACE_PREFERENCES_NAMESPACE,
} from '../../types/capability-policy';
import type { Database } from '../client';
import { select } from '../database-wrapper';
import {
  appVariables,
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
  users,
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

/**
 * Closed point projection used by Task launch and heartbeat revalidation.
 *
 * It deliberately returns only the facts those consumers use. The richer
 * policy read model still owns permission-editor explanations and group IDs.
 */
export interface SessionRuntimeBranchAccess {
  branch_id: string;
  principal_available: boolean;
  can_prompt_session: boolean;
  fs_access: CapabilityPolicyFsAccess;
  /** Database time in PostgreSQL; callers may override it in deterministic tests. */
  observed_at: Date;
}

function numericValue(value: unknown, fallback = -1): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fsAccessFromRank(rank: number): CapabilityPolicyFsAccess {
  return rank >= 2 ? 'write' : rank >= 1 ? 'read' : 'none';
}

function roleGrantsSessionPrompt(role: unknown): boolean {
  return role === 'collaborator' || role === 'manager';
}

/**
 * Resolve one principal's current right to prompt one exact Session and its
 * effective Branch filesystem access in one bounded SQL statement.
 *
 * The scalar subqueries mirror the normalized-policy precedence exactly:
 * primary owner -> direct-user shadow -> additive active groups -> unmatched
 * Others. Fixed cumulative roles let group capability be represented by the
 * greatest role rank, while filesystem access is ranked independently.
 * Global superadmin bypass is intentionally excluded: administration does not
 * grant prompt authority or widen one principal's projected Branch mounts.
 */
export async function resolveSessionRuntimeBranchAccess(
  db: Database,
  input: {
    sessionId: SessionID | string;
    principalUserId: UserID | string;
  }
): Promise<SessionRuntimeBranchAccess | null> {
  const principal = input.principalUserId;
  const directRole = sql<string | null>`(
    SELECT ${branchPermissionEntries.role}
    FROM ${branchPermissionEntries}
    WHERE ${branchPermissionEntries.config_id} = ${branchPermissionConfigs.config_id}
      AND ${branchPermissionEntries.user_id} = ${principal}
    LIMIT 1
  )`;
  const directFsAccess = sql<string | null>`(
    SELECT ${branchPermissionEntries.fs_access}
    FROM ${branchPermissionEntries}
    WHERE ${branchPermissionEntries.config_id} = ${branchPermissionConfigs.config_id}
      AND ${branchPermissionEntries.user_id} = ${principal}
    LIMIT 1
  )`;
  const activeGroupRoleRank = sql<number>`COALESCE((
    SELECT MAX(CASE ${branchPermissionEntries.role}
      WHEN 'manager' THEN 3
      WHEN 'collaborator' THEN 2
      WHEN 'viewer' THEN 1
      ELSE 0 END)
    FROM ${branchPermissionEntries}
    INNER JOIN ${groupMemberships}
      ON ${groupMemberships.group_id} = ${branchPermissionEntries.group_id}
     AND ${groupMemberships.user_id} = ${principal}
    INNER JOIN ${groups}
      ON ${groups.group_id} = ${branchPermissionEntries.group_id}
     AND ${groups.archived} = false
    WHERE ${branchPermissionEntries.config_id} = ${branchPermissionConfigs.config_id}
  ), -1)`;
  const activeGroupFsRank = sql<number>`COALESCE((
    SELECT MAX(CASE ${branchPermissionEntries.fs_access}
      WHEN 'write' THEN 2
      WHEN 'read' THEN 1
      ELSE 0 END)
    FROM ${branchPermissionEntries}
    INNER JOIN ${groupMemberships}
      ON ${groupMemberships.group_id} = ${branchPermissionEntries.group_id}
     AND ${groupMemberships.user_id} = ${principal}
    INNER JOIN ${groups}
      ON ${groups.group_id} = ${branchPermissionEntries.group_id}
     AND ${groups.archived} = false
    WHERE ${branchPermissionEntries.config_id} = ${branchPermissionConfigs.config_id}
  ), -1)`;
  const row = await select(db, {
    branch_id: branches.branch_id,
    session_owner_user_id: sessions.created_by,
    session_sdk_home_scope: sessions.sdk_home_scope,
    principal_user_id: users.user_id,
    branch_primary_owner_user_id: branches.primary_owner_user_id,
    sharing_mode: branchPermissionConfigs.sharing_mode,
    others_role: branchPermissionConfigs.others_role,
    others_fs_access: branchPermissionConfigs.others_fs_access,
    allow_shared_session_prompts: branchPermissionConfigs.allow_shared_session_prompts,
    direct_role: directRole,
    direct_fs_access: directFsAccess,
    active_group_role_rank: activeGroupRoleRank,
    active_group_fs_rank: activeGroupFsRank,
    workspace_sharing_enabled: exists(
      selectRaw(db)
        .from(appVariables)
        .where(
          and(
            eq(appVariables.namespace, CAPABILITY_POLICY_WORKSPACE_PREFERENCES_NAMESPACE),
            eq(appVariables.key, CAPABILITY_POLICY_SESSION_SHARING_KEY),
            eq(appVariables.value_text, 'true')
          )
        )
    ),
    observed_at: sql<Date>`CURRENT_TIMESTAMP`,
  })
    .from(sessions)
    .innerJoin(branches, eq(branches.branch_id, sessions.branch_id))
    .innerJoin(branchPermissionConfigs, effectiveConfigCondition())
    .leftJoin(users, eq(users.user_id, principal))
    .where(eq(sessions.session_id, input.sessionId))
    .limit(1)
    .one();
  if (!row) return null;

  const principalUserId =
    typeof row.principal_user_id === 'string' ? row.principal_user_id : undefined;
  const isPrimaryOwner =
    principalUserId !== undefined && row.branch_primary_owner_user_id === principalUserId;
  const directMatched = typeof row.direct_role === 'string';
  const groupRoleRank = numericValue(row.active_group_role_rank);
  const groupFsRank = numericValue(row.active_group_fs_rank);

  let canPromptOwn = false;
  let fsAccess: CapabilityPolicyFsAccess = 'none';
  if (principalUserId && isPrimaryOwner) {
    canPromptOwn = true;
    fsAccess = 'write';
  } else if (principalUserId && row.sharing_mode === 'shared') {
    if (directMatched) {
      canPromptOwn = roleGrantsSessionPrompt(row.direct_role);
      fsAccess =
        row.direct_fs_access === 'write'
          ? 'write'
          : row.direct_fs_access === 'read'
            ? 'read'
            : 'none';
    } else if (groupRoleRank >= 0) {
      canPromptOwn = groupRoleRank >= 2;
      fsAccess = fsAccessFromRank(groupFsRank);
    } else {
      canPromptOwn = roleGrantsSessionPrompt(row.others_role);
      fsAccess =
        row.others_fs_access === 'write'
          ? 'write'
          : row.others_fs_access === 'read'
            ? 'read'
            : 'none';
    }
  }

  const ownsSession =
    principalUserId !== undefined && principalUserId === row.session_owner_user_id;
  const sharedSessionAllowed =
    row.session_sdk_home_scope === 'branch' &&
    Boolean(row.workspace_sharing_enabled) &&
    Boolean(row.allow_shared_session_prompts);
  const observedAt =
    row.observed_at instanceof Date ? row.observed_at : new Date(String(row.observed_at));
  return {
    branch_id: String(row.branch_id),
    principal_available: principalUserId !== undefined,
    can_prompt_session: Boolean(
      principalUserId && canPromptOwn && (ownsSession || sharedSessionAllowed)
    ),
    fs_access: principalUserId ? fsAccess : 'none',
    observed_at: observedAt,
  };
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
  const matchingGroupEntryExists = (entryCondition?: SQL): SQL =>
    exists(
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
            ...(entryCondition ? [entryCondition] : [])
          )
        )
    );
  if (!capability) return matchingGroupEntryExists();
  if (capability === 'terminal.open') {
    return (
      and(
        matchingGroupEntryExists(
          roleGrantsCapability(branchPermissionEntries.role, 'branch', capability)
        ),
        matchingGroupEntryExists(inArray(branchPermissionEntries.fs_access, ['read', 'write']))
      ) ?? sql`false`
    );
  }
  return matchingGroupEntryExists(
    branchRoleGrantsCapability(
      branchPermissionEntries.role,
      branchPermissionEntries.fs_access,
      capability
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
