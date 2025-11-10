import Ansi from 'ansi-to-react';
import { Typography, theme } from 'antd';
import type React from 'react';
import { TEXT_TRUNCATION } from '../../constants/ui';

const { Paragraph } = Typography;

interface CollapsibleAnsiTextProps {
  children: string;
  maxLines?: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * CollapsibleAnsiText - Combines CollapsibleText with ANSI color support
 *
 * Perfect for bash output, git logs, test results, etc.
 *
 * Usage:
 * ```tsx
 * <CollapsibleAnsiText>{terminalOutput}</CollapsibleAnsiText>
 * ```
 */
export const CollapsibleAnsiText: React.FC<CollapsibleAnsiTextProps> = ({
  children,
  maxLines = TEXT_TRUNCATION.DEFAULT_LINES,
  className,
  style,
}) => {
  const { token } = theme.useToken();

  const computedStyle: React.CSSProperties = {
    ...style,
    whiteSpace: 'pre-wrap',
    fontFamily: 'Monaco, Menlo, Ubuntu Mono, Consolas, source-code-pro, monospace',
    background: token.colorBgLayout,
    padding: token.paddingSM,
    borderRadius: token.borderRadius,
    border: `1px solid ${token.colorBorder}`,
    margin: 0,
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
      <Ansi>{children}</Ansi>
    </Paragraph>
  );
};
