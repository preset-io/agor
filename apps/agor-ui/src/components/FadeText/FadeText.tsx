import { Tooltip, type TooltipProps, Typography, theme } from 'antd';
import type React from 'react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { useIsTouchInput } from '../../hooks/useCanHover';
import { getSessionTitleStyles } from '../../utils/sessionTitle';

const LINE_HEIGHT = 1.5;
/** Controls whose keyboard focus shows a clipped label's tooltip. */
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
  onOverflowChange?: (overflowing: boolean) => void;
};

/**
 * Label that fades out at its end instead of showing "…", only while clipped and only on
 * hover-capable screens; touch keeps the ellipsis. While clipped, the full text shows in a
 * tooltip on hover and on keyboard focus of the enclosing control. Rows marked
 * `data-fade-row` widen the fade on hover and focus to clear their actions (index.css).
 */
export function FadeText({
  fullText,
  dense = false,
  lines = 1,
  tooltipProps,
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
  const text = fullText ?? (typeof children === 'string' ? children : undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: new text can clip without a resize
  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => {
      setOverflowing(isClipped(node, lines));
      setRtl(getComputedStyle(node).direction === 'rtl');
    };
    measure();
    return observeSize(node, measure);
  }, [node, lines, text]);

  useEffect(() => onOverflowChange?.(overflowing), [overflowing, onOverflowChange]);

  useEffect(() => {
    const host = node?.parentElement?.closest<HTMLElement>(FOCUS_HOST);
    if (!host || touch) return;
    const onFocus = () => setFocused(host.matches(':focus-visible'));
    const onBlur = () => setFocused(false);
    host.addEventListener('focus', onFocus);
    host.addEventListener('blur', onBlur);
    return () => {
      host.removeEventListener('focus', onFocus);
      host.removeEventListener('blur', onBlur);
    };
  }, [node, touch]);

  const fading = overflowing && !touch;
  const fade = dense ? token.sizeSM : token.sizeLG;
  // Mask alpha stop, never painted.
  const opaque = '#000';
  const edge = `linear-gradient(to ${rtl ? 'left' : 'right'}, ${opaque} calc(100% - var(--agor-fade-row-start, ${fade}px)), transparent calc(100% - var(--agor-fade-row-end, 0px)))`;
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
      open={overflowing && !touch && (hovered || focused)}
      onOpenChange={setHovered}
    >
      {label}
    </Tooltip>
  );
}
