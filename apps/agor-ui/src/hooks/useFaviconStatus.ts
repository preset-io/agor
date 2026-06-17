/**
 * React hook for updating favicon based on session activity
 *
 * Updates favicon with dot overlays to indicate status:
 * - White dot (lower-left): Agent actively working
 * - Green dot (lower-right): Ready for prompt (completed work, needs attention)
 * - No dots: Nothing active on current board
 */

import type { BoardEntityObject, Session } from '@agor-live/client';
import { SessionStatus } from '@agor-live/client';
import { theme } from 'antd';
import { useEffect, useState } from 'react';
import { brandMarkHref } from '../branding/brand';
import { createFaviconWithDot } from '../utils/faviconDot';

export function useFaviconStatus(
  currentBoardId: string | null,
  sessionsByBranch: Map<string, Session[]>,
  boardObjectsForCurrentBoard: BoardEntityObject[]
) {
  const [baseFaviconUrl] = useState(brandMarkHref());
  const { token } = theme.useToken();

  useEffect(() => {
    // createFaviconWithDot is async (it decodes an <img> and rasterizes to a
    // canvas). If it resolves after this effect re-runs or the Workspace shell
    // unmounts (e.g. navigating to a static surface that pins its own favicon),
    // applying the stale result would clobber the new favicon. Guard with a
    // cancellation flag cleared on cleanup.
    let cancelled = false;
    const applyFavicon = (dataUrl: string) => {
      if (cancelled) return;
      const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
      if (link) {
        link.href = dataUrl;
      }
    };

    if (!currentBoardId) {
      // No board selected - restore default favicon
      createFaviconWithDot(baseFaviconUrl, false, false, token.colorSuccessText).then(applyFavicon);
      return () => {
        cancelled = true;
      };
    }

    const branchesOnBoard = new Set(
      boardObjectsForCurrentBoard.filter((obj) => obj.branch_id).map((obj) => obj.branch_id!)
    );

    // Find sessions for those branches using O(1) Map lookups
    const sessionsOnBoard = Array.from(branchesOnBoard)
      .flatMap((branchId) => sessionsByBranch.get(branchId!) || [])
      .filter((s) => !s.archived);

    // Determine status: check for running and ready independently
    // Use .some() for efficient short-circuiting
    const hasRunning = sessionsOnBoard.some((session) => session.status === SessionStatus.RUNNING);

    const hasReady = sessionsOnBoard.some((session) => session.ready_for_prompt);

    // Update favicon with appropriate dots
    // White dot (lower-left) for running, green dot (lower-right) for ready
    createFaviconWithDot(baseFaviconUrl, hasRunning, hasReady, token.colorSuccessText).then(
      applyFavicon
    );

    return () => {
      cancelled = true;
    };
  }, [
    currentBoardId,
    sessionsByBranch,
    boardObjectsForCurrentBoard,
    baseFaviconUrl,
    token.colorSuccessText,
  ]);
}
