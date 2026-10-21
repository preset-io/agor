import type { BoardView } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readLocalStorageJson } from './localStorageJson';
import { userStorageKey, useUserLocalStorage } from './useUserLocalStorage';

interface BoardViewVisit {
  boardId: string;
  view: BoardView;
}

/**
 * Which board tab is on screen. A tab row pick is remembered per user per
 * board; every other jump (Show on board, deep links, "go to card") is a
 * visit that lasts until the board changes or the person picks a tab.
 *
 * `order` is the board's shown tab order; its first tab is where people land
 * the first time, or when their picked tab is no longer shown.
 */
export function useBoardView({
  userId,
  boardId,
  order,
}: {
  userId: string | null | undefined;
  boardId: string | null;
  order: readonly BoardView[];
}) {
  const key = `board-view:${boardId}`;
  const [stored, setPicked] = useUserLocalStorage<BoardView | null>(
    boardId ? userId : null,
    key,
    null
  );
  // The storage hook adopts a new key's value one effect late. Read it now so a
  // board switch never renders, or acts on, the previous board's tab.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stored` changes on every write, so the read follows it.
  const picked = useMemo(
    () =>
      boardId && userId
        ? readLocalStorageJson<BoardView | null>(userStorageKey(userId, key), null)
        : null,
    [boardId, userId, key, stored]
  );

  const [visit, setVisit] = useState<BoardViewVisit | null>(null);
  const pickedShown = !!picked && order.includes(picked);
  const landingRef = useRef({ pickedShown, first: order[0] });
  landingRef.current = { pickedShown, first: order[0] };
  // A visit belongs to its board; one made for the board being opened survives.
  // Without a pick, the first tab is where this visit lands, so an editor
  // moving another tab first later changes nothing on screen.
  useEffect(() => {
    setVisit((current) => {
      if (current?.boardId === boardId) return current;
      const { pickedShown: hasPick, first } = landingRef.current;
      return boardId && !hasPick && first ? { boardId, view: first } : null;
    });
  }, [boardId]);

  const visitView = visit && visit.boardId === boardId ? visit.view : null;
  const view =
    (visitView && order.includes(visitView) ? visitView : null) ??
    (pickedShown ? picked : null) ??
    order[0] ??
    'board';

  const pick = useCallback(
    (next: BoardView) => {
      setVisit(null);
      setPicked(next);
    },
    [setPicked]
  );

  /** Shows `next` for this visit only. `forBoardId` is the board being opened, if not this one. */
  const visit_ = useCallback(
    (next: BoardView, forBoardId?: string | null) => {
      const target = forBoardId ?? boardId;
      if (target) setVisit({ boardId: target, view: next });
    },
    [boardId]
  );

  return { view, pick, visit: visit_ };
}
