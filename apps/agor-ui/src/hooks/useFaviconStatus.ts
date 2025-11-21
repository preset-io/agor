/**
 * React hook for updating favicon based on session activity
 *
 * Updates favicon with dot overlays to indicate status:
 * - White dot (lower-left): Agent actively working
 * - Green dot (lower-right): Ready for prompt (completed work, needs attention)
 * - No dots: Nothing active on current board
 */

import type { BoardEntityObject, Session } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { theme } from 'antd';
import { useEffect, useState } from 'react';
import { createFaviconWithDot } from '../utils/faviconDot';

export function useFaviconStatus(
  currentBoardId: string | null,
  sessionsByWorktree: Map<string, Session[]>,
  boardObjects: BoardEntityObject[]
) {
  const [baseFaviconUrl] = useState('/favicon.png');
  const { token } = theme.useToken();

  useEffect(() => {
    if (!currentBoardId) {
      // No board selected - restore default favicon
      createFaviconWithDot(baseFaviconUrl, false, false, token.colorSuccessText).then((dataUrl) => {
        const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
        if (link) {
          link.href = dataUrl;
        }
      });
      return;
    }

    // Find worktrees on current board
    const worktreesOnBoard = new Set(
      boardObjects.filter((obj) => obj.board_id === currentBoardId).map((obj) => obj.worktree_id)
    );

    // Find sessions for those worktrees using O(1) Map lookups
    const sessionsOnBoard = Array.from(worktreesOnBoard)
      .flatMap((worktreeId) => sessionsByWorktree.get(worktreeId) || [])
      .filter((s) => !s.archived);

    // Determine status: check for running and ready independently
    // Use .some() for efficient short-circuiting
    const hasRunning = sessionsOnBoard.some((session) => session.status === SessionStatus.RUNNING);

    const hasReady = sessionsOnBoard.some((session) => session.ready_for_prompt);

    // Update favicon with appropriate dots
    // White dot (lower-left) for running, green dot (lower-right) for ready
    createFaviconWithDot(baseFaviconUrl, hasRunning, hasReady, token.colorSuccessText).then(
      (dataUrl) => {
        const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
        if (link) {
          link.href = dataUrl;
        }
      }
    );
  }, [currentBoardId, sessionsByWorktree, boardObjects, baseFaviconUrl, token.colorSuccessText]);
}
