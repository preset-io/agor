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
 * saves. Saves run one at a time and the latest requested order is sent last,
 * so a quick reverse move wins. Other people's reorders arrive through
 * `boards patched` and replace the local copy once our saves are done.
 */
export function useBoardTabOrder(client: AgorClient | null, board: Board | null | undefined) {
  const { showError } = useThemedMessage();
  const boardId = board?.board_id ?? null;
  const storedKey = resolveBoardTabOrder(board).join(',');
  const [optimistic, setOptimistic] = useState<RequestedOrder | null>(null);
  const latestRef = useRef<RequestedOrder | null>(null);
  const savingRef = useRef(false);

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
      const requested = { boardId, order: next };
      latestRef.current = requested;
      setOptimistic(requested);
      if (savingRef.current) return; // The running loop sends it next.
      savingRef.current = true;
      try {
        let sent: RequestedOrder | null = null;
        while (latestRef.current !== sent) {
          sent = latestRef.current as RequestedOrder;
          await saveBoardTabOrder(client, sent.boardId, sent.order);
        }
      } catch (error) {
        setOptimistic(null);
        showError(formatActionError('change the tab order', error, { idempotent: true }));
      } finally {
        savingRef.current = false;
        latestRef.current = null;
      }
    },
    [boardId, client, showError]
  );

  return { order, setOrder };
}
