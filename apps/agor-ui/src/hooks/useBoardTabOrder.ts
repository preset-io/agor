import {
  type AgorClient,
  type Board,
  type BoardView,
  resolveBoardTabOrder,
} from '@agor-live/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatActionError } from '../utils/connectionErrors';
import { useThemedMessage } from '../utils/message';

/** The one write path for a board's tab order: a narrow patch that changes only that key. */
export function saveBoardTabOrder(client: AgorClient, boardId: string, order: BoardView[]) {
  return client
    .service('boards')
    .patch(boardId, { _action: 'setTabOrder', tab_order: order } as unknown as Partial<Board>);
}

interface RequestedOrder {
  boardId: string;
  order: BoardView[];
}

/**
 * A board's shared tab order with an optimistic local copy while a reorder
 * saves. Saves run one at a time and each board's latest requested order is
 * sent last, so a quick reverse move wins. Other people's reorders arrive
 * through `boards patched` and replace the local copy once our saves are done.
 */
export function useBoardTabOrder(client: AgorClient | null, board: Board | null | undefined) {
  const { showError } = useThemedMessage();
  const boardId = board?.board_id ?? null;
  const storedKey = resolveBoardTabOrder(board).join(',');
  const [optimistic, setOptimistic] = useState<RequestedOrder | null>(null);
  // The latest order not yet sent, per board.
  const pendingRef = useRef(new Map<string, BoardView[]>());
  const savingRef = useRef(false);
  const storedRef = useRef('');
  storedRef.current = `${boardId}:${storedKey}`;

  // A new stored order (ours or someone else's) is the truth again, unless a save of ours is still running.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the stored order changes.
  useEffect(() => {
    if (!savingRef.current) setOptimistic(null);
  }, [storedKey, boardId]);

  const stored = useMemo(() => storedKey.split(',') as BoardView[], [storedKey]);
  const order = optimistic && optimistic.boardId === boardId ? optimistic.order : stored;
  const orderRef = useRef(order);
  orderRef.current = order;

  const setOrder = useCallback(
    async (next: BoardView[]) => {
      // Compared with what is on screen (the optimistic order), not the stored one.
      if (!client || !boardId || next.join(',') === orderRef.current.join(',')) return;
      const pending = pendingRef.current;
      pending.set(boardId, next);
      setOptimistic({ boardId, order: next });
      if (savingRef.current) return; // The running loop sends it next.
      savingRef.current = true;
      try {
        let storedAtLastSend = storedRef.current;
        // Map iteration also visits orders queued while a save runs.
        for (const [id, queued] of pending) {
          pending.delete(id);
          storedAtLastSend = storedRef.current;
          await saveBoardTabOrder(client, id, queued);
        }
        // The stored order changed while our last save ran (another editor's reorder or our own
        // echo), so it is the truth now that our saves are done.
        if (storedRef.current !== storedAtLastSend) setOptimistic(null);
      } catch (error) {
        setOptimistic(null);
        showError(formatActionError('change the tab order', error, { idempotent: true }));
      } finally {
        savingRef.current = false;
        pending.clear();
      }
    },
    [boardId, client, showError]
  );

  return { order, setOrder };
}
