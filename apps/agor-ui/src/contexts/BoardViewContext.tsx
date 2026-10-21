import type { BoardView } from '@agor-live/client';
import { createContext, useContext } from 'react';

/**
 * The board tab on screen, for components inside the board's main area, so
 * App passes no tab props through them. Separate from `AppActionsContext`,
 * which carries only identity-stable handlers: `view` changes on a switch.
 */
export interface BoardViewContextValue {
  view: BoardView;
  /** Shows the Board tab, pans to the branch card, outlines it and anchors a tip. */
  showOnBoard: (branchId: string) => void;
}

export const BoardViewContext = createContext<BoardViewContextValue | null>(null);

/** Null outside a board's main area (Home, mobile). */
export const useBoardViewContext = () => useContext(BoardViewContext);
