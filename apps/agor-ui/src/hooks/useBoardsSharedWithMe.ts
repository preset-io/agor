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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnectionState } from '../contexts/ConnectionContext';
import {
  ACCESS_TTL_MS,
  failuresStillIn,
  peekAccess,
  readAccess,
  withoutFailure,
} from '../utils/accessCache';

const allowAll = () => true;
const NO_FAILURES: ReadonlySet<string> = new Set();

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

/** A board's sharing answer for the caller: pending until its policy read answers or fails. */
export type BoardSharingStatus = 'shared' | 'hidden' | 'pending' | 'failed';

const sharedAlways = (): BoardSharingStatus => 'shared';

/**
 * Whether a board reaches the caller through its policy rather than a role
 * bypass. Board lists are already policy-scoped for everyone except
 * superadmins, so only they pay one policy read per board, resolved with the
 * shared capability resolver and shared through the access cache. Unknown and
 * failed reads are not shared; a failed read is retried on the next mount,
 * board set or sign-in, and `retry` does so now. A new board set keeps the
 * failures still in it until their re-read answers. `settled` once every board
 * has an answer or a failed read.
 */
export function useBoardSharing(
  client: AgorClient | null,
  user: User | null | undefined,
  boardIds: readonly string[]
): {
  sharedWithMe: (boardId: string) => boolean;
  status: (boardId: string) => BoardSharingStatus;
  settled: boolean;
  retry: () => void;
} {
  const { authGeneration } = useConnectionState();
  const bypasses = hasMinimumRole(user?.role, ROLES.SUPERADMIN);
  const userId = user?.user_id;
  const scope = `${userId}:${authGeneration}`;
  const key = bypasses ? [...new Set(boardIds)].sort().join(',') : '';
  const [version, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState({ scope, key, ids: NO_FAILURES });
  // A failure stays shown until its re-read answers, so revealed cards never hide again.
  if (failed.scope === scope && failed.key !== key) {
    setFailed({ scope, key, ids: failuresStillIn(failed.ids, key) });
  }
  const failedIds = failed.scope === scope && failed.key === key ? failed.ids : NO_FAILURES;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the reads on retry; boardIds only orders the reads its sorted key names
  useEffect(() => {
    if (!client || !key || !userId) return;
    const controller = new AbortController();
    // Read in display order: cards reveal in order, so an early card mustn't queue behind later ones.
    for (const boardId of new Set(boardIds)) {
      readAccess(
        client,
        scope,
        `board:${boardId}`,
        () => boardPolicyGrantsView(client, scope, userId, boardId),
        { signal: controller.signal }
      ).then(
        () => {
          setVersion((v) => v + 1);
          setFailed((prev) => withoutFailure(prev, boardId));
        },
        () => {
          if (controller.signal.aborted) return;
          setFailed((prev) => ({
            scope,
            key,
            ids: new Set([...(prev.scope === scope && prev.key === key ? prev.ids : []), boardId]),
          }));
        }
      );
    }
    return () => controller.abort();
  }, [client, key, scope, userId, attempt]);
  const retry = useCallback(() => {
    setFailed({ scope, key, ids: NO_FAILURES });
    setAttempt((a) => a + 1);
  }, [scope, key]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version re-reads the cache after a read settles
  return useMemo(() => {
    if (!bypasses) return { sharedWithMe: allowAll, status: sharedAlways, settled: true, retry };
    const reading = !!client && !!userId && !!key;
    const status = (boardId: string): BoardSharingStatus => {
      const known = client ? peekAccess(client, scope, `board:${boardId}`) : undefined;
      if (known !== undefined) return known ? 'shared' : 'hidden';
      if (failedIds.has(boardId)) return 'failed';
      return reading ? 'pending' : 'hidden';
    };
    return {
      sharedWithMe: (boardId: string) => status(boardId) === 'shared',
      status,
      settled: !reading || key.split(',').every((id) => status(id) !== 'pending'),
      retry,
    };
  }, [bypasses, client, userId, scope, key, version, failedIds, retry]);
}

/** `useBoardSharing`'s predicate alone, for callers that needn't wait for it. */
export function useBoardsSharedWithMe(
  client: AgorClient | null,
  user: User | null | undefined,
  boardIds: readonly string[]
): (boardId: string) => boolean {
  return useBoardSharing(client, user, boardIds).sharedWithMe;
}
