import { Flex, theme } from 'antd';
import { type ReactNode, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

/** Floating metadata; only opacity/transform animate, never transcript layout. */
export function LeanTurnMetadata({
  metadata,
  background,
  children,
  reserveSpace = false,
}: {
  metadata: ReactNode;
  background?: string;
  children: ReactNode;
  /** Keep pending approval controls below the prompt unobscured. */
  reserveSpace?: boolean;
}) {
  const { token } = theme.useToken();
  const reducedMotion = usePrefersReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const visible = !dismissed && (hovered || focused || pinned);
  return (
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focus reveals metadata without turning the rich prompt (with links/buttons) into a nested button.
      tabIndex={0}
      aria-label="User prompt and turn metadata"
      style={{
        position: 'relative',
        display: 'flow-root',
        minWidth: 0,
        paddingBottom: reserveSpace ? token.controlHeight : 0,
      }}
      onMouseEnter={() => {
        setHovered(true);
        setDismissed(false);
      }}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => {
        setFocused(true);
        setDismissed(false);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
          setPinned(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setPinned(false);
          setDismissed(true);
        }
      }}
      onPointerDown={(event) => {
        touchStart.current =
          event.pointerType === 'touch' ? { x: event.clientX, y: event.clientY } : null;
      }}
      onPointerCancel={() => {
        touchStart.current = null;
      }}
      onPointerUp={(event) => {
        const start = touchStart.current;
        touchStart.current = null;
        if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > token.marginSM)
          return;
        // Do not hijack selection, links, copy controls, or scrolling/interacting with the metadata.
        if (
          (event.target as HTMLElement).closest(
            'a, button, input, textarea, [aria-label="Turn metadata"]'
          ) ||
          window.getSelection()?.toString()
        )
          return;
        setPinned(!pinned);
        setDismissed(pinned);
      }}
    >
      {children}
      <Flex
        align="center"
        style={{
          position: 'absolute',
          top: reserveSpace ? undefined : '100%',
          bottom: reserveSpace ? 0 : undefined,
          insetInlineEnd: 0,
          width: 'max-content',
          maxWidth: '100%',
          zIndex: 1,
          height: token.controlHeight,
          minWidth: 0,
          borderRadius: token.borderRadius,
          background: token.colorBgElevated,
          boxShadow: token.boxShadowSecondary,
          visibility: visible ? 'visible' : 'hidden',
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : `translateY(${token.sizeUnit}px)`,
          pointerEvents: visible ? 'auto' : 'none',
          // Delay visibility only on exit so the fade can finish. Pointer
          // events stop immediately; interrupted hover reverses without timers.
          transition: reducedMotion
            ? 'none'
            : `opacity ${token.motionDurationFast} ${token.motionEaseOut}, transform ${token.motionDurationFast} ${token.motionEaseOut}, visibility 0s ${visible ? '0s' : token.motionDurationFast}`,
        }}
      >
        <section
          aria-label="Turn metadata"
          aria-hidden={!visible}
          style={{
            flex: 1,
            minWidth: 0,
            height: token.controlHeight,
            display: 'flex',
            alignItems: 'center',
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollbarWidth: 'thin',
            background,
            borderRadius: token.borderRadiusSM,
          }}
        >
          {/* Auto margin right-aligns short rows but resolves to zero when
              overflowing, so the first pill remains reachable on narrow screens. */}
          <div style={{ marginInlineStart: 'auto', flexShrink: 0 }}>{metadata}</div>
        </section>
      </Flex>
    </section>
  );
}
