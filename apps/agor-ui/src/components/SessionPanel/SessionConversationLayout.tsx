import { theme } from 'antd';
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  getResizeHandleElement,
  type ImperativePanelHandle,
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from 'react-resizable-panels';

/** A local split: the composer stays outside, and only queued rows scroll. */
export function SessionConversationLayout({
  children,
  queueHeader,
  queue,
}: {
  children: ReactNode;
  queueHeader?: ReactNode;
  queue?: ReactNode;
}) {
  const { token } = theme.useToken();
  const id = useId();
  const queuePanelRef = useRef<ImperativePanelHandle>(null);
  // Desired percentage is local to this mounted conversation. Constraint-driven
  // resizes must not overwrite it (including an empty queue or a small viewport).
  const desiredSizeRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const keyboardResizeRef = useRef(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [measurements, setMeasurements] = useState({ available: 0, natural: 0 });
  const hasQueue = !!queue;
  // Fixed visual/layout thickness; hit-area margins below preserve easy grabbing.
  const handleSize = 4;
  const padding = token.sizeUnit;

  useLayoutEffect(() => {
    const measure = () => {
      const available = Math.max(0, (hostRef.current?.clientHeight ?? 0) - handleSize);
      const natural = hasQueue
        ? (headerRef.current?.offsetHeight ?? 0) +
          (rowsRef.current?.offsetHeight ?? 0) +
          padding * 2
        : 0;
      setMeasurements((previous) =>
        previous.available === available && previous.natural === natural
          ? previous
          : { available, natural }
      );
    };
    const observer = new ResizeObserver(measure);
    for (const element of [hostRef.current, headerRef.current, rowsRef.current]) {
      if (element) observer.observe(element);
    }
    measure();
    return () => observer.disconnect();
  }, [hasQueue, padding]);

  const { available, natural } = measurements;
  // Protect 240px of transcript where space permits, or 60% on short panels.
  // Even on tall panels the queue cannot take more than half the space.
  const conversationMinimum = available ? Math.min(240 / available, 0.6) * 100 : 60;
  const queueMaximum =
    available && natural
      ? Math.min(50, 100 - conversationMinimum, (natural / available) * 100)
      : 40;
  const queueMinimum = available ? Math.min(queueMaximum, (80 / available) * 100) : 15;

  useLayoutEffect(() => {
    if (!hasQueue) {
      draggingRef.current = false;
      keyboardResizeRef.current = false;
      return;
    }
    if (!available || !natural) return;
    desiredSizeRef.current ??= (160 / available) * 100;
    queuePanelRef.current?.resize(
      Math.min(queueMaximum, Math.max(queueMinimum, desiredSizeRef.current))
    );
    // v3 updates ARIA on layout changes, not on constraint-only changes. Keep
    // its two-panel bounds current even when the existing proportions still fit.
    const handle = getResizeHandleElement(`${id}-resize`);
    handle?.setAttribute('aria-valuemin', String(Math.round(100 - queueMaximum)));
    handle?.setAttribute('aria-valuemax', String(Math.round(100 - queueMinimum)));
  }, [available, natural, hasQueue, id, queueMaximum, queueMinimum]);

  return (
    <div ref={hostRef} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
      <PanelGroup
        direction="vertical"
        onLayout={(sizes) => {
          if ((draggingRef.current || keyboardResizeRef.current) && sizes.length === 2) {
            desiredSizeRef.current = sizes[1];
          }
        }}
      >
        <Panel
          id={`${id}-conversation`}
          order={1}
          minSize={hasQueue ? conversationMinimum : 0}
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          {children}
        </Panel>
        {hasQueue && (
          <>
            <PanelResizeHandle
              id={`${id}-resize`}
              // Preserve the former 8px handle's 18px fine / 38px coarse hit areas.
              hitAreaMargins={{ fine: 7, coarse: 17 }}
              onDragging={(dragging) => {
                draggingRef.current = dragging;
              }}
              onKeyDownCapture={(event) => {
                keyboardResizeRef.current = ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
                  event.key
                );
              }}
              onKeyUpCapture={() => {
                keyboardResizeRef.current = false;
              }}
              onBlur={() => {
                keyboardResizeRef.current = false;
              }}
              aria-label="Resize conversation and queued tasks"
              aria-orientation="horizontal"
              style={{
                height: handleSize,
                background: token.colorBorderSecondary,
                borderRadius: token.borderRadiusSM,
              }}
            />
            <Panel
              ref={queuePanelRef}
              id={`${id}-queue`}
              order={2}
              defaultSize={available ? Math.min(queueMaximum, (160 / available) * 100) : 30}
              minSize={queueMinimum}
              maxSize={queueMaximum}
            >
              <section
                aria-label="Queued tasks"
                style={{
                  height: '100%',
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  background: token.colorBgElevated,
                  padding,
                }}
              >
                <div ref={headerRef} style={{ flexShrink: 0 }}>
                  {queueHeader}
                </div>
                <section
                  aria-label="Queued task list"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded scroll region must be keyboard-scrollable
                  tabIndex={0}
                  // At the end, allow wheel/touch scrolling to reach the outer composer.
                  style={{ minHeight: 0, overflowY: 'auto' }}
                >
                  <div ref={rowsRef}>{queue}</div>
                </section>
              </section>
            </Panel>
          </>
        )}
      </PanelGroup>
    </div>
  );
}
