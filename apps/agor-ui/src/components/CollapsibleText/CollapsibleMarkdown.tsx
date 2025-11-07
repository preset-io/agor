import { theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { TEXT_TRUNCATION } from '../../constants/ui';
import { MarkdownRenderer } from '../MarkdownRenderer';

interface CollapsibleMarkdownProps {
  children: string;
  maxLines?: number;
  className?: string;
  style?: React.CSSProperties;
  defaultExpanded?: boolean;
}

/**
 * CollapsibleMarkdown - Renders markdown with truncation support
 *
 * Unlike CollapsibleText which uses Ant Design's ellipsis (works well for plain text),
 * CollapsibleMarkdown renders markdown and uses line counting for truncation.
 *
 * This allows full markdown rendering in both collapsed and expanded states.
 *
 * Usage:
 * ```tsx
 * <CollapsibleMarkdown maxLines={10}>
 *   {longMarkdownContent}
 * </CollapsibleMarkdown>
 * ```
 */
export const CollapsibleMarkdown: React.FC<CollapsibleMarkdownProps> = ({
  children,
  maxLines = TEXT_TRUNCATION.DEFAULT_LINES,
  className,
  style,
  defaultExpanded = false,
}) => {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(defaultExpanded);

  const lines = children.split('\n');
  // Add threshold to avoid truncating slightly-over-limit content
  const shouldTruncate = lines.length > maxLines + 5;

  if (!shouldTruncate) {
    return (
      <div className={className} style={style}>
        <MarkdownRenderer content={children} />
      </div>
    );
  }

  // Smart truncation that respects code fences
  const displayContent = expanded ? children : smartTruncate(children, maxLines);
  const lineCount = lines.length;

  return (
    <div className={className} style={style}>
      <MarkdownRenderer content={displayContent} />

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
            ... ({lineCount - maxLines} more lines)
          </div>
        )}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
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

/**
 * Smart truncation that avoids breaking code fences
 *
 * @param markdown - The markdown content
 * @param maxLines - Maximum lines to show
 * @returns Truncated markdown that respects code fence boundaries
 */
function smartTruncate(markdown: string, maxLines: number): string {
  const lines = markdown.split('\n');
  let inCodeFence = false;
  let truncateAt = maxLines;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) {
      inCodeFence = !inCodeFence;
    }

    // If we're at max lines and inside code fence, extend to end of fence
    if (i >= maxLines && inCodeFence) {
      truncateAt = i + 1;
    } else if (i >= maxLines && !inCodeFence) {
      truncateAt = i;
      break;
    }
  }

  return lines.slice(0, truncateAt).join('\n');
}
