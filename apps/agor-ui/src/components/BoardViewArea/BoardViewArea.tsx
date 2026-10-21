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
import { BoardViewTabs } from '../BoardViewTabs';

// Matches the canvas panel's own `minSize` below; App caps the session panel with it.
export const CANVAS_MIN_SIZE_PERCENT = 20;

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
 * A board's main area: the tab row over the canvas and the session panel. Chat
 * collapses the canvas so the conversation fills the area; nothing remounts on
 * a switch, so drafts, scroll and React Flow's camera survive.
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
        {/* The preview pane joins `board-view-main` here. */}
        <PanelGroup id="board-view" direction="horizontal" style={{ flex: 1, minHeight: 0 }}>
          <Panel id="board-view-main" order={1}>
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
          </Panel>
        </PanelGroup>
      </Flex>
    </BoardViewContext.Provider>
  );
};
