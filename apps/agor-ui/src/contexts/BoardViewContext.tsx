import type { BoardView } from '@agor-live/client';
import { createContext, useContext } from 'react';
import type {
  BoardPreviewState,
  BoardPreviewTarget,
  OpenPreviewOptions,
} from '../hooks/useBoardPreview';

/**
 * The board tab on screen and the preview beside it, for components inside the
 * board's main area, so App passes no tab props through them. Separate from
 * `AppActionsContext`, which carries only identity-stable handlers: `view` and
 * `preview` change often.
 */
export interface BoardViewContextValue {
  view: BoardView;
  /**
   * The phone pages, which have no board tabs: previews open as a bottom sheet
   * and the session page keeps its own layout (branch strip and menu).
   */
  mobile?: boolean;
  /** Shows the Board tab, pans to the branch or artifact card, outlines it and anchors a tip. */
  showOnBoard: (id: string, kind?: 'branch' | 'artifact') => void;
  /** Null while nothing is previewed. Kept on Board, where the pane is hidden. */
  preview: BoardPreviewState | null;
  /** Opens the item in the preview, swapping out whatever it showed. */
  openPreview: (target: BoardPreviewTarget, options?: OpenPreviewOptions) => void;
  closePreview: () => void;
  /** Opens a conversation in Chat (for this visit), keeping the preview. */
  openConversation: (sessionId: string) => void;
}

export const BoardViewContext = createContext<BoardViewContextValue | null>(null);

/** Null outside a board's main area and the phone's board pages (Home). */
export const useBoardViewContext = () => useContext(BoardViewContext);
