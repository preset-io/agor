import type {
  BoardCapabilityPoliciesDraft,
  BranchCapabilityPolicyDraft,
  CapabilityPolicyDraft,
  CapabilityPolicyEntryDraft,
  CapabilityPolicyFsAccess,
  CapabilityPolicyOthersDraft,
  CapabilityPolicyPresetId,
  CapabilityPolicyPrincipalDescriptor,
  CapabilityPolicyPrincipalRef,
} from '@agor/core/types';
import { CAPABILITY_POLICY_SCHEMA_VERSION } from '@agor/core/types';
import type {
  Board,
  BoardGroupGrantWithGroup,
  Branch,
  BranchGroupGrantWithGroup,
  BranchPermissionLevel,
  Group,
  GroupID,
  GroupMembership,
  Session,
  User,
  UserID,
} from '@agor-live/client';
import {
  applyCapabilityPreset,
  BOARD_ACCESS_EDITOR_CONTEXT,
  BRANCH_ACCESS_EDITOR_CONTEXT,
  type CapabilityPolicyEditorContext,
  updateFilesystemAccess,
} from './policyEditorModel';
import { makePrototypeDraftId } from './prototypeDraftId';
import type { PrototypeAccessSubject } from './prototypeEffectiveAccess';

export type LegacyCapabilityPolicyGroupGrant = Pick<
  BoardGroupGrantWithGroup | BranchGroupGrantWithGroup,
  'group_id' | 'can' | 'fs_access'
>;

const asUserId = (value: string): UserID => value as UserID;
const asGroupId = (value: string): GroupID => value as GroupID;

function branchPresetForLegacy(level: BranchPermissionLevel | undefined): CapabilityPolicyPresetId {
  switch (level) {
    case 'view':
      return 'viewer';
    case 'session':
    case 'prompt':
      // The target model never synthesizes foreign-home authority from the
      // legacy prompt tier.
      return 'collaborator';
    case 'all':
      return 'manager';
    default:
      return 'none';
  }
}

function grantValue(
  context: CapabilityPolicyEditorContext,
  preset: CapabilityPolicyPresetId,
  fsAccess: CapabilityPolicyFsAccess
): CapabilityPolicyOthersDraft {
  const base: CapabilityPolicyOthersDraft = {
    preset: 'none',
    capabilities: [],
    fs_access: context.supportsFilesystem ? fsAccess : 'none',
  };
  const withPreset = applyCapabilityPreset(base, context, preset);
  return context.supportsFilesystem
    ? updateFilesystemAccess(withPreset, context, preset === 'none' ? 'none' : fsAccess)
    : withPreset;
}

function policyEntry(
  context: CapabilityPolicyEditorContext,
  principal: CapabilityPolicyPrincipalRef,
  preset: CapabilityPolicyPresetId,
  fsAccess: CapabilityPolicyFsAccess = 'none'
): CapabilityPolicyEntryDraft {
  return {
    entry_id: makePrototypeDraftId(),
    principal,
    ...grantValue(context, preset, fsAccess),
  };
}

function sharedPolicy(
  kind: CapabilityPolicyDraft['policy_kind'],
  entries: CapabilityPolicyEntryDraft[],
  others: CapabilityPolicyOthersDraft
): CapabilityPolicyDraft {
  return {
    schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
    policy_kind: kind,
    sharing_mode: 'shared',
    entries,
    others,
  };
}

function privatePolicy(kind: CapabilityPolicyDraft['policy_kind']): CapabilityPolicyDraft {
  return {
    schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
    policy_kind: kind,
    sharing_mode: 'private',
    entries: [],
    others: grantValue(
      kind === 'board_access' ? BOARD_ACCESS_EDITOR_CONTEXT : BRANCH_ACCESS_EDITOR_CONTEXT,
      'none',
      'none'
    ),
  };
}

function additionalOwnerEntries(
  owners: readonly User[],
  primaryOwnerUserId: UserID,
  context: CapabilityPolicyEditorContext
): CapabilityPolicyEntryDraft[] {
  return owners
    .filter((owner) => owner.user_id !== primaryOwnerUserId)
    .map((owner) =>
      policyEntry(context, { principal_type: 'user', user_id: owner.user_id }, 'manager')
    );
}

function branchEntriesFromLegacy(
  grants: readonly LegacyCapabilityPolicyGroupGrant[],
  owners: readonly User[],
  primaryOwnerUserId: UserID
): CapabilityPolicyEntryDraft[] {
  return [
    ...additionalOwnerEntries(owners, primaryOwnerUserId, BRANCH_ACCESS_EDITOR_CONTEXT),
    ...grants.map((grant) =>
      policyEntry(
        BRANCH_ACCESS_EDITOR_CONTEXT,
        { principal_type: 'group', group_id: grant.group_id },
        branchPresetForLegacy(grant.can),
        grant.fs_access ?? 'read'
      )
    ),
  ];
}

function boardBranchTemplate(
  board: Board | null | undefined,
  grants: readonly LegacyCapabilityPolicyGroupGrant[]
): CapabilityPolicyDraft {
  return sharedPolicy(
    'branch_access',
    grants.map((grant) =>
      policyEntry(
        BRANCH_ACCESS_EDITOR_CONTEXT,
        { principal_type: 'group', group_id: grant.group_id },
        branchPresetForLegacy(grant.can),
        grant.fs_access ?? board?.default_others_fs_access ?? 'read'
      )
    ),
    grantValue(
      BRANCH_ACCESS_EDITOR_CONTEXT,
      branchPresetForLegacy(board?.default_others_can),
      board?.default_others_fs_access ?? 'read'
    )
  );
}

export function buildBoardModalPrototypeDraft(options: {
  board: Board;
  owners: readonly User[];
  groupGrants: readonly LegacyCapabilityPolicyGroupGrant[];
}): BoardCapabilityPoliciesDraft {
  const { board, owners, groupGrants } = options;
  const primaryOwnerUserId = asUserId(board.created_by || owners[0]?.user_id);
  const boardAccess =
    board.access_mode === 'private'
      ? privatePolicy('board_access')
      : sharedPolicy(
          'board_access',
          [
            ...additionalOwnerEntries(owners, primaryOwnerUserId, BOARD_ACCESS_EDITOR_CONTEXT),
            ...groupGrants
              .filter((grant) => grant.can === 'all')
              .map((grant) =>
                policyEntry(
                  BOARD_ACCESS_EDITOR_CONTEXT,
                  { principal_type: 'group', group_id: grant.group_id },
                  'manager'
                )
              ),
          ],
          grantValue(BOARD_ACCESS_EDITOR_CONTEXT, 'viewer', 'none')
        );

  return {
    primary_owner_user_id: primaryOwnerUserId,
    board_access: boardAccess,
    // Board visibility and the live branch template are deliberately separate.
    // A private board can still display what its branches would inherit.
    branch_template: boardBranchTemplate(board, groupGrants),
  };
}

export function buildBranchModalPrototypeDraft(options: {
  branch: Branch;
  board?: Board | null;
  owners: readonly User[];
  groupGrants: readonly LegacyCapabilityPolicyGroupGrant[];
  boardGroupGrants: readonly LegacyCapabilityPolicyGroupGrant[];
  currentUserId: UserID;
  sessions: readonly Session[];
}): BranchCapabilityPolicyDraft {
  const { branch, board, owners, groupGrants, boardGroupGrants, currentUserId, sessions } = options;
  const primaryOwnerUserId = asUserId(branch.created_by || owners[0]?.user_id);
  const inheritedPolicy = boardBranchTemplate(board, boardGroupGrants);
  const overridePolicy = sharedPolicy(
    'branch_access',
    branchEntriesFromLegacy(groupGrants, owners, primaryOwnerUserId),
    grantValue(
      BRANCH_ACCESS_EDITOR_CONTEXT,
      branchPresetForLegacy(branch.others_can),
      branch.others_fs_access ?? 'read'
    )
  );
  const sessionOwnerIds = new Set<UserID>([
    currentUserId,
    ...sessions.map((session) => asUserId(session.created_by)),
  ]);

  return {
    primary_owner_user_id: primaryOwnerUserId,
    binding_mode: branch.permission_source === 'board' ? 'inherit' : 'override',
    inherited_from_board_id: board?.board_id,
    inherited_policy: inheritedPolicy,
    override_policy: branch.permission_source === 'board' ? undefined : overridePolicy,
    // The broad legacy dangerous flag is intentionally never converted into
    // personal consent. Every owner begins with an empty, disabled rule.
    session_sharing: {
      owner_rules: [...sessionOwnerIds].map((sessionOwnerUserId) => ({
        session_owner_user_id: sessionOwnerUserId,
        enabled: false,
        grantees: [],
      })),
    },
  };
}

export function buildModalPrototypeDirectory(options: {
  users: readonly User[];
  groups: readonly Group[];
  memberships?: readonly GroupMembership[];
  requiredUserIds?: readonly (UserID | string)[];
}): {
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: PrototypeAccessSubject[];
} {
  const { users, groups, memberships = [], requiredUserIds = [] } = options;
  const userById = new Map(users.map((user) => [user.user_id, user]));
  const allUserIds = new Set<UserID>([
    ...users.map((user) => user.user_id),
    ...requiredUserIds.filter(Boolean).map((userId) => asUserId(userId)),
  ]);
  const groupIdsByUser = new Map<UserID, GroupID[]>();
  const memberCountByGroup = new Map<GroupID, number>();
  for (const membership of memberships) {
    const userId = asUserId(membership.user_id);
    const groupId = asGroupId(membership.group_id);
    groupIdsByUser.set(userId, [...(groupIdsByUser.get(userId) ?? []), groupId]);
    memberCountByGroup.set(groupId, (memberCountByGroup.get(groupId) ?? 0) + 1);
  }

  const userPrincipals: CapabilityPolicyPrincipalDescriptor[] = [...allUserIds].map((userId) => {
    const user = userById.get(userId);
    return {
      principal: { principal_type: 'user', user_id: userId },
      display_name: user?.name || user?.email || `Unavailable user · ${userId.slice(0, 8)}`,
      secondary_label: user?.email ?? 'Identity is not present in the active directory',
      status: user ? 'active' : 'deleted',
    };
  });
  const groupPrincipals: CapabilityPolicyPrincipalDescriptor[] = groups.map((group) => ({
    principal: { principal_type: 'group', group_id: group.group_id },
    display_name: group.name,
    secondary_label:
      memberships.length > 0
        ? `${memberCountByGroup.get(group.group_id) ?? 0} current ${memberCountByGroup.get(group.group_id) === 1 ? 'member' : 'members'}`
        : 'Workspace group · membership count unavailable',
    status: group.archived ? 'inactive' : 'active',
  }));
  const principals = [...userPrincipals, ...groupPrincipals];
  const subjects = userPrincipals
    .filter(
      (descriptor): descriptor is PrototypeAccessSubject['user'] =>
        descriptor.status === 'active' && descriptor.principal.principal_type === 'user'
    )
    .map((user) => ({ user, groupIds: groupIdsByUser.get(user.principal.user_id) ?? [] }));

  return { principals, subjects };
}
