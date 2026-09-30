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
  accessScope,
  failuresStillIn,
  peekAccess,
  readAccess,
  withoutFailure,
} from '../utils/accessCache';

const allowAll = () => true;
const NO_FAILURES: ReadonlySet<string> = new Set();

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
  const scope = accessScope(user, authGeneration);
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
    // Requested before the board reads, so it holds a read slot ahead of every read awaiting it.
    const groupIds = readAccess(client, scope, `groups:${userId}`, () =>
      activeGroupIds(client, userId)
    );
    groupIds.catch(() => {});
    // Read in display order: cards reveal in order, so an early card mustn't queue behind later ones.
    for (const boardId of new Set(boardIds)) {
      readAccess(
        client,
        scope,
        `board:${boardId}`,
        () => boardPolicyGrantsView(client, userId, boardId, groupIds),
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
