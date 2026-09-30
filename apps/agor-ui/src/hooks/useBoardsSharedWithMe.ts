import type {
  AgorClient,
  BoardCapabilityPolicies,
  Group,
  GroupID,
  GroupMembership,
  User,
  UserID,
} from '@agor-live/client';
import { hasMinimumRole, ROLES, resolveCapabilityPolicyAccess } from '@agor-live/client';
import { useEffect, useMemo, useState } from 'react';
import { useConnectionState } from '../contexts/ConnectionContext';
import { accessScope, peekAccess, readAccess } from '../utils/accessCache';

const allowAll = () => true;

/** The caller's unarchived group memberships; no groups read when the caller is in none. */
async function activeGroupIds(client: AgorClient, userId: string): Promise<GroupID[]> {
  const memberships = (await client
    .service('group-memberships')
    .findAll({ query: { user_id: userId } })) as GroupMembership[];
  const mine = new Set(memberships.filter((m) => m.user_id === userId).map((m) => m.group_id));
  if (!mine.size) return [];
  // The groups service filters only by `archived`, so the caller's ids are matched here.
  const groups = (await client
    .service('groups')
    .findAll({ query: { archived: false } })) as Group[];
  return groups.map((group) => group.group_id).filter((id) => mine.has(id));
}

/** Whether the board's own policy lets the caller view it, ignoring any role bypass. */
async function boardPolicyGrantsView(
  client: AgorClient,
  userId: string,
  boardId: string,
  groupIds: Promise<GroupID[]>
): Promise<boolean> {
  const [policies, activeGroups] = await Promise.all([
    client
      .service('boards/:id/permissions')
      .find({ route: { id: boardId } }) as unknown as Promise<BoardCapabilityPolicies>,
    groupIds,
  ]);
  return resolveCapabilityPolicyAccess({
    policy: policies.board_access,
    primary_owner_user_id: policies.primary_owner_user_id,
    user_id: userId as UserID,
    user_status: 'active',
    active_group_ids: activeGroups,
  }).capabilities.includes('board.view');
}

/**
 * Whether a board reaches the caller through its policy rather than a role
 * bypass. Board lists are already policy-scoped for everyone except
 * superadmins, so only they pay one policy read per board, resolved with the
 * shared capability resolver and shared through the access cache. Unknown and
 * failed reads are false; a failed read is retried on the next mount, board
 * set or sign-in.
 */
export function useBoardsSharedWithMe(
  client: AgorClient | null,
  user: User | null | undefined,
  boardIds: readonly string[]
): (boardId: string) => boolean {
  const { authGeneration } = useConnectionState();
  const bypasses = hasMinimumRole(user?.role, ROLES.SUPERADMIN);
  const userId = user?.user_id;
  const scope = accessScope(user, authGeneration);
  const key = bypasses ? [...new Set(boardIds)].sort().join(',') : '';
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!client || !key || !userId) return;
    const controller = new AbortController();
    // Requested before the board reads, so it holds a read slot ahead of every read awaiting it.
    const groupIds = readAccess(client, scope, `groups:${userId}`, () =>
      activeGroupIds(client, userId)
    );
    groupIds.catch(() => {});
    for (const boardId of key.split(',')) {
      readAccess(
        client,
        scope,
        `board:${boardId}`,
        () => boardPolicyGrantsView(client, userId, boardId, groupIds),
        { signal: controller.signal }
      ).then(
        () => setVersion((v) => v + 1),
        () => {}
      );
    }
    return () => controller.abort();
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
