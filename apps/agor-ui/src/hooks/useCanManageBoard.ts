import type { AgorClient, Board, EffectiveCapabilityPolicyAccess, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { useEffect, useState } from 'react';
import { useConnectionState } from '../contexts/ConnectionContext';

/**
 * Resolve board-management capability from the same normalized policy used by
 * the daemon. Board access is intentionally independent of child branches.
 */
export function useCanManageBoard(
  client: AgorClient | null,
  board: Board | undefined,
  user: User | null | undefined
) {
  const [permission, setPermission] = useState<{
    client: AgorClient | null;
    scopeKey: string | null;
    canManage: boolean;
  }>({ client: null, scopeKey: null, canManage: false });
  const { authGeneration } = useConnectionState();
  const boardId = board?.board_id;
  const boardArchived = Boolean(board?.archived);
  const primaryOwnerUserId = board?.primary_owner_user_id;
  const userId = user?.user_id;
  const userRole = user?.role;
  const scopeKey = [
    boardId ?? '',
    boardArchived ? 'archived' : 'active',
    primaryOwnerUserId ?? '',
    userId ?? '',
    userRole ?? '',
    authGeneration,
  ].join(':');

  useEffect(() => {
    let cancelled = false;
    const publish = (canManage: boolean) => {
      setPermission({ client, scopeKey, canManage });
    };
    publish(false);
    if (!boardId || !userId || !userRole || !client || boardArchived) return;
    if (!hasMinimumRole(userRole, ROLES.MEMBER)) return;

    if (hasMinimumRole(userRole, ROLES.ADMIN) || primaryOwnerUserId === userId) {
      publish(true);
      return;
    }

    // The daemon owns policy, group-membership, and principal precedence. Use
    // its effective-access projection instead of reimplementing that resolver
    // in the browser.
    void client
      .service('boards/:id/effective-access')
      .find({ route: { id: boardId } })
      .then((access: unknown) => {
        if (cancelled) return;
        publish((access as EffectiveCapabilityPolicyAccess).capabilities.includes('board.edit'));
      })
      .catch(() => {
        if (!cancelled) publish(false);
      });

    return () => {
      cancelled = true;
    };
  }, [boardArchived, boardId, client, primaryOwnerUserId, scopeKey, userId, userRole]);

  // Never expose an answer from a previous authenticated generation, identity,
  // board, or client during the render before the refetch effect runs.
  return permission.client === client && permission.scopeKey === scopeKey
    ? permission.canManage
    : false;
}
