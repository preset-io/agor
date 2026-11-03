import type React from 'react';
import { useState } from 'react';
import { TEXT_TRUNCATION } from '../../constants/ui';
import { ShowMoreFade } from './ShowMoreFade';

export interface CollapsibleTextProps {
  /**
   * The text content to display
   */
  children: string;

  /**
   * Number of lines to show before truncating
   * @default TEXT_TRUNCATION.DEFAULT_LINES (10)
   */
  maxLines?: number;

  /**
   * Whether to preserve whitespace and formatting
   * @default false
   */
  preserveWhitespace?: boolean;

  /**
   * Additional CSS class name
   */
  className?: string;

  /**
   * Additional inline styles
   */
  style?: React.CSSProperties;

  /**
   * Whether the text is code (monospace font)
   * @default false
   */
  code?: boolean;
}

/**
 * CollapsibleText
 *
 * A reusable component for displaying long text with "show more/less" functionality.
 *
 * Usage:
 * ```tsx
 * <CollapsibleText maxLines={5}>
 *   {longTextContent}
 * </CollapsibleText>
 * ```
 *
 * Features:
 * - Configurable line limit (defaults to TEXT_TRUNCATION.DEFAULT_LINES)
 * - Bottom fade with "Show more" / "Show less"
 * - Preserves whitespace when needed (for code, formatted text)
 * - Consistent with Ant Design patterns
 */
export const CollapsibleText: React.FC<CollapsibleTextProps> = ({
  children,
  maxLines = TEXT_TRUNCATION.DEFAULT_LINES,
  preserveWhitespace = false,
  className,
  style,
  code = false,
}) => {
  const [expanded, setExpanded] = useState(false);

  const lines = children.split('\n');
  const shouldTruncate = lines.length > maxLines + 5;

  if (!shouldTruncate) {
    const computedStyle: React.CSSProperties = {
      ...style,
      whiteSpace: 'pre-wrap',
      wordWrap: 'break-word',
      margin: 0,
      ...(code && {
        fontFamily: 'Monaco, Menlo, Ubuntu Mono, Consolas, source-code-pro, monospace',
      }),
    };

    return (
      <div className={className} style={computedStyle}>
        {children}
      </div>
    );
  }

  const displayContent = expanded ? children : lines.slice(0, maxLines).join('\n');
  const contentStyle: React.CSSProperties = {
    ...style,
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    margin: 0,
    ...(code && {
      fontFamily: 'Monaco, Menlo, Ubuntu Mono, Consolas, source-code-pro, monospace',
    }),
  };

  return (
    <ShowMoreFade
      className={className}
      style={contentStyle}
      collapsed={!expanded}
      onToggle={() => setExpanded(!expanded)}
      moreLabel={code ? `Show all ${lines.length} lines` : undefined}
    >
      {displayContent}
    </ShowMoreFade>
  );
};
