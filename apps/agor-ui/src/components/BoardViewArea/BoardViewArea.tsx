import type { AgorClient, User } from '@agor-live/client';
import { Flex, theme } from 'antd';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type ImperativePanelHandle,
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from 'react-resizable-panels';
import { useAppActions } from '../../contexts/AppActionsContext';
import { BoardViewContext, type BoardViewContextValue } from '../../contexts/BoardViewContext';
import { type BoardPreviewTarget, useBoardPreview } from '../../hooks/useBoardPreview';
import type { BoardViewShell } from '../../hooks/useBoardViewShell';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useStableCallback } from '../../hooks/useStableCallback';
import { useUserLocalStorage } from '../../hooks/useUserLocalStorage';
import { clampPercent, percentOf } from '../App/panelSizing';
import { BoardFiles } from '../BoardFiles';
import { BoardPreviewPane } from '../BoardPreview';
import { BoardViewTabs } from '../BoardViewTabs';

// Matches the canvas panel's own `minSize` below; App caps the session panel with it.
export const CANVAS_MIN_SIZE_PERCENT = 20;

// Beside a preview the conversation keeps 420px and the preview 400px. Narrower
// than both, the preview opens full screen.
export const CONVERSATION_MIN_WIDTH_PX = 420;
export const PREVIEW_MIN_WIDTH_PX = 400;
// Beside a preview, the Files list keeps 480px.
export const FILES_MIN_WIDTH_PX = 480;

const PREVIEW_HANDLE_WIDTH_PX = 4;

/** Whether focus can land on `element`: still on the page, and not inert or hidden. */
const canTakeFocus = (element: HTMLElement | null): element is HTMLElement =>
  !!element?.isConnected &&
  !element.closest('[inert], [aria-hidden="true"]') &&
  (element.checkVisibility?.() ?? true);

interface BoardViewAreaProps {
  shell: BoardViewShell;
  client: AgorClient | null;
  user: User | null | undefined;
  /** The conversation on screen, marked as current in the preview. */
  currentSessionId?: string | null;
  /** The canvas, or Home / the teammates directory in its place. */
  canvas: React.ReactNode;
  /** The session panel's content. Null leaves Board without a session panel. */
  conversation: React.ReactNode;
  /** Session panel sizes, in percent of this area, for the Board tab. */
  sessionPanel: { size: number; minSize: number; maxSize: number };
  /** A divider drag while a session is shown; drags without one are not kept. */
  onSessionPanelResize?: (size: number) => void;
}

/**
 * A board's main area: the tab row over the canvas and the session panel, with
 * the preview pane on the right in Chat. Chat collapses the canvas so the
 * conversation fills the area, and full screen collapses the main area the same
 * way; nothing remounts on a switch, so drafts, scroll and React Flow's camera survive.
 */
export const BoardViewArea: React.FC<BoardViewAreaProps> = ({
  shell,
  client,
  user,
  currentSessionId,
  canvas,
  conversation,
  sessionPanel,
  onSessionPanelResize,
}) => {
  const { token } = theme.useToken();
  const { isChat, isFiles, chatLayout } = shell;
  const conversationShown = conversation != null;
  const canvasPanelRef = useRef<ImperativePanelHandle>(null);
  const sessionPanelRef = useRef<ImperativePanelHandle>(null);
  const resizeDraggingRef = useRef(false);

  // The preview: Chat only, never Board, where it is kept but hidden. Its state
  // and size live here, where the pane renders, so a divider drag re-renders
  // only this area. The size is a share of the area, kept per person and
  // written on drag only, like the session panel's.
  const { onSessionClick } = useAppActions();
  const {
    preview: keptPreview,
    returnFocusRef,
    openPreview,
    closePreview,
    setPreviewFullScreen,
  } = useBoardPreview(shell.boardId);
  const [keptPreviewSize, setPreviewSize] = useUserLocalStorage<number>(
    user?.user_id,
    'panel:preview:size',
    45
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const areaWidth = useElementWidth(areaRef);
  const mainPanelRef = useRef<ImperativePanelHandle>(null);
  const previewPanelRef = useRef<ImperativePanelHandle>(null);
  const previewPaneRef = useRef<HTMLElement>(null);
  const previewDraggingRef = useRef(false);
  const preview = shell.ready && (isChat || isFiles) ? keptPreview : null;
  const mainMinWidth = isFiles ? FILES_MIN_WIDTH_PX : CONVERSATION_MIN_WIDTH_PX;
  // Panel sizes share the width left beside the divider.
  const panelsWidth = areaWidth - PREVIEW_HANDLE_WIDTH_PX;
  const narrow = areaWidth > 0 && panelsWidth < mainMinWidth + PREVIEW_MIN_WIDTH_PX;
  const fullScreen = !!preview && (preview.fullScreen || narrow);
  const mainMinSize = percentOf(mainMinWidth, panelsWidth);
  const previewMinSize = percentOf(PREVIEW_MIN_WIDTH_PX, panelsWidth);
  const previewSize = clampPercent(keptPreviewSize, previewMinSize, 100 - mainMinSize);

  // Every way of opening a conversation from the preview goes through here, so
  // the conversation is seen: full screen ends, and where the window has no
  // room for both, the preview closes.
  const openConversation = useStableCallback((sessionId: string) => {
    shell.visit('chat');
    if (narrow) closePreview();
    else setPreviewFullScreen(false);
    onSessionClick?.(sessionId);
  });

  const previewTarget = keptPreview?.target ?? null;
  const { ready, view, showOnBoard } = shell;
  const context = useMemo<BoardViewContextValue | null>(
    () =>
      ready
        ? { view, showOnBoard, previewTarget, openPreview, closePreview, openConversation }
        : null,
    [ready, view, showOnBoard, previewTarget, openPreview, closePreview, openConversation]
  );

  // Files mounts the first time it is shown, then stays (hidden elsewhere), so
  // its search, filters and scroll survive a trip to Chat.
  const [filesMounted, setFilesMounted] = useState(false);
  if (isFiles && !filesMounted) setFilesMounted(true);

  // A conversation opened while Files is shown by the URL (Back, a deep link)
  // shows Chat for this visit, where it opens as a tab; clicks go through App's
  // session handler, which shows Chat even for the conversation already open.
  // Before paint, so Files never shows an empty frame.
  const shownSessionRef = useRef(currentSessionId);
  useLayoutEffect(() => {
    const opened = currentSessionId && currentSessionId !== shownSessionRef.current;
    shownSessionRef.current = currentSessionId;
    if (opened && isFiles) shell.visit('chat');
  }, [currentSessionId, isFiles, shell.visit]);

  // Chat collapses the canvas; Board expands it again, and the effect below
  // restores the session panel size. Files leaves both as they were.
  useEffect(() => {
    const canvasPanel = canvasPanelRef.current;
    if (!canvasPanel) return;
    // expand() leaves an expanded panel as it is.
    if (chatLayout) canvasPanel.collapse();
    else canvasPanel.expand();
  }, [chatLayout]);

  // Re-resize whenever the size changes, including when the left panel toggles
  // or resizes and shifts the content width it is derived from. Without this,
  // the session panel keeps the same percentage while this area's width
  // changes, so its pixel width would drift along with the left panel.
  // A session opening restores the kept size too, after a drag that was not kept.
  const sessionShown = !!onSessionPanelResize;
  // biome-ignore lint/correctness/useExhaustiveDependencies: also re-run when a session opens.
  useEffect(() => {
    if (!chatLayout && conversationShown) sessionPanelRef.current?.resize(sessionPanel.size);
  }, [chatLayout, conversationShown, sessionShown, sessionPanel.size]);

  // Full screen collapses the main area; leaving it, or closing the preview,
  // expands it again and restores the kept preview size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore the size only on these changes.
  useEffect(() => {
    const mainPanel = mainPanelRef.current;
    if (!mainPanel) return;
    if (fullScreen) {
      mainPanel.collapse();
      return;
    }
    mainPanel.expand();
    if (preview) previewPanelRef.current?.resize(previewSize);
  }, [fullScreen, !!preview]);

  // Focus follows the preview. Each open (a new target) moves focus into it;
  // coming back from Board is not an open. Closing returns focus to whatever
  // opened it if that can still take focus, else to the active board tab, but
  // only when focus went with the pane. Going full screen, or too narrow for
  // both, while focus is in the main area moves it into the preview, since the
  // main area turns inert; focus elsewhere, such as a modal, stays put. A layout
  // effect, so focus moves before the browser drops it from the inert area.
  const shown = !!preview;
  const focusedTargetRef = useRef<BoardPreviewTarget | null>(null);
  const wasFullScreenRef = useRef(false);
  useLayoutEffect(() => {
    const wasFullScreen = wasFullScreenRef.current;
    wasFullScreenRef.current = fullScreen;
    if (!previewTarget) {
      if (!focusedTargetRef.current) return;
      focusedTargetRef.current = null;
      const trigger = returnFocusRef.current;
      returnFocusRef.current = null;
      const focused = document.activeElement;
      if (focused && focused !== document.body) return;
      if (canTakeFocus(trigger)) trigger.focus();
      if (trigger && document.activeElement === trigger) return;
      const activeTab = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="true"]') ?? []
      ).find((tab) => !areaRef.current?.contains(tab));
      activeTab?.focus();
      return;
    }
    const pane = previewPaneRef.current;
    if (!shown || !pane) return;
    if (focusedTargetRef.current !== previewTarget) {
      focusedTargetRef.current = previewTarget;
      pane.focus();
    } else if (
      fullScreen &&
      !wasFullScreen &&
      mainAreaRef.current?.contains(document.activeElement)
    ) {
      pane.focus();
    }
  }, [previewTarget, shown, fullScreen, returnFocusRef]);

  return (
    <BoardViewContext.Provider value={context}>
      <Flex ref={rootRef} vertical style={{ height: '100%' }}>
        {shell.ready && (
          <BoardViewTabs
            order={shell.order}
            view={shell.view}
            onPick={shell.pick}
            onReorder={shell.reorder}
          />
        )}
        <div ref={areaRef} style={{ flex: 1, minHeight: 0 }}>
          <PanelGroup
            id="board-view"
            direction="horizontal"
            onLayout={(sizes) => {
              if (previewDraggingRef.current && sizes.length === 2) setPreviewSize(sizes[1]);
            }}
          >
            <Panel
              id="board-view-main"
              order={1}
              ref={mainPanelRef}
              minSize={preview && !fullScreen ? mainMinSize : 0}
              // Only full screen collapses it; a drag stops at its minimum.
              collapsible={fullScreen}
              collapsedSize={0}
            >
              {/* Collapsed in full screen, not unmounted: hidden like the canvas in Chat. */}
              <div
                ref={mainAreaRef}
                inert={fullScreen}
                aria-hidden={fullScreen || undefined}
                style={{ height: '100%', position: 'relative' }}
              >
                {/* Files lays over the board and conversation, which stay laid out but
                    hidden, so scroll positions and React Flow measurements survive. */}
                {filesMounted && (
                  <div
                    inert={!isFiles}
                    aria-hidden={!isFiles || undefined}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      zIndex: 1,
                      visibility: isFiles ? 'visible' : 'hidden',
                    }}
                  >
                    <BoardFiles client={client} boardId={shell.boardId} active={isFiles} />
                  </div>
                )}
                <div
                  inert={isFiles}
                  aria-hidden={isFiles || undefined}
                  style={{ height: '100%', visibility: isFiles ? 'hidden' : undefined }}
                >
                  <PanelGroup
                    id="canvas-session"
                    direction="horizontal"
                    onLayout={(sizes) => {
                      // Persist only user drags, so panel open/close and programmatic
                      // restores do not overwrite the user's preference.
                      if (resizeDraggingRef.current && sizes.length === 2) {
                        onSessionPanelResize?.(sizes[1]);
                      }
                    }}
                  >
                    <Panel
                      id="canvas-panel"
                      order={1}
                      ref={canvasPanelRef}
                      defaultSize={
                        chatLayout ? 0 : conversationShown ? 100 - sessionPanel.size : 100
                      }
                      minSize={CANVAS_MIN_SIZE_PERCENT}
                      // Only Chat collapses the canvas; on Board it keeps its minimum.
                      collapsible={chatLayout}
                      collapsedSize={0}
                    >
                      {/* Collapsed, not unmounted: out of the tab order and hidden from assistive tech. */}
                      <div
                        inert={chatLayout}
                        aria-hidden={chatLayout || undefined}
                        style={{ position: 'relative', overflow: 'hidden', height: '100%' }}
                      >
                        {canvas}
                      </div>
                    </Panel>
                    {conversationShown && (
                      <>
                        <PanelResizeHandle
                          disabled={chatLayout}
                          tabIndex={chatLayout ? -1 : undefined}
                          style={{
                            width: chatLayout ? 0 : '4px',
                            background: token.colorBorderSecondary,
                            cursor: 'col-resize',
                            transition: 'background 0.2s',
                          }}
                          onDragging={(isDragging) => {
                            resizeDraggingRef.current = isDragging;
                          }}
                          onMouseEnter={(e) => {
                            (e.currentTarget as unknown as HTMLDivElement).style.background =
                              token.colorPrimary;
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as unknown as HTMLDivElement).style.background =
                              token.colorBorderSecondary;
                          }}
                        />
                        <Panel
                          id="session-panel"
                          order={2}
                          ref={sessionPanelRef}
                          defaultSize={chatLayout ? 100 : sessionPanel.size}
                          minSize={chatLayout ? 0 : sessionPanel.minSize}
                          maxSize={chatLayout ? 100 : sessionPanel.maxSize}
                        >
                          {conversation}
                        </Panel>
                      </>
                    )}
                  </PanelGroup>
                </div>
              </div>
            </Panel>
            {preview && (
              <>
                <PanelResizeHandle
                  disabled={fullScreen}
                  tabIndex={fullScreen ? -1 : undefined}
                  style={{
                    width: fullScreen ? 0 : PREVIEW_HANDLE_WIDTH_PX,
                    background: token.colorBorderSecondary,
                    cursor: 'col-resize',
                    transition: 'background 0.2s',
                  }}
                  onDragging={(isDragging) => {
                    previewDraggingRef.current = isDragging;
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as unknown as HTMLDivElement).style.background =
                      token.colorPrimary;
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as unknown as HTMLDivElement).style.background =
                      token.colorBorderSecondary;
                  }}
                />
                <Panel
                  id="board-view-preview"
                  order={2}
                  ref={previewPanelRef}
                  defaultSize={fullScreen ? 100 : previewSize}
                  minSize={fullScreen ? 0 : previewMinSize}
                  maxSize={fullScreen ? 100 : 100 - mainMinSize}
                >
                  <BoardPreviewPane
                    ref={previewPaneRef}
                    target={preview.target}
                    client={client}
                    user={user}
                    currentSessionId={currentSessionId}
                    fullScreen={fullScreen}
                    onToggleFullScreen={
                      narrow ? undefined : () => setPreviewFullScreen(!preview.fullScreen)
                    }
                    onShowOnBoard={showOnBoard}
                    onClose={closePreview}
                  />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
      </Flex>
    </BoardViewContext.Provider>
  );
};
