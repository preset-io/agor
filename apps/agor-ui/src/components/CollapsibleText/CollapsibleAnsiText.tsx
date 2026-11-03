import type React from 'react';
import { useState } from 'react';
import { TEXT_TRUNCATION } from '../../constants/ui';
import { Ansi } from '../AnsiText';
import { ShowMoreFade } from './ShowMoreFade';

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
  return (
    <ShowMoreFade
      className={className}
      style={contentStyle}
      collapsed={!expanded}
      onToggle={() => setExpanded(!expanded)}
      moreLabel={`Show all ${lines.length} lines`}
    >
      <Ansi>{displayContent}</Ansi>
    </ShowMoreFade>
  );
};
