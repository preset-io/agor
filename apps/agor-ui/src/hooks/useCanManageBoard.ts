import type {
  AgorClient,
  Board,
  BoardGroupGrantWithGroup,
  GroupMembership,
  User,
} from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { useEffect, useState } from 'react';

/**
 * Resolve the UI equivalent of BoardRepository.canMutate from canonical
 * owner, group-grant, membership, creator, and role inputs.
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
    if (hasMinimumRole(user.role, ROLES.ADMIN) || board.created_by === user.user_id) {
      setCanManage(true);
      return;
    }
    if (!hasMinimumRole(user.role, ROLES.MEMBER)) return;

    void Promise.all([
      client.service('boards/:id/owners').find({ route: { id: board.board_id } }),
      client.service('boards/:id/group-grants').find({ route: { id: board.board_id } }),
      client.service('group-memberships').findAll({ query: { user_id: user.user_id } }),
    ])
      .then(([owners, grants, memberships]) => {
        if (cancelled) return;
        const groupIds = new Set((memberships as GroupMembership[]).map((item) => item.group_id));
        setCanManage(
          (owners as User[]).some((owner) => owner.user_id === user.user_id) ||
            (board.access_mode !== 'private' &&
              (grants as BoardGroupGrantWithGroup[]).some(
                (grant) => grant.can === 'all' && groupIds.has(grant.group_id)
              ))
        );
      })
      .catch((error: unknown) => {
        // A 404 is the daemon's documented signal that board RBAC services are
        // disabled. Fail closed for disconnects and authorization/server errors.
        if (!cancelled) setCanManage((error as { code?: number })?.code === 404);
      });

    return () => {
      cancelled = true;
    };
  }, [board, client, user]);

  return canManage;
}
