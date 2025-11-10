import Ansi from 'ansi-to-react';
import { theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { TEXT_TRUNCATION } from '../../constants/ui';

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
  const [expanded, setExpanded] = useState(false);

  const lines = children.split('\n');
  const shouldTruncate = lines.length > maxLines + 5;

  const contentStyle: React.CSSProperties = {
    ...style,
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    fontFamily: 'Monaco, Menlo, Ubuntu Mono, Consolas, source-code-pro, monospace',
    margin: 0,
  };

  if (!shouldTruncate) {
    return (
      <div className={className} style={contentStyle}>
        <Ansi>{children}</Ansi>
      </div>
    );
  }

  const displayContent = expanded ? children : lines.slice(0, maxLines).join('\n');
  const lineCount = lines.length;

  return (
    <div className={className}>
      <div style={contentStyle}>
        <Ansi>{displayContent}</Ansi>
      </div>

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
