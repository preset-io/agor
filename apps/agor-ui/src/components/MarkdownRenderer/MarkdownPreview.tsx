import { Button, theme } from 'antd';
import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  REACT_FLOW_NO_DRAG_CLASS,
  REACT_FLOW_NO_WHEEL_CLASS,
} from '../../utils/reactFlowDragClasses';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MarkdownPreviewProps {
  content: string;
  /** Rendered pixels, not source characters/lines (which can split Markdown syntax). */
  collapsedHeight?: number;
  expandedHeight?: number;
  moreLabel?: string;
  lessLabel?: string;
}

const INTERACTIVE_MARKDOWN_SELECTOR =
  'a, button, input, select, textarea, summary, [role="button"], [role="link"]';

/** Shared bounded Markdown preview for canvas cards, not streaming chat messages. */
export const MarkdownPreview = React.memo(function MarkdownPreview({
  content,
  collapsedHeight = 54,
  expandedHeight = 240,
  moreLabel = 'more',
  lessLabel = 'less',
}: MarkdownPreviewProps) {
  const { token } = theme.useToken();
  const contentId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  // Keep the renderer memoized when only the preview's disclosure state changes.
  const markdownStyle = useMemo(
    () => ({ color: token.colorTextSecondary }),
    [token.colorTextSecondary]
  );

  useLayoutEffect(() => {
    if (!content) {
      setExpanded(false);
      setCanExpand(false);
      return;
    }
    const element = contentRef.current;
    if (!element) return;
    // Observe the unbounded content, not the viewport: an already-clamped
    // viewport won't resize when an image, diagram, font, or disclosure grows.
    // scrollHeight is in layout pixels, unaffected by React Flow's zoom transform.
    const measure = () => setCanExpand(element.scrollHeight > collapsedHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [content, collapsedHeight]);

  if (!content) return null;

  return (
    <div
      className={REACT_FLOW_NO_DRAG_CLASS}
      onClick={(event) => {
        if ((event.target as Element).closest(INTERACTIVE_MARKDOWN_SELECTOR)) {
          event.stopPropagation();
        }
      }}
    >
      <div
        id={contentId}
        ref={viewportRef}
        className={expanded ? REACT_FLOW_NO_WHEEL_CLASS : undefined}
        style={{
          maxHeight: expanded ? expandedHeight : collapsedHeight,
          overflow: expanded ? 'auto' : 'hidden',
        }}
        onFocusCapture={(event) => {
          if (expanded) return;
          const viewport = event.currentTarget;
          const target = event.target;
          if (!viewport.contains(target)) return;
          const visible = viewport.getBoundingClientRect();
          const focused = target.getBoundingClientRect();
          // Hidden-overflow content is still tabbable. Disclose it rather than
          // letting focus silently scroll a supposedly collapsed preview.
          if (
            viewport.scrollTop > 0 ||
            focused.top < visible.top ||
            focused.bottom > visible.bottom
          ) {
            setExpanded(true);
          }
        }}
      >
        <div ref={contentRef} style={{ display: 'flow-root' }}>
          <MarkdownRenderer
            content={content}
            compact
            boundHeight={false}
            showControls={false}
            style={markdownStyle}
          />
        </div>
      </div>
      {(expanded || canExpand) && (
        <Button
          type="link"
          size="small"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={(event) => {
            event.stopPropagation();
            if (expanded && viewportRef.current) viewportRef.current.scrollTop = 0;
            setExpanded(!expanded);
          }}
          style={{ padding: 0, height: 'auto', fontSize: token.fontSizeSM }}
        >
          {expanded ? lessLabel : moreLabel}
        </Button>
      )}
    </div>
  );
});
