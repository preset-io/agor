import { Tooltip, type TooltipProps, Typography, theme } from 'antd';
import type React from 'react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { useIsTouchInput } from '../../hooks/useCanHover';
import { getSessionTitleStyles } from '../../utils/sessionTitle';

const LINE_HEIGHT = 1.5;
/** Controls whose keyboard focus shows the tooltip of their first FadeText (the title). */
const FOCUS_HOST =
  'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"]';

const measures = new Map<Element, () => void>();
let sharedObserver: ResizeObserver | undefined;

/** One ResizeObserver for every FadeText on the page. */
function observeSize(element: Element, measure: () => void): () => void {
  sharedObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) measures.get(entry.target)?.();
  });
  measures.set(element, measure);
  sharedObserver.observe(element);
  return () => {
    measures.delete(element);
    sharedObserver?.unobserve(element);
    if (measures.size === 0) {
      sharedObserver?.disconnect();
      sharedObserver = undefined;
    }
  };
}

function isClipped(element: HTMLElement, lines: number): boolean {
  return lines > 1
    ? element.scrollHeight - element.clientHeight > 1
    : element.scrollWidth - element.clientWidth > 1;
}

export type FadeTextProps = Omit<React.ComponentProps<typeof Typography.Text>, 'ellipsis'> & {
  /** Tooltip while clipped; defaults to string children. */
  fullText?: string;
  /** 12px meta lines take the shorter fade. */
  dense?: boolean;
  /** Wrap to this many lines and fade the last one. */
  lines?: number;
  tooltipProps?: Pick<TooltipProps, 'placement' | 'mouseEnterDelay'>;
  /** Suppress the tooltip while something else already shows the full text. */
  hideTooltip?: boolean;
  onOverflowChange?: (overflowing: boolean) => void;
};

/**
 * Label that fades out at its end instead of showing "…", only while clipped and only on
 * hover-capable screens; touch keeps the ellipsis. While clipped, the full text shows in a
 * tooltip on hover and on keyboard focus of the enclosing control. In a `data-fade-row`, the fade
 * moves in on hover and focus to end where the row's `data-fade-row-actions` begin.
 */
export function FadeText({
  fullText,
  dense = false,
  lines = 1,
  tooltipProps,
  hideTooltip = false,
  onOverflowChange,
  style,
  children,
  ...textProps
}: FadeTextProps) {
  const { token } = theme.useToken();
  const touch = useIsTouchInput();
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [rtl, setRtl] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [actionsInset, setActionsInset] = useState(0);
  const text = fullText ?? (typeof children === 'string' ? children : undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: new text can clip without a resize
  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => {
      const clipped = isClipped(node, lines);
      setOverflowing(clipped);
      // Only a clipped label needs its direction, and fitting labels skip the style read.
      if (clipped) setRtl(getComputedStyle(node).direction === 'rtl');
    };
    measure();
    return observeSize(node, measure);
  }, [node, lines, text]);

  useEffect(() => onOverflowChange?.(overflowing), [overflowing, onOverflowChange]);

  useEffect(() => {
    const host = node?.parentElement?.closest<HTMLElement>(FOCUS_HOST);
    if (!host || touch || host.querySelector('[data-fade-text]') !== node) return;
    const onFocus = () => setFocused(host.matches(':focus-visible'));
    const onBlur = () => setFocused(false);
    host.addEventListener('focus', onFocus);
    host.addEventListener('blur', onBlur);
    return () => {
      host.removeEventListener('focus', onFocus);
      host.removeEventListener('blur', onBlur);
    };
  }, [node, touch]);

  useEffect(() => {
    const row = node?.closest<HTMLElement>('[data-fade-row]');
    if (!node || !row || touch) return;
    let hover = false;
    let focus = false;
    let frame = 0;
    const measure = () => {
      const actions = (hover || focus) && row.querySelector('[data-fade-row-actions]');
      if (!actions) return setActionsInset(0);
      const label = node.getBoundingClientRect();
      const bar = actions.getBoundingClientRect();
      // Rects are in screen pixels; the mask is in the label's own (unzoomed) pixels.
      const scale = label.width / node.offsetWidth || 1;
      setActionsInset(Math.max(0, (rtl ? bar.right - label.left : label.right - bar.left) / scale));
    };
    const update = (event: Event) => {
      if (event.type === 'pointerenter' || event.type === 'pointerleave') {
        hover = event.type === 'pointerenter';
      } else {
        const next = (event as FocusEvent).relatedTarget as Node | null;
        focus = event.type === 'focusin' || row.contains(next);
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const events = ['pointerenter', 'pointerleave', 'focusin', 'focusout'];
    for (const type of events) row.addEventListener(type, update);
    return () => {
      cancelAnimationFrame(frame);
      for (const type of events) row.removeEventListener(type, update);
    };
  }, [node, touch, rtl]);

  const fading = overflowing && !touch;
  const fade = dense ? token.sizeSM : token.sizeLG;
  // Mask alpha stop, never painted.
  const opaque = '#000';
  const edge = `linear-gradient(to ${rtl ? 'left' : 'right'}, ${opaque} calc(100% - ${actionsInset + fade}px), transparent calc(100% - ${actionsInset}px))`;
  const mask =
    lines > 1
      ? `linear-gradient(${opaque} calc(100% - ${LINE_HEIGHT}em), transparent 0), ${edge}`
      : edge;

  const clipStyle: React.CSSProperties =
    lines > 1
      ? touch
        ? getSessionTitleStyles(lines, LINE_HEIGHT)
        : {
            display: 'block',
            overflow: 'hidden',
            lineHeight: LINE_HEIGHT,
            maxHeight: `${lines * LINE_HEIGHT}em`,
          }
      : { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: fading ? 'clip' : 'ellipsis' };

  const label = (
    <Typography.Text
      ref={setNode}
      {...textProps}
      data-fade-text
      data-overflowing={overflowing || undefined}
      style={{
        display: 'block',
        minWidth: 0,
        ...style,
        ...clipStyle,
        ...(fading && { maskImage: mask, WebkitMaskImage: mask }),
      }}
    >
      {children}
    </Typography.Text>
  );

  if (!text) return label;
  return (
    <Tooltip
      {...tooltipProps}
      title={text}
      open={!hideTooltip && overflowing && !touch && (hovered || focused)}
      onOpenChange={setHovered}
    >
      {label}
    </Tooltip>
  );
}
