/**
 * React hook for updating favicon based on session activity
 *
 * Updates favicon with colored dot overlays to indicate status:
 * - Green dot: Sessions ready for prompt (completed work, needs attention)
 * - Orange dot: Sessions actively running
 * - No dot: No active sessions
 */

import type { BoardEntityObject, Session, Task } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { useEffect, useState } from 'react';
import { createFaviconWithDot } from '../utils/faviconDot';

export function useFaviconStatus(
  currentBoardId: string | null,
  sessions: Session[],
  tasks: Record<string, Task[]>,
  boardObjects: BoardEntityObject[]
) {
  const [baseFaviconUrl] = useState('/favicon.png');

  useEffect(() => {
    if (!currentBoardId) {
      // No board selected - restore default favicon
      createFaviconWithDot(baseFaviconUrl, null).then((dataUrl) => {
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

    // Determine status priority: running > ready > idle
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
        break; // Running takes priority
      }

      // Check if session is ready for prompt
      if (session.ready_for_prompt) {
        hasReady = true;
      }
    }

    // Update favicon with appropriate dot
    // Orange for running, green for ready, no dot for idle
    const dotColor = hasRunning ? 'orange' : hasReady ? 'green' : null;

    createFaviconWithDot(baseFaviconUrl, dotColor).then((dataUrl) => {
      const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
      if (link) {
        link.href = dataUrl;
      }
    });
  }, [currentBoardId, sessions, tasks, boardObjects, baseFaviconUrl]);
}
