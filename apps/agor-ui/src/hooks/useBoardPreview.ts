import type { BranchID, SessionID } from '@agor-live/client';
import { useRef, useState } from 'react';
import { useStableCallback } from './useStableCallback';

/**
 * What the board's preview pane shows. Branch details is the only kind so far.
 * Each open is a new object, which is how the pane knows to take focus.
 */
export type BoardPreviewTarget = {
  kind: 'branch';
  id: BranchID;
  /** The conversation it was opened from, if any. */
  fromSessionId?: SessionID;
};

export interface BoardPreviewState {
  target: BoardPreviewTarget;
  fullScreen: boolean;
}

export interface OpenPreviewOptions {
  /** Where focus returns on close. Defaults to the element focused at open time. */
  returnFocus?: HTMLElement | null;
}

/**
 * The preview beside the main area: one item at a time, kept per board and
 * dropped when the board changes. Not persisted. Opening another item swaps it
 * in place. `returnFocusRef` holds whatever opened it, for the pane to return
 * focus to on close.
 */
export function useBoardPreview(boardId: string) {
  const [state, setState] = useState<(BoardPreviewState & { boardId: string }) | null>(null);
  // Hidden in the render the board changes in, and dropped, so going back does not bring it back.
  if (state && state.boardId !== boardId) setState(null);
  const preview = state && state.boardId === boardId ? state : null;
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const openPreview = useStableCallback(
    (target: BoardPreviewTarget, options: OpenPreviewOptions = {}) => {
      const focused = document.activeElement;
      returnFocusRef.current =
        options.returnFocus ??
        (focused instanceof HTMLElement && focused !== document.body ? focused : null);
      setState((prev) => ({
        boardId,
        target,
        // A swap keeps the pane as it is.
        fullScreen: prev?.boardId === boardId ? prev.fullScreen : false,
      }));
    }
  );

  const closePreview = useStableCallback(() => setState(null));

  const setPreviewFullScreen = useStableCallback((fullScreen: boolean) => {
    setState((prev) => (prev && prev.fullScreen !== fullScreen ? { ...prev, fullScreen } : prev));
  });

  return { preview, returnFocusRef, openPreview, closePreview, setPreviewFullScreen };
}
