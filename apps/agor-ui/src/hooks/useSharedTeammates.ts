import type { AgorClient, Branch, User } from '@agor-live/client';
import { useMemo } from 'react';
import { agorStore, shallow, useStoreWithEqualityFn } from '../store/agorStore';
import { makeTeammatesSelector } from '../store/selectors';
import { useBoardSharing } from './useBoardsSharedWithMe';

/**
 * Others' teammates whose home board reaches the caller through its policy.
 * `settled` once every board's policy answer is in (only superadmins wait).
 * A teammate shows once none before it is still pending, so answers mostly
 * append; a failed one doesn't hold later ones back, so one that answers on a
 * retry can appear above them. `failed` counts teammates whose policy read
 * failed; `retry` reads them again, keeping them failed (not pending) until
 * they answer, `retrying` meanwhile.
 */
export function useSharedTeammates(client: AgorClient | null, user: User | null | undefined) {
  const candidates = useStoreWithEqualityFn(
    agorStore,
    useMemo(() => makeTeammatesSelector(user?.user_id, 'shared'), [user?.user_id]),
    shallow
  );
  const boardIds = useMemo(() => candidates.map((b) => b.board_id ?? ''), [candidates]);
  const { status, settled, retry, retrying } = useBoardSharing(client, user, boardIds);
  return useMemo(() => {
    const teammates: Branch[] = [];
    let failed = 0;
    let waiting = false;
    for (const branch of candidates) {
      const answer = status(branch.board_id ?? '');
      if (answer === 'failed') failed++;
      else if (answer === 'pending') waiting = true;
      else if (answer === 'shared' && !waiting) teammates.push(branch);
    }
    return { teammates, settled, failed, retry, retrying };
  }, [candidates, status, settled, retry, retrying]);
}
