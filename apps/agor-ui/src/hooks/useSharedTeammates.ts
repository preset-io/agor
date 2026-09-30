import type { AgorClient, User } from '@agor-live/client';
import { useMemo } from 'react';
import { agorStore, shallow, useStoreWithEqualityFn } from '../store/agorStore';
import { makeTeammatesSelector } from '../store/selectors';
import { useBoardSharing } from './useBoardsSharedWithMe';

/**
 * Others' teammates whose home board reaches the caller through its policy.
 * `settled` once every board's policy answer is in (only superadmins wait).
 */
export function useSharedTeammates(client: AgorClient | null, user: User | null | undefined) {
  const candidates = useStoreWithEqualityFn(
    agorStore,
    useMemo(() => makeTeammatesSelector(user?.user_id, 'shared'), [user?.user_id]),
    shallow
  );
  const boardIds = useMemo(() => candidates.map((b) => b.board_id ?? ''), [candidates]);
  const { sharedWithMe, settled } = useBoardSharing(client, user, boardIds);
  const teammates = useMemo(
    () => candidates.filter((branch) => sharedWithMe(branch.board_id ?? '')),
    [candidates, sharedWithMe]
  );
  return { teammates, settled };
}
