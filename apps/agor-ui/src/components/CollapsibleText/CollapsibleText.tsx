import React from 'react';
import { Typography } from 'antd';
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
  const computedStyle: React.CSSProperties = {
    ...style,
    ...(preserveWhitespace && { whiteSpace: 'pre-wrap' }),
    ...(code && { fontFamily: 'monospace' }),
  };

  return (
    <Paragraph
      className={className}
      style={computedStyle}
      ellipsis={{
        rows: maxLines,
        expandable: true,
        symbol: 'show more',
      }}
    >
      {children}
    </Paragraph>
  );
};
