import type { Board } from '@agor-live/client';
import { useCallback, useMemo } from 'react';
import { useLocalStorage } from './useLocalStorage';

const STORAGE_KEY = 'agor:recentBoardIds';
const MAX_RECENT = 10;

/**
 * Hook for tracking recently visited boards in localStorage.
 * Returns the recent board objects (excluding the current board) and a function to track visits.
 */
export function useRecentBoards(
  boards: Board[],
  currentBoardId: string
): {
  recentBoards: Board[];
  trackBoardVisit: (boardId: string) => void;
} {
  const [recentIds, setRecentIds] = useLocalStorage<string[]>(STORAGE_KEY, []);

  const trackBoardVisit = useCallback(
    (boardId: string) => {
      setRecentIds((prev) => {
        const filtered = prev.filter((id) => id !== boardId);
        return [boardId, ...filtered].slice(0, MAX_RECENT);
      });
    },
    [setRecentIds]
  );

  const recentBoards = useMemo(() => {
    const boardMap = new Map<string, Board>(boards.map((b) => [b.board_id, b]));
    return recentIds
      .filter((id) => id !== currentBoardId && boardMap.has(id))
      .map((id) => boardMap.get(id)!)
      .slice(0, 3);
  }, [recentIds, currentBoardId, boards]);

  return { recentBoards, trackBoardVisit };
}
