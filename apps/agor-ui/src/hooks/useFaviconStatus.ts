/**
 * React hook for updating favicon based on session activity
 *
 * Updates favicon with dot overlays to indicate status:
 * - White dot (lower-left): Agent actively working
 * - Green dot (lower-right): Ready for prompt (completed work, needs attention)
 * - No dots: Nothing active on current board
 */

import type { BoardEntityObject, Session, Task } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { theme } from 'antd';
import { useEffect, useState } from 'react';
import { createFaviconWithDot } from '../utils/faviconDot';

export function useFaviconStatus(
  currentBoardId: string | null,
  sessions: Session[],
  tasks: Record<string, Task[]>,
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

    // Find sessions for those worktrees
    const sessionsOnBoard = sessions.filter(
      (s) => worktreesOnBoard.has(s.worktree_id) && !s.archived
    );

    // Determine status: check for running and ready independently
    let hasRunning = false;
    let hasReady = false;

    for (const session of sessionsOnBoard) {
      // Check if session has running tasks
      const sessionTasks = tasks[session.session_id] || [];
      const isRunning =
        sessionTasks.some((t) => t.status === 'running') ||
        session.status === SessionStatus.RUNNING;

      if (isRunning) {
        hasRunning = true;
      }

      // Check if session is ready for prompt
      if (session.ready_for_prompt) {
        hasReady = true;
      }

      // Both states can be true simultaneously, so don't break early
    }

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
  }, [currentBoardId, sessions, tasks, boardObjects, baseFaviconUrl, token.colorSuccessText]);
}
