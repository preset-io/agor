import type { AgorClient, Board, GroupMembership, User } from '@agor-live/client';
import { hasMinimumRole, ROLES, resolveCapabilityPolicyAccess } from '@agor-live/client';
import { useEffect, useState } from 'react';

/**
 * Resolve board-management capability from the same normalized policy used by
 * the daemon. Board access is intentionally independent of child branches.
 */
export function useCanManageBoard(
  client: AgorClient | null,
  board: Board | undefined,
  user: User | null | undefined
) {
  const [canManage, setCanManage] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCanManage(false);
    if (!board || !user || !client || board.archived) return;
    if (hasMinimumRole(user.role, ROLES.ADMIN) || board.primary_owner_user_id === user.user_id) {
      setCanManage(true);
      return;
    }
    if (!hasMinimumRole(user.role, ROLES.MEMBER)) return;

    void Promise.all([
      client.service('boards/:id/permissions').find({ route: { id: board.board_id } }),
      client.service('group-memberships').findAll({ query: { user_id: user.user_id } }),
    ])
      .then(([permissions, memberships]) => {
        if (cancelled) return;
        const access = resolveCapabilityPolicyAccess({
          policy: permissions.board_access,
          primary_owner_user_id: permissions.primary_owner_user_id,
          user_id: user.user_id,
          user_status: 'active',
          active_group_ids: (memberships as GroupMembership[]).map((item) => item.group_id),
        });
        setCanManage(access.capabilities.includes('board.edit'));
      })
      .catch(() => {
        if (!cancelled) setCanManage(false);
      });

    return () => {
      cancelled = true;
    };
  }, [board, client, user]);

  return canManage;
}
