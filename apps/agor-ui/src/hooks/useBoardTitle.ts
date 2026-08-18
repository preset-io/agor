/**
 * React hook for updating the browser tab title based on the current board.
 *
 * Shows the board name when one is selected, else resets to "Agor" when no
 * board is active or on unmount. The board icon is intentionally omitted from
 * the browser title.
 */

import type { Board } from '@agor-live/client';
import { useEffect } from 'react';
import { surfaceTitle } from '../branding/brand';

const DEFAULT_TITLE = surfaceTitle();

export function useBoardTitle(currentBoard: Board | undefined) {
  useEffect(() => {
    document.title = currentBoard?.name || DEFAULT_TITLE;

    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [currentBoard?.name]);
}
