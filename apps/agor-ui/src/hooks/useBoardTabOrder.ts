import {
  type AgorClient,
  type Board,
  type BoardView,
  resolveBoardTabOrder,
} from '@agor-live/client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatActionError } from '../utils/connectionErrors';
import { useThemedMessage } from '../utils/message';

/** The one write path for a board's tab order: a narrow patch that changes only that key. */
export function saveBoardTabOrder(client: AgorClient, boardId: string, order: BoardView[]) {
  return client
    .service('boards')
    .patch(boardId, { _action: 'setTabOrder', tab_order: order } as unknown as Partial<Board>);
}

/**
 * A board's shared tab order with an optimistic local copy while a reorder
 * saves. Other people's reorders arrive through `boards patched` and replace it.
 */
export function useBoardTabOrder(client: AgorClient | null, board: Board | null | undefined) {
  const { showError } = useThemedMessage();
  const boardId = board?.board_id ?? null;
  const storedKey = resolveBoardTabOrder(board).join(',');
  const [optimistic, setOptimistic] = useState<{ boardId: string; order: BoardView[] } | null>(
    null
  );

  // Any new stored order (ours or someone else's) is the truth again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the stored order changes.
  useEffect(() => setOptimistic(null), [storedKey, boardId]);

  const stored = useMemo(() => storedKey.split(',') as BoardView[], [storedKey]);
  const order = optimistic && optimistic.boardId === boardId ? optimistic.order : stored;

  const setOrder = useCallback(
    async (next: BoardView[]) => {
      if (!client || !boardId || next.join(',') === storedKey) return;
      setOptimistic({ boardId, order: next });
      try {
        await saveBoardTabOrder(client, boardId, next);
      } catch (error) {
        setOptimistic(null);
        showError(formatActionError('change the tab order', error, { idempotent: true }));
      }
    },
    [boardId, client, showError, storedKey]
  );

  return { order, setOrder };
}
