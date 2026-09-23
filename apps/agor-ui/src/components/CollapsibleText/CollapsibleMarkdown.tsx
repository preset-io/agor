import { theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { getMarkdownPreview, isLongMarkdown } from './markdownPreview';

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
  const { token } = theme.useToken();
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
    <div className={className} style={style}>
      <MarkdownRenderer
        content={displayContent}
        isStreaming={isStreaming}
        isIncomplete={!expanded}
        // Partial code/table exports would copy only the preview. The enclosing
        // message copy action still owns the full source; expansion restores controls.
        showControls={expanded}
      />

      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {!expanded && (
          <div
            style={{
              fontStyle: 'italic',
              opacity: 0.6,
              fontSize: token.fontSizeSM,
              color: token.colorTextTertiary,
            }}
          >
            …
          </div>
        )}
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
            onExpandedChange?.(!expanded);
          }}
          style={{
            fontSize: token.fontSizeSM,
            cursor: 'pointer',
            alignSelf: 'flex-start',
            color: token.colorLink,
            background: 'none',
            border: 'none',
            padding: 0,
          }}
        >
          {expanded ? 'show less' : 'show more'}
        </button>
      </div>
    </div>
  );
};
