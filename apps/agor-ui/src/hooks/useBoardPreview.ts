import type { ArtifactID, BoardFileItem, BranchID, KnowledgeDocumentID } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { useStableCallback } from './useStableCallback';

/**
 * What the board's preview pane shows. Branch details also stands for apps and
 * pull requests. The rest carry their Files item, which names them in the header
 * and says where they came from (an upload has no other metadata to read).
 */
export type BoardPreviewTarget =
  | { kind: 'branch'; id: BranchID }
  | { kind: 'artifact'; id: ArtifactID; item: BoardFileItem }
  | { kind: 'document'; id: KnowledgeDocumentID; item: BoardFileItem }
  | { kind: 'upload'; ref: string; item: BoardFileItem };

/** The preview for a Files item: apps and pull requests open as Branch details. */
export function boardFilePreviewTarget(item: BoardFileItem): BoardPreviewTarget {
  switch (item.kind) {
    case 'app':
      return { kind: 'branch', id: item.id as BranchID };
    case 'artifact':
      return { kind: 'artifact', id: item.id as ArtifactID, item };
    case 'document':
      return { kind: 'document', id: item.id as KnowledgeDocumentID, item };
    case 'upload':
      return { kind: 'upload', ref: item.id, item };
  }
}

/** True when the preview shows this Files item. */
export function isPreviewing(preview: BoardPreviewState | null | undefined, item: BoardFileItem) {
  const target = preview?.target;
  if (!target) return false;
  const id = target.kind === 'upload' ? target.ref : target.id;
  const kind = target.kind === 'branch' ? 'app' : target.kind;
  return kind === item.kind && id === item.id;
}

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
