import type {
  AgorClient,
  BoardCapabilityPolicies,
  BranchCapabilityPolicy,
  CapabilityPolicyWorkspacePreferences,
  Group,
  GroupMembership,
  Session,
  User,
  UserID,
} from '@agor-live/client';
import { hasMinimumRole, ROLES, resolveCapabilityPolicyAccess } from '@agor-live/client';
import { Alert, Flex, theme } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { BoardCapabilityPolicyForm } from './BoardCapabilityPolicyForm';
import { BranchCapabilityPolicyForm } from './BranchCapabilityPolicyForm';
import { buildCapabilityPolicyDirectory } from './principalDirectory';

function useMemberships(client: AgorClient | null) {
  const [memberships, setMemberships] = useState<GroupMembership[]>([]);
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .service('group-memberships')
      .findAll({})
      .then((result) => {
        if (!cancelled) {
          setMemberships(result as GroupMembership[]);
          setAvailable(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMemberships([]);
          setAvailable(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client]);
  return { memberships, available };
}

const Frame: React.FC<{ children: React.ReactNode; membershipPreviewAvailable: boolean }> = ({
  children,
  membershipPreviewAvailable,
}) => {
  const { token } = theme.useToken();
  return (
    <Flex vertical gap={token.paddingMD}>
      {!membershipPreviewAvailable && (
        <Alert type="info" showIcon description="Group membership preview is unavailable." />
      )}
      {children}
    </Flex>
  );
};

export const BoardCapabilityPolicyModalEditor: React.FC<{
  value: BoardCapabilityPolicies;
  onChange: (value: BoardCapabilityPolicies) => void;
  client: AgorClient | null;
  users: User[];
  groups: Group[];
  currentUser?: User | null;
  workspacePreferences: CapabilityPolicyWorkspacePreferences;
}> = ({ value, onChange, client, users, groups, currentUser, workspacePreferences }) => {
  const { memberships, available } = useMemberships(client);
  const currentUserId = (currentUser?.user_id ?? value.primary_owner_user_id) as UserID;
  const directory = useMemo(
    () =>
      buildCapabilityPolicyDirectory({
        users,
        groups,
        memberships,
        requiredUserIds: [value.primary_owner_user_id, currentUserId],
      }),
    [users, groups, memberships, value.primary_owner_user_id, currentUserId]
  );
  const activeGroupIds = useMemo(
    () =>
      memberships
        .filter((membership) => membership.user_id === currentUserId)
        .map((membership) => membership.group_id),
    [memberships, currentUserId]
  );
  const effectiveAccess = useMemo(
    () =>
      resolveCapabilityPolicyAccess({
        policy: value.board_access,
        primary_owner_user_id: value.primary_owner_user_id,
        user_id: currentUserId,
        user_status: 'active',
        active_group_ids: activeGroupIds,
      }),
    [value.board_access, value.primary_owner_user_id, currentUserId, activeGroupIds]
  );
  const canManageAccess =
    hasMinimumRole(currentUser?.role, ROLES.ADMIN) ||
    effectiveAccess.capabilities.includes('board.policy.manage');
  return (
    <Frame membershipPreviewAvailable={available}>
      <BoardCapabilityPolicyForm
        value={value}
        onChange={onChange}
        principals={directory.principals}
        subjects={directory.subjects}
        sampleBranchOwnerUserId={value.primary_owner_user_id}
        sessionSharingWorkspaceEnabled={workspacePreferences.session_sharing_enabled}
        canManageAccess={canManageAccess}
      />
    </Frame>
  );
};

export const BranchCapabilityPolicyModalEditor: React.FC<{
  value: BranchCapabilityPolicy;
  onChange: (value: BranchCapabilityPolicy) => void;
  client: AgorClient | null;
  currentUser?: User | null;
  users: User[];
  groups: Group[];
  sessions?: Session[];
  workspacePreferences: CapabilityPolicyWorkspacePreferences;
  canManageAccess?: boolean;
}> = ({
  value,
  onChange,
  client,
  currentUser,
  users,
  groups,
  sessions = [],
  workspacePreferences,
  canManageAccess,
}) => {
  const { memberships, available } = useMemberships(client);
  const currentUserId = (currentUser?.user_id ?? value.primary_owner_user_id) as UserID;
  const requiredUserIds = useMemo(
    () => [
      value.primary_owner_user_id,
      currentUserId,
      ...sessions.map((session) => session.created_by as UserID),
    ],
    [value.primary_owner_user_id, currentUserId, sessions]
  );
  const directory = useMemo(
    () => buildCapabilityPolicyDirectory({ users, groups, memberships, requiredUserIds }),
    [users, groups, memberships, requiredUserIds]
  );
  return (
    <Frame membershipPreviewAvailable={available}>
      <BranchCapabilityPolicyForm
        value={value}
        onChange={onChange}
        principals={directory.principals}
        subjects={directory.subjects}
        sessionSharingWorkspaceEnabled={workspacePreferences.session_sharing_enabled}
        canManageAccess={canManageAccess}
      />
    </Frame>
  );
};
