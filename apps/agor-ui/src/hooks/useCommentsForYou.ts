import type { AgorClient, User } from '@agor-live/client';
import { useMemo } from 'react';
import { useAgorStore } from '../store/agorStore';
import { makeCommentsForYouSelector } from '../store/selectors';
import { useBoardsSharedWithMe } from './useBoardsSharedWithMe';

/** Comment threads that need the caller, leaving out boards a superadmin sees only by role. */
export function useCommentsForYou(client: AgorClient | null, user: User | null | undefined) {
  const all = useAgorStore(
    useMemo(
      () =>
        makeCommentsForYouSelector({
          userId: user?.user_id,
          userName: user?.name,
          userEmail: user?.email,
        }),
      [user?.user_id, user?.name, user?.email]
    )
  );
  const boardIds = useMemo(() => all.map((c) => c.boardId), [all]);
  const sharedWithMe = useBoardsSharedWithMe(client, user, boardIds);
  return useMemo(() => all.filter((c) => sharedWithMe(c.boardId)), [all, sharedWithMe]);
}
