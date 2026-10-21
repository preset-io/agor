import type { BoardView } from '@agor-live/client';
import { createContext, useContext } from 'react';
import type { BoardPreviewTarget, OpenPreviewOptions } from '../hooks/useBoardPreview';

/**
 * The board tab on screen and the preview beside it, for components inside the
 * board's main area, so App passes no tab props through them. Separate from
 * `AppActionsContext`, which carries only identity-stable handlers: `view` and
 * `previewTarget` change often. The preview's size and full screen are not here,
 * so resizing the pane re-renders nothing that reads this.
 */
export interface BoardViewContextValue {
  view: BoardView;
  /** Shows the Board tab, pans to the branch card, outlines it and anchors a tip. */
  showOnBoard: (branchId: string) => void;
  /** What the preview shows; null while nothing is previewed. Kept on Board, where the pane is hidden. */
  previewTarget: BoardPreviewTarget | null;
  /** Opens the item in the preview, swapping out whatever it showed. */
  openPreview: (target: BoardPreviewTarget, options?: OpenPreviewOptions) => void;
  closePreview: () => void;
  /**
   * Opens a conversation from the preview so it is seen: leaves full screen, or
   * closes the preview when the window is too narrow to show both.
   */
  openConversation: (sessionId: string) => void;
}

export const BoardViewContext = createContext<BoardViewContextValue | null>(null);

/** Null outside a board's main area (Home, mobile). */
export const useBoardViewContext = () => useContext(BoardViewContext);
