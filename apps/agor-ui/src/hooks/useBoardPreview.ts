import type {
  ArtifactID,
  BoardFileItem,
  BranchID,
  KnowledgeDocumentID,
  SessionID,
} from '@agor-live/client';
import { useRef, useState } from 'react';
import { useStableCallback } from './useStableCallback';

/**
 * What the board's preview pane shows. Branch details also stands for apps and
 * pull requests. The other kinds carry their Files item, which names them in
 * the header and says where they came from (an upload has no other metadata to
 * read). Each open is a new object, which is how the pane knows to take focus.
 */
export type BoardPreviewTarget =
  | {
      kind: 'branch';
      id: BranchID;
      /** The conversation it was opened from, if any. */
      fromSessionId?: SessionID;
    }
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
export function isPreviewing(target: BoardPreviewTarget | null | undefined, item: BoardFileItem) {
  if (!target) return false;
  const id = target.kind === 'upload' ? target.ref : target.id;
  const kind = target.kind === 'branch' ? 'app' : target.kind;
  return kind === item.kind && id === item.id;
}

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
