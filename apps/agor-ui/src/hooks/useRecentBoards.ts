import type { Board } from '@agor-live/client';
import { useCallback, useMemo } from 'react';
import {
  migrateLegacyLocalStorageJson,
  readLocalStorageJson,
  writeLocalStorageJson,
} from './localStorageJson';
import { useLocalStorage, writeSharedLocalStorageJson } from './useLocalStorage';
import { userStorageKey } from './useUserLocalStorage';

const MAX_RECENT = 10;
const NO_RECENT: string[] = [];

/** Visit history is per signed-in user, never shared by everyone on the browser. */
export const recentBoardsStorageKey = (userId: string | undefined) =>
  userStorageKey(userId, 'recentBoardIds');

/** Moves the shared pre-per-user history once to the first signed-in user without their own. */
function migrateLegacyRecentBoards(userId: string | undefined): void {
  if (!userId) return;
  migrateLegacyLocalStorageJson('agor:recentBoardIds', (legacy) => {
    const ids = Array.isArray(legacy)
      ? legacy.filter((id): id is string => typeof id === 'string').slice(0, MAX_RECENT)
      : [];
    const key = recentBoardsStorageKey(userId);
    if (!ids.length || readLocalStorageJson<string[]>(key, NO_RECENT).length > 0) return true;
    return writeLocalStorageJson(key, ids);
  });
}

/**
 * Records board visits in the signed-in user's history without subscribing to it; a no-op
 * until there is a user, so nothing lands in the shared `anonymous` key.
 */
export function useTrackBoardVisit(userId: string | undefined): (boardId: string) => void {
  // Before the first read or write, so the moved history is what a visit prepends to.
  migrateLegacyRecentBoards(userId);
  return useCallback(
    (boardId: string) => {
      if (!userId) return;
      const key = recentBoardsStorageKey(userId);
      const stored = readLocalStorageJson<unknown>(key, NO_RECENT);
      const prev = Array.isArray(stored) ? stored.filter((id) => id !== boardId) : NO_RECENT;
      writeSharedLocalStorageJson(key, [boardId, ...prev].slice(0, MAX_RECENT));
    },
    [userId]
  );
}

/**
 * Hook for tracking the signed-in user's recently visited boards in localStorage.
 * Returns the recent board objects (excluding the current board) and a function to track visits.
 */
export function useRecentBoards(
  boards: Board[],
  currentBoardId: string,
  userId: string | undefined
): {
  recentBoards: Board[];
  recentBoardIds: string[];
  trackBoardVisit: (boardId: string) => void;
} {
  // Migrates before any instance reads storage, so every instance (App, AppHeader, board pages) sees the moved history.
  const trackBoardVisit = useTrackBoardVisit(userId);
  const [recentIds] = useLocalStorage<string[]>(recentBoardsStorageKey(userId), NO_RECENT);

  const recentBoards = useMemo(() => {
    const boardMap = new Map<string, Board>(boards.map((b) => [b.board_id, b]));
    return recentIds
      .filter((id) => id !== currentBoardId && boardMap.has(id))
      .map((id) => boardMap.get(id)!)
      .slice(0, 3);
  }, [recentIds, currentBoardId, boards]);

  return { recentBoards, recentBoardIds: recentIds, trackBoardVisit };
}
