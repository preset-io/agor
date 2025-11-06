import Ansi from 'ansi-to-react';
import type React from 'react';

export interface AnsiTextProps {
  children: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * AnsiText - Renders text with ANSI escape codes as styled output
 *
 * Uses ansi-to-react to convert terminal color codes to HTML/CSS.
 *
 * Usage:
 * ```tsx
 * <AnsiText>{bashOutput}</AnsiText>
 * ```
 */
export const AnsiText: React.FC<AnsiTextProps> = ({ children, className, style }) => {
  return (
    <div className={className} style={style}>
      <Ansi>{children}</Ansi>
    </div>
  );
};
