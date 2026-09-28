import type { AgorClient, BoardCapabilityPolicies, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { useEffect, useMemo, useState } from 'react';
import { useConnectionState } from '../contexts/ConnectionContext';
import { peekAccess, readAccess } from '../utils/accessCache';

const allowAll = () => true;

/**
 * Whether a board reaches the caller through its policy rather than a role
 * bypass. Board lists are already policy-scoped for everyone except
 * superadmins, so only they pay one policy read per board (shared through the
 * access cache); unknown is false.
 */
export function useBoardsSharedWithMe(
  client: AgorClient | null,
  user: User | null | undefined,
  boardIds: readonly string[]
): (boardId: string) => boolean {
  const { authGeneration } = useConnectionState();
  const bypasses = hasMinimumRole(user?.role, ROLES.SUPERADMIN);
  const userId = user?.user_id;
  const scope = `${userId}:${authGeneration}`;
  const key = bypasses ? [...new Set(boardIds)].sort().join(',') : '';
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!client || !key || !userId) return;
    let cancelled = false;
    for (const boardId of key.split(',')) {
      if (peekAccess(client, scope, `board:${boardId}`) !== undefined) continue;
      readAccess(client, scope, `board:${boardId}`, async () => {
        const { primary_owner_user_id, board_access } = (await client
          .service('boards/:id/permissions')
          .find({ route: { id: boardId } })) as unknown as BoardCapabilityPolicies;
        return (
          board_access.sharing_mode === 'shared' ||
          primary_owner_user_id === userId ||
          board_access.entries.some(
            (entry) =>
              entry.principal.principal_type === 'user' && entry.principal.user_id === userId
          )
        );
      }).then(
        (mine) => mine && !cancelled && setVersion((v) => v + 1),
        () => {}
      );
    }
    return () => {
      cancelled = true;
    };
  }, [client, key, scope, userId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version re-reads the cache after a read settles
  return useMemo(
    () =>
      bypasses
        ? (boardId: string) => !!client && peekAccess(client, scope, `board:${boardId}`) === true
        : allowAll,
    [bypasses, client, scope, version]
  );
}
