import type { BranchID } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { useStableCallback } from './useStableCallback';

/** What the board's preview pane shows. Branch details is the only kind so far. */
export type BoardPreviewTarget = { kind: 'branch'; id: BranchID };

export interface BoardPreviewState {
  target: BoardPreviewTarget;
  fullScreen: boolean;
  /** Changes on every open, so the pane takes focus once per open, not on every remount. */
  openId: number;
}

export interface OpenPreviewOptions {
  /** Where Close and Escape return focus. Defaults to the element focused at open time. */
  returnFocus?: HTMLElement | null;
}

/**
 * The preview beside the main area: one item at a time, kept per board and
 * dropped when the board changes. Not persisted. Opening another item swaps it
 * in place; Close returns focus to whatever opened it.
 */
export function useBoardPreview(boardId: string) {
  const [state, setState] = useState<(BoardPreviewState & { boardId: string }) | null>(null);
  // Hidden in the render the board changes in, and dropped, so going back does not bring it back.
  if (state && state.boardId !== boardId) setState(null);
  const preview = state && state.boardId === boardId ? state : null;
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const openCountRef = useRef(0);

  const openPreview = useStableCallback(
    (target: BoardPreviewTarget, options: OpenPreviewOptions = {}) => {
      const focused = document.activeElement;
      returnFocusRef.current =
        options.returnFocus ??
        (focused instanceof HTMLElement && focused !== document.body ? focused : null);
      openCountRef.current += 1;
      const openId = openCountRef.current;
      setState((prev) => ({
        boardId,
        target,
        // A swap keeps the pane as it is.
        fullScreen: prev?.boardId === boardId ? prev.fullScreen : false,
        openId,
      }));
    }
  );

  // Focus returns once the pane is gone: in full screen the trigger sits in the
  // inert main area until that render commits.
  const [focusAfterClose, setFocusAfterClose] = useState<HTMLElement | null>(null);
  const closePreview = useStableCallback(() => {
    setFocusAfterClose(returnFocusRef.current);
    returnFocusRef.current = null;
    setState(null);
  });
  useEffect(() => {
    if (!focusAfterClose) return;
    if (focusAfterClose.isConnected) focusAfterClose.focus();
    setFocusAfterClose(null);
  }, [focusAfterClose]);

  const setPreviewFullScreen = useStableCallback((fullScreen: boolean) => {
    setState((prev) => (prev ? { ...prev, fullScreen } : prev));
  });

  return { preview, openPreview, closePreview, setPreviewFullScreen };
}
