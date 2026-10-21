import { type AgorClient, type Board, isTeammate, type User } from '@agor-live/client';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { BoardViewContextValue } from '../contexts/BoardViewContext';
import { useRecenterMap, useRegisterBoardView } from '../contexts/CanvasNavigationContext';
import { agorStore } from '../store/agorStore';
import { availableBoardViews } from '../utils/boardViews';
import { teammateLabel } from '../utils/teammateLabels';
import { resolveBoardFromUrlPure } from '../utils/urlResolution';
import { useBoardPreview } from './useBoardPreview';
import { useBoardTabOrder } from './useBoardTabOrder';
import { useBoardView } from './useBoardView';
import { useCanManageBoard } from './useCanManageBoard';
import { useStableCallback } from './useStableCallback';
import type { ActiveUrlTarget } from './useUrlState';
import { useUserLocalStorage } from './useUserLocalStorage';

const HIGHLIGHT_MS = 6000;

/**
 * The board tabs' controller for the desktop shell: which tab is on screen,
 * the shared tab order, when the canvas mounts, the preview pane, and Show on
 * board. Deliberate recenters elsewhere ("go to card") reach it through
 * CanvasNavigationContext.
 */
export function useBoardViewShell({
  client,
  user,
  board,
  boardId,
  onBoardSurface,
  urlNamesBoard,
  activeUrlTarget,
  selectedSessionId = null,
}: {
  client: AgorClient | null;
  user: User | null | undefined;
  board: Board | undefined;
  boardId: string;
  /** Not Home or the teammates directory. */
  onBoardSurface: boolean;
  /** The URL names a board or an entity on one, which decides the tab once resolved. */
  urlNamesBoard: boolean;
  activeUrlTarget: ActiveUrlTarget | null;
  /** The session in the URL. Opening one while Files is shown visits Chat. */
  selectedSessionId?: string | null;
}) {
  // The row shows once the board is known.
  const ready = onBoardSurface && !!board;
  const canManage = useCanManageBoard(client, board, user);
  const { order, setOrder } = useBoardTabOrder(client, board);
  const shownViews = useMemo(() => availableBoardViews(order), [order]);
  const { view, pick, visit } = useBoardView({
    userId: user?.user_id,
    boardId: ready ? boardId : null,
    order: shownViews,
  });
  const isChat = ready && view === 'chat';
  const isFiles = ready && view === 'files';

  // A conversation opened while Files is shown (a row's link, the left panel, a
  // deep link) shows Chat for this visit, where it opens as a tab.
  const [openedSessionId, setOpenedSessionId] = useState(selectedSessionId);
  if (selectedSessionId !== openedSessionId) {
    setOpenedSessionId(selectedSessionId);
    if (selectedSessionId && isFiles) visit('chat');
  }

  // A branch or artifact link shows Board for that visit, set in the render the
  // target arrives in so Chat never flashes. The link's recenter then finds Board shown.
  const [linkedTarget, setLinkedTarget] = useState(activeUrlTarget);
  if (activeUrlTarget !== linkedTarget) {
    setLinkedTarget(activeUrlTarget);
    if (activeUrlTarget && boardId) visit('board', boardId);
  }

  // React Flow mounts the first time Board is shown, then stays (collapsed in Chat),
  // keeping its camera. People who start on Chat never load it. A board named in
  // the URL is waited for, since its tab decides. Set in an effect so the canvas
  // mounts after its panel has expanded.
  const canvasWanted = ready ? view === 'board' : onBoardSurface && !urlNamesBoard;
  const [canvasMounted, setCanvasMounted] = useState(false);
  useEffect(() => {
    if (canvasWanted) setCanvasMounted(true);
  }, [canvasWanted]);

  // Deliberate recenters ("go to card", Show on board) show the Board tab for
  // this visit; CanvasNavigationContext asks through this channel.
  useRegisterBoardView(
    useStableCallback((targetBoardId?: string) => {
      const target = targetBoardId || boardId;
      if (!target || (target === boardId && !isChat)) return false;
      visit('board', target);
      return true;
    })
  );

  // Show on board: pan to the card, outline it like a deep link, and anchor a tip.
  const recenterMap = useRecenterMap();
  const [highlight, setHighlight] = useState<{
    kind: 'branch' | 'artifact';
    id: string;
    text: string;
  } | null>(null);
  const showOnBoard = useStableCallback((id: string, kind: 'branch' | 'artifact' = 'branch') => {
    const { branchById, artifactById } = agorStore.getState();
    const card = kind === 'branch' ? branchById.get(id) : artifactById.get(id);
    if (!card) return;
    const name =
      'artifact_id' in card ? card.name : isTeammate(card) ? teammateLabel(card) : card.name;
    const teammate = board?.primary_teammate_id
      ? branchById.get(board.primary_teammate_id)
      : undefined;
    const place = teammate ? `${teammateLabel(teammate)}’s board` : 'this board';
    recenterMap(id, { boardId: card.board_id ?? boardId });
    setHighlight({ kind, id, text: `${name} is here on ${place}. Switch back to Chat anytime.` });
  });
  const clearHighlight = useStableCallback(() => setHighlight(null));
  useEffect(() => {
    if (!highlight) return;
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlight]);
  // Leaving Board, or the board, ends it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear on every board change.
  useEffect(() => {
    if (isChat || !ready) setHighlight(null);
  }, [isChat, ready, boardId]);
  const highlightTip = useMemo(
    () => (highlight ? { nodeId: highlight.id, text: highlight.text } : null),
    [highlight]
  );

  // The preview pane beside Chat. Its size is a share of the main area, kept per
  // person and written on drag only, like the session panel's.
  const { preview, openPreview, closePreview, setPreviewFullScreen } = useBoardPreview(boardId);
  const [previewSize, setPreviewSize] = useUserLocalStorage<number>(
    user?.user_id,
    'panel:preview:size',
    45
  );

  // BoardViewArea adds openConversation, which needs the app's session opener.
  const context = useMemo<Omit<BoardViewContextValue, 'openConversation'> | null>(
    () => (ready ? { view, showOnBoard, preview, openPreview, closePreview } : null),
    [ready, view, showOnBoard, preview, openPreview, closePreview]
  );

  return {
    ready,
    view,
    isChat,
    isFiles,
    client,
    boardId,
    selectedSessionId,
    order,
    pick,
    visit,
    /** Absent for people who cannot edit the board. */
    reorder: canManage ? setOrder : undefined,
    canManage,
    canvasMounted,
    highlightTip,
    highlightBranchId: highlight?.kind === 'branch' ? highlight.id : null,
    highlightArtifactId: highlight?.kind === 'artifact' ? highlight.id : null,
    clearHighlight,
    showOnBoard,
    preview,
    closePreview,
    setPreviewFullScreen,
    previewSize,
    setPreviewSize,
    context,
  };
}

export type BoardViewShell = ReturnType<typeof useBoardViewShell>;

/**
 * Chat shows the open conversations: on the board's own link (`/b/<board>/`),
 * once it names the board on screen, the selected session tab opens in place.
 * Session, branch and artifact links are left alone, and so is a board link
 * that has not resolved yet (it may name another board).
 */
export function useChatOpensSelectedTab({
  active,
  board,
  tabIds,
  selectedTabId,
  onOpen,
}: {
  /** Chat is shown and nothing else claims the conversation area. */
  active: boolean;
  board: Board | undefined;
  tabIds: string[];
  selectedTabId: string | null;
  onOpen: (sessionId: string) => void;
}) {
  const { boardParam } = useParams<{ boardParam?: string }>();
  const onBoardLink =
    !!boardParam &&
    !!board &&
    resolveBoardFromUrlPure(boardParam, new Map([[board.board_id, board]])) === board.board_id;
  const tabToOpen =
    active && onBoardLink
      ? selectedTabId && tabIds.includes(selectedTabId)
        ? selectedTabId
        : (tabIds[0] ?? null)
      : null;
  const open = useStableCallback(onOpen);
  useEffect(() => {
    if (tabToOpen) open(tabToOpen);
  }, [tabToOpen, open]);
}
