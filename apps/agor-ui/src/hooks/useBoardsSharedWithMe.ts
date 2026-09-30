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
import { ACCESS_TTL_MS, peekAccess, readAccess } from '../utils/accessCache';

const allowAll = () => true;

const groupReads = new WeakMap<
  object,
  { scope: string; at: number; groupIds: Promise<GroupID[]> }
>();

/** The caller's unarchived group memberships, cached like access answers; a failure is forgotten. */
function activeGroupIds(client: AgorClient, scope: string, userId: string): Promise<GroupID[]> {
  const cached = groupReads.get(client);
  if (cached?.scope === scope && Date.now() - cached.at < ACCESS_TTL_MS) return cached.groupIds;
  const groupIds = Promise.all([
    client.service('group-memberships').findAll({ query: { user_id: userId } }),
    client.service('groups').findAll({ query: { archived: false } }),
  ]).then(([memberships, groups]) => {
    const active = new Set((groups as Group[]).map((group) => group.group_id));
    return (memberships as GroupMembership[])
      .filter((membership) => membership.user_id === userId && active.has(membership.group_id))
      .map((membership) => membership.group_id);
  });
  groupReads.set(client, { scope, at: Date.now(), groupIds });
  groupIds.catch(() => {
    if (groupReads.get(client)?.groupIds === groupIds) groupReads.delete(client);
  });
  return groupIds;
}

/** Whether the board's own policy lets the caller view it, ignoring any role bypass. */
async function boardPolicyGrantsView(
  client: AgorClient,
  scope: string,
  userId: string,
  boardId: string
): Promise<boolean> {
  const [policies, groupIds] = await Promise.all([
    client
      .service('boards/:id/permissions')
      .find({ route: { id: boardId } }) as unknown as Promise<BoardCapabilityPolicies>,
    activeGroupIds(client, scope, userId),
  ]);
  return resolveCapabilityPolicyAccess({
    policy: policies.board_access,
    primary_owner_user_id: policies.primary_owner_user_id,
    user_id: userId as UserID,
    user_status: 'active',
    active_group_ids: groupIds,
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
  const scope = `${userId}:${authGeneration}`;
  const key = bypasses ? [...new Set(boardIds)].sort().join(',') : '';
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!client || !key || !userId) return;
    const controller = new AbortController();
    for (const boardId of key.split(',')) {
      readAccess(
        client,
        scope,
        `board:${boardId}`,
        () => boardPolicyGrantsView(client, scope, userId, boardId),
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
