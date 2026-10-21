import type { BoardView } from '@agor-live/client';
import { AppstoreOutlined, FolderOutlined, MessageOutlined } from '@ant-design/icons';
import type React from 'react';

/** The tabs this build shows, in any stored order. */
export const AVAILABLE_BOARD_VIEWS: readonly BoardView[] = ['chat', 'board', 'files'];

export const BOARD_VIEW_LABELS: Record<BoardView, string> = {
  chat: 'Chat',
  board: 'Board',
  files: 'Files',
};

export const BOARD_VIEW_ICONS: Record<BoardView, React.ReactNode> = {
  chat: <MessageOutlined />,
  board: <AppstoreOutlined />,
  files: <FolderOutlined />,
};

/** The views to draw, in the board's order. */
export const availableBoardViews = (order: readonly BoardView[]): BoardView[] =>
  order.filter((view) => AVAILABLE_BOARD_VIEWS.includes(view));

/**
 * Moves `view` by `delta` places among the shown views. Views that are not
 * shown keep their slots, so the full order always stays a permutation.
 */
export function moveBoardView(
  order: readonly BoardView[],
  view: BoardView,
  delta: number
): BoardView[] {
  const shown = availableBoardViews(order);
  const from = shown.indexOf(view);
  const to = Math.min(shown.length - 1, Math.max(0, from + delta));
  if (from < 0 || from === to) return [...order];
  shown.splice(from, 1);
  shown.splice(to, 0, view);
  let next = 0;
  return order.map((item) => (AVAILABLE_BOARD_VIEWS.includes(item) ? shown[next++] : item));
}

/** Alt + Left / Right on a focused tab moves it; any other key is not a move. */
export function boardViewMoveForKey(event: Pick<KeyboardEvent, 'altKey' | 'key'>): -1 | 1 | null {
  if (!event.altKey) return null;
  if (event.key === 'ArrowLeft') return -1;
  if (event.key === 'ArrowRight') return 1;
  return null;
}
