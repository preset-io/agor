/**
 * React hook for updating the browser tab title based on the current board.
 *
 * When a board is selected, the tab title shows "{icon} {name}" (or just the name
 * if no icon is set). Resets to "Agor" when no board is active or on unmount.
 */

import type { Board } from '@agor/core/types';
import { useEffect } from 'react';

const DEFAULT_TITLE = 'Agor';

export function useBoardTitle(currentBoard: Board | undefined) {
  useEffect(() => {
    if (currentBoard?.icon && currentBoard?.name) {
      document.title = `${currentBoard.icon} ${currentBoard.name}`;
    } else if (currentBoard?.name) {
      document.title = currentBoard.name;
    } else {
      document.title = DEFAULT_TITLE;
    }

    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [currentBoard?.icon, currentBoard?.name]);
}
