import type React from 'react';
import { useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { getMarkdownPreview, isLongMarkdown } from './markdownPreview';
import { ShowMoreFade } from './ShowMoreFade';

interface CollapsibleMarkdownProps {
  children: string;
  className?: string;
  style?: React.CSSProperties;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /**
   * Whether this is an actively streaming message
   */
  isStreaming?: boolean;
}

/**
 * CollapsibleMarkdown - Renders markdown with truncation support
 *
 * Unlike CollapsibleText which uses Ant Design's ellipsis (works well for plain text),
 * CollapsibleMarkdown renders a bounded character preview, letting Streamdown
 * repair incomplete syntax without estimating layout or scanning for fence ends.
 *
 * This allows full markdown rendering in both collapsed and expanded states.
 *
 * Usage:
 * ```tsx
 * <CollapsibleMarkdown>
 *   {longMarkdownContent}
 * </CollapsibleMarkdown>
 * ```
 */
export const CollapsibleMarkdown: React.FC<CollapsibleMarkdownProps> = ({
  children,
  className,
  style,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  isStreaming = false,
}) => {
  const [localExpanded, setExpanded] = useState(defaultExpanded);
  const expanded = controlledExpanded ?? localExpanded;

  const shouldTruncate = isLongMarkdown(children);

  if (!shouldTruncate) {
    return (
      <div className={className} style={style}>
        <MarkdownRenderer content={children} isStreaming={isStreaming} />
      </div>
    );
  }

  const displayContent = expanded ? children : getMarkdownPreview(children);

  return (
    <ShowMoreFade
      className={className}
      style={style}
      collapsed={!expanded}
      onToggle={() => {
        setExpanded(!expanded);
        onExpandedChange?.(!expanded);
      }}
    >
      <MarkdownRenderer
        content={displayContent}
        isStreaming={isStreaming}
        isIncomplete={!expanded}
        // Partial code/table exports would copy only the preview. The enclosing
        // message copy action still owns the full source; expansion restores controls.
        showControls={expanded}
      />
    </ShowMoreFade>
  );
};
