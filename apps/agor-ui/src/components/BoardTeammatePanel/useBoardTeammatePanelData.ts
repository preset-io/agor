import type { Board, User } from '@agor-live/client';
import { useMemo } from 'react';
import { useAgorStore } from '../../store/agorStore';
import {
  makeBranchSelector,
  makeCommentMentionSelector,
  makeRepoSelector,
  makeUnreadCommentCountSelector,
} from '../../store/selectors';

/**
 * Store-derived inputs of `BoardTeammatePanel` (and the desktop rail) for one
 * board, shared by the desktop and mobile shells. Comment badges subscribe to
 * the derived number/boolean, not the comment map, so comment edits that don't
 * change them (and comments on other boards) don't wake the caller.
 */
export function useBoardTeammatePanelData(
  board: Board | null | undefined,
  user: User | null | undefined,
  boardReady: boolean
) {
  const boardId = board?.board_id;
  const primaryTeammateId = board?.primary_teammate_id ?? null;
  const primaryTeammateBranch = useAgorStore(
    useMemo(() => makeBranchSelector(primaryTeammateId), [primaryTeammateId])
  );
  const primaryTeammateRepoId = primaryTeammateBranch?.repo_id;
  const primaryTeammateRepo = useAgorStore(
    useMemo(() => makeRepoSelector(primaryTeammateRepoId), [primaryTeammateRepoId])
  );
  // Until the partition is loaded, a missing teammate branch means "not loaded", not "no access" (I1).
  const primaryTeammateInaccessible = Boolean(
    primaryTeammateId && !primaryTeammateBranch && boardReady
  );

  const userName = user?.name || user?.email?.split('@')[0] || undefined;
  const unreadCommentsCount = useAgorStore(
    useMemo(() => makeUnreadCommentCountSelector(boardId), [boardId])
  );
  const hasUserMentions = useAgorStore(
    useMemo(
      () => makeCommentMentionSelector(boardId, userName, user?.email),
      [boardId, userName, user?.email]
    )
  );

  return {
    primaryTeammateId,
    primaryTeammateBranch,
    primaryTeammateRepo,
    primaryTeammateInaccessible,
    unreadCommentsCount,
    hasUserMentions,
  };
}
