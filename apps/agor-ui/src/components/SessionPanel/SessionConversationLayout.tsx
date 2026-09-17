import { theme } from 'antd';
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

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
  const hostRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [measurements, setMeasurements] = useState({ available: 0, natural: 0 });
  const hasQueue = !!queue;
  const handleSize = token.sizeUnit * 2;
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
  }, [hasQueue, handleSize, padding]);

  const { available, natural } = measurements;
  // Protect 240px of transcript where space permits, or 60% on short panels.
  // Even on tall panels the queue cannot take more than half the space.
  const conversationMinimum = available ? Math.min(240 / available, 0.6) * 100 : 60;
  const queueMaximum =
    available && natural
      ? Math.min(50, 100 - conversationMinimum, (natural / available) * 100)
      : 40;
  const queueMinimum = available ? Math.min(queueMaximum, (80 / available) * 100) : 15;

  return (
    <div ref={hostRef} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
      <PanelGroup direction="vertical">
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
              aria-label="Resize conversation and queued tasks"
              aria-orientation="horizontal"
              style={{
                height: handleSize,
                background: token.colorBorderSecondary,
                borderRadius: token.borderRadiusSM,
              }}
            />
            <Panel
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
                  style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
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
