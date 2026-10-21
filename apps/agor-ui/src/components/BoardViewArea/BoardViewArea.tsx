import { Flex, theme } from 'antd';
import { useEffect, useRef } from 'react';
import {
  type ImperativePanelHandle,
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from 'react-resizable-panels';
import { BoardViewContext } from '../../contexts/BoardViewContext';
import type { BoardViewShell } from '../../hooks/useBoardViewShell';
import { useElementWidth } from '../../hooks/useElementWidth';
import { BoardPreviewPane } from '../BoardPreview';
import { BoardViewTabs } from '../BoardViewTabs';

// Matches the canvas panel's own `minSize` below; App caps the session panel with it.
export const CANVAS_MIN_SIZE_PERCENT = 20;

// Beside a preview the conversation keeps 420px and the preview 400px. Narrower
// than both, the preview opens full screen.
export const CONVERSATION_MIN_WIDTH_PX = 420;
export const PREVIEW_MIN_WIDTH_PX = 400;

const PREVIEW_HANDLE_WIDTH_PX = 4;

const percentOf = (px: number, width: number) =>
  width > 0 ? Math.min(100, (px / width) * 100) : 0;
const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

interface BoardViewAreaProps {
  shell: BoardViewShell;
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
  canvas,
  conversation,
  sessionPanel,
  onSessionPanelResize,
}) => {
  const { token } = theme.useToken();
  const isChat = shell.isChat;
  const conversationShown = conversation != null;
  const canvasPanelRef = useRef<ImperativePanelHandle>(null);
  const sessionPanelRef = useRef<ImperativePanelHandle>(null);
  const resizeDraggingRef = useRef(false);

  // The preview: Chat only, never Board, where it is kept but hidden.
  const areaRef = useRef<HTMLDivElement>(null);
  const areaWidth = useElementWidth(areaRef);
  const mainPanelRef = useRef<ImperativePanelHandle>(null);
  const previewPanelRef = useRef<ImperativePanelHandle>(null);
  const previewPaneRef = useRef<HTMLElement>(null);
  const previewDraggingRef = useRef(false);
  const preview = shell.ready && isChat ? shell.preview : null;
  // Panel sizes share the width left beside the divider.
  const panelsWidth = areaWidth - PREVIEW_HANDLE_WIDTH_PX;
  const narrow = areaWidth > 0 && panelsWidth < CONVERSATION_MIN_WIDTH_PX + PREVIEW_MIN_WIDTH_PX;
  const fullScreen = !!preview && (preview.fullScreen || narrow);
  const mainMinSize = percentOf(CONVERSATION_MIN_WIDTH_PX, panelsWidth);
  const previewMinSize = percentOf(PREVIEW_MIN_WIDTH_PX, panelsWidth);
  const previewSize = clampPercent(shell.previewSize, previewMinSize, 100 - mainMinSize);

  // Chat collapses the canvas; Board expands it again, and the effect below
  // restores the session panel size.
  useEffect(() => {
    const canvasPanel = canvasPanelRef.current;
    if (!canvasPanel) return;
    // expand() leaves an expanded panel as it is.
    if (isChat) canvasPanel.collapse();
    else canvasPanel.expand();
  }, [isChat]);

  // Re-resize whenever the size changes, including when the left panel toggles
  // or resizes and shifts the content width it is derived from. Without this,
  // the session panel keeps the same percentage while this area's width
  // changes, so its pixel width would drift along with the left panel.
  // A session opening restores the kept size too, after a drag that was not kept.
  const sessionShown = !!onSessionPanelResize;
  // biome-ignore lint/correctness/useExhaustiveDependencies: also re-run when a session opens.
  useEffect(() => {
    if (!isChat && conversationShown) sessionPanelRef.current?.resize(sessionPanel.size);
  }, [isChat, conversationShown, sessionShown, sessionPanel.size]);

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

  // Each open moves focus into the preview, once: coming back from Board does not.
  const focusedOpenIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!preview || focusedOpenIdRef.current === preview.openId) return;
    focusedOpenIdRef.current = preview.openId;
    previewPaneRef.current?.focus();
  }, [preview]);

  return (
    <BoardViewContext.Provider value={shell.context}>
      <Flex vertical style={{ height: '100%' }}>
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
              if (previewDraggingRef.current && sizes.length === 2) shell.setPreviewSize(sizes[1]);
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
                inert={fullScreen}
                aria-hidden={fullScreen || undefined}
                style={{ height: '100%' }}
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
                    defaultSize={isChat ? 0 : conversationShown ? 100 - sessionPanel.size : 100}
                    minSize={CANVAS_MIN_SIZE_PERCENT}
                    // Only Chat collapses the canvas; on Board it keeps its minimum.
                    collapsible={isChat}
                    collapsedSize={0}
                  >
                    {/* Collapsed, not unmounted: out of the tab order and hidden from assistive tech. */}
                    <div
                      inert={isChat}
                      aria-hidden={isChat || undefined}
                      style={{ position: 'relative', overflow: 'hidden', height: '100%' }}
                    >
                      {canvas}
                    </div>
                  </Panel>
                  {conversationShown && (
                    <>
                      <PanelResizeHandle
                        disabled={isChat}
                        tabIndex={isChat ? -1 : undefined}
                        style={{
                          width: isChat ? 0 : '4px',
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
                        defaultSize={isChat ? 100 : sessionPanel.size}
                        minSize={isChat ? 0 : sessionPanel.minSize}
                        maxSize={isChat ? 100 : sessionPanel.maxSize}
                      >
                        {conversation}
                      </Panel>
                    </>
                  )}
                </PanelGroup>
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
                    fullScreen={fullScreen}
                    onToggleFullScreen={
                      narrow ? undefined : () => shell.setPreviewFullScreen(!preview.fullScreen)
                    }
                    onShowOnBoard={shell.showOnBoard}
                    onClose={shell.closePreview}
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
