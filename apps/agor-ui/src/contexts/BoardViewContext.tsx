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
  /**
   * Null on the phone pages, which have no board tabs: previews open as a bottom
   * sheet and the session page keeps its own layout (branch strip and menu).
   */
  view: BoardView | null;
  /** Shows the Board tab, pans to the branch or artifact card, outlines it and anchors a tip. */
  showOnBoard: (id: string, kind?: 'branch' | 'artifact') => void;
  /** What the preview shows; null while nothing is previewed. Kept on Board, where the pane is hidden. */
  previewTarget: BoardPreviewTarget | null;
  /** Opens the item in the preview, swapping out whatever it showed. */
  openPreview: (target: BoardPreviewTarget, options?: OpenPreviewOptions) => void;
  closePreview: () => void;
  /**
   * Opens a conversation from the preview or Files so it is seen: shows Chat for
   * this visit, and leaves full screen, or closes the preview when the window is
   * too narrow to show both.
   */
  openConversation: (sessionId: string) => void;
}

export const BoardViewContext = createContext<BoardViewContextValue | null>(null);

/** Null outside a board's main area and the phone's board pages (Home). */
export const useBoardViewContext = () => useContext(BoardViewContext);
