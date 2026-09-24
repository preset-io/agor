import type { ContextUsageSnapshot } from '@agor/core/types';
import { theme } from 'antd';
import { type ReactNode, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { getContextWindowGradient } from '../../utils/contextWindow';

// Border tokens still read loud at rest in dark; the next token down vanishes in light.
const LINE_RESTING_OPACITY = 0.6;

/**
 * Anything that owns the pointer itself: a tap landing here is that control's,
 * not a tap on the turn.
 */
const INTERACTIVE_IN_TURN =
  'a, button, input, textarea, select, summary, label, [role="button"], [role="link"], [contenteditable], [aria-label="Turn metadata"], [data-testid="turn-usage-label"]';

/**
 * The footer under a turn's answer: the turn's metadata on the left, a hairline
 * whose fill and band color come from the same helpers `ContextWindowPill`
 * reads, and the usage percentage at the end.
 *
 * The line and the values share one grid cell and cross-fade, which keeps the
 * line the full width of the row however long the values are, and means
 * revealing a turn reflows nothing. Reveal is the turn's own region: hover,
 * keyboard focus-within, Escape to dismiss, and tap-to-pin on touch.
 */
export function ContextUsageRule({
  used,
  limit,
  snapshot,
  metadata,
  usageLabel,
  children,
}: {
  used: number | undefined;
  limit: number | undefined;
  snapshot: ContextUsageSnapshot | null | undefined;
  metadata?: ReactNode;
  /** The turn's usage percentage, as whatever opens its breakdown. */
  usageLabel: ReactNode;
  children: ReactNode;
}) {
  const { token } = theme.useToken();
  const reducedMotion = usePrefersReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const visible = !dismissed && (hovered || focused || pinned);

  // Same bands as the pill (<50 / <80 / rest), in the border tokens: a fill
  // tint is invisible at this height and the solid colors shout.
  const gradient = getContextWindowGradient(used, limit, snapshot, {
    normal: token.colorSuccessBorder,
    warning: token.colorWarningBorder,
    critical: token.colorErrorBorder,
  });
  const fade = reducedMotion
    ? 'none'
    : `opacity ${token.motionDurationFast} ${token.motionEaseOut}`;

  // The wrapper is unconditional even though the rule is not. Usage data lands
  // when the turn completes, so swapping this element for a fragment on the
  // way there would remount the whole answer mid-stream.
  return (
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focus reveals the footer without turning a turn full of links and buttons into a nested control.
      tabIndex={0}
      aria-label="Turn and its metadata"
      onMouseEnter={() => {
        setHovered(true);
        setDismissed(false);
      }}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={(event) => {
        // Clicking the answer can focus this tabIndex=0 section. That focus
        // must not keep the footer open after the pointer leaves; only
        // keyboard-visible focus reveals it beyond hover.
        const keyboardFocus = event.target.matches(':focus-visible');
        setFocused(keyboardFocus);
        if (keyboardFocus) setDismissed(false);
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
        // Do not hijack a selection, a control, or a scroll of the values.
        if (
          (event.target as HTMLElement).closest(INTERACTIVE_IN_TURN) ||
          window.getSelection()?.toString()
        )
          return;
        setPinned(!pinned);
        setDismissed(pinned);
      }}
    >
      {children}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: token.marginXS,
          marginTop: token.marginXXS,
          minHeight: token.controlHeightSM,
        }}
      >
        <div
          style={{
            // Basis 0, so the stack is whatever width the row has left after
            // the label — never a function of how long the values are.
            flex: '1 1 0',
            minWidth: 0,
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr)',
            alignItems: 'center',
          }}
        >
          {gradient && (
            <div
              data-testid="context-usage-rule"
              style={{
                gridArea: '1 / 1',
                height: token.lineWidth * 2,
                borderRadius: token.lineWidth,
                background: gradient,
                // Out of the way once the values take the same cell, so they
                // never sit on a visible line.
                opacity: visible ? 0 : LINE_RESTING_OPACITY,
                transition: fade,
              }}
            />
          )}
          {metadata && (
            <section
              aria-label="Turn metadata"
              style={{
                gridArea: '1 / 1',
                minWidth: 0,
                justifySelf: 'start',
                maxWidth: '100%',
                display: 'flex',
                alignItems: 'center',
                // One line that scrolls, never two that wrap: at phone width
                // the values are wider than the viewport.
                flexWrap: 'nowrap',
                whiteSpace: 'nowrap',
                overflowX: 'auto',
                overflowY: 'hidden',
                // Swiping to the end of the values does not then drag the
                // transcript behind it.
                overscrollBehaviorX: 'contain',
                scrollbarWidth: 'none',
                // `visibility` takes the values out of the tab order and the
                // accessibility tree; only its delay is animated, so the fade
                // still finishes before they go.
                visibility: visible ? 'visible' : 'hidden',
                opacity: visible ? 1 : 0,
                pointerEvents: visible ? 'auto' : 'none',
                transition: reducedMotion
                  ? 'none'
                  : `${fade}, visibility 0s ${visible ? '0s' : token.motionDurationFast}`,
              }}
            >
              {metadata}
            </section>
          )}
        </div>
        {usageLabel && (
          // Never dimmed: it stays readable once the line has faded, and it is
          // what opens the usage breakdown. Revealing the turn lifts it one
          // step — neutral, since the muted band colors fail text contrast.
          <span
            data-testid="turn-usage-label"
            style={{
              flexShrink: 0,
              fontSize: token.fontSizeSM,
              lineHeight: 1,
              color: visible ? token.colorTextSecondary : token.colorTextTertiary,
              fontVariantNumeric: 'tabular-nums',
              transition: reducedMotion
                ? 'none'
                : `color ${token.motionDurationFast} ${token.motionEaseOut}`,
            }}
          >
            {usageLabel}
          </span>
        )}
      </div>
    </section>
  );
}
