import { Typography, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { TEXT_TRUNCATION } from '../../constants/ui';

const { Paragraph } = Typography;

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
 * Uses Ant Design's Typography.Paragraph ellipsis feature for consistent UX.
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
 * - Automatic "show more/less" controls
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
  const { token } = theme.useToken();
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
  const lineCount = lines.length;

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
    <div className={className}>
      <div style={contentStyle}>{displayContent}</div>

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
