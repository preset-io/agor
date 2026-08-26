import type { CapabilityPolicyPrincipalDescriptor } from '@agor/core/types';
import {
  type Group,
  type GroupID,
  type GroupMembership,
  shortId,
  type User,
  type UserID,
} from '@agor-live/client';
import type { EffectiveAccessSubject } from './effectiveAccessPreviewModel';

const asUserId = (value: string): UserID => value as UserID;
const asGroupId = (value: string): GroupID => value as GroupID;

/** Hydrate canonical user/group pointers for selectors and on-demand previews. */
export function buildCapabilityPolicyDirectory(options: {
  users: readonly User[];
  groups: readonly Group[];
  memberships?: readonly GroupMembership[];
  requiredUserIds?: readonly (UserID | string)[];
}): {
  principals: CapabilityPolicyPrincipalDescriptor[];
  subjects: EffectiveAccessSubject[];
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
      display_name: user?.name || user?.email || `Unavailable user · ${shortId(userId)}`,
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
      (descriptor): descriptor is EffectiveAccessSubject['user'] =>
        descriptor.status === 'active' && descriptor.principal.principal_type === 'user'
    )
    .map((user) => ({ user, groupIds: groupIdsByUser.get(user.principal.user_id) ?? [] }));

  return { principals, subjects };
}
