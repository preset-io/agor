import { Tooltip, type TooltipProps, type TooltipRef } from 'antd';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';

/** True when a single-line, overflow-hidden element is clipping its content (e.g. an ellipsis). */
export function isTextTruncated(element: Element | null | undefined): boolean {
  return element != null && element.scrollWidth > element.clientWidth;
}

export type OverflowTooltipProps = Omit<TooltipProps, 'open' | 'onOpenChange' | 'children'> & {
  /** One element that clips its own text (`overflow: hidden`); it receives Tooltip's hover handlers. */
  children: React.ReactElement;
};

/**
 * Tooltip that opens only when its child's text is actually truncated.
 *
 * Unlike `Typography` ellipsis tooltips, nothing is observed or measured up
 * front: the child is measured when Tooltip's own trigger asks to open, and a
 * ResizeObserver runs only while the tooltip is showing, closing it if the text
 * stops overflowing. That keeps long, virtualized lists at zero per-row cost.
 */
export function OverflowTooltip({ children, ...tooltipProps }: OverflowTooltipProps) {
  const tooltipRef = useRef<TooltipRef>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const element = tooltipRef.current?.nativeElement;
    if (!open || !element) return;
    const observer = new ResizeObserver(() => {
      if (!isTextTruncated(element)) setOpen(false);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  return (
    <Tooltip
      {...tooltipProps}
      ref={tooltipRef}
      open={open}
      onOpenChange={(next) => setOpen(next && isTextTruncated(tooltipRef.current?.nativeElement))}
    >
      {children}
    </Tooltip>
  );
}
