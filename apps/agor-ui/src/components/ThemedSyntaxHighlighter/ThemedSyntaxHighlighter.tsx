/**
 * ThemedSyntaxHighlighter - Centralized themed code syntax highlighter
 *
 * A wrapper around react-syntax-highlighter that automatically adapts to the current
 * Ant Design theme (light/dark mode). Provides consistent code highlighting across the app.
 *
 * Features:
 * - Auto-switches between oneDark and oneLight based on theme
 * - Supports all Prism languages
 * - Customizable via props
 * - Respects Ant Design token system for borders/radii
 */

import { theme } from 'antd';
import type { CSSProperties } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { isDarkTheme } from '@/utils/theme';

export interface ThemedSyntaxHighlighterProps {
  /**
   * Code content to highlight
   */
  children: string;
  /**
   * Programming language for syntax highlighting
   * @default 'typescript'
   */
  language?: string;
  /**
   * Show line numbers
   * @default false
   */
  showLineNumbers?: boolean;
  /**
   * Custom styles to apply to the highlighter container
   */
  customStyle?: CSSProperties;
  /**
   * HTML tag to use for wrapping (default is 'code', can be 'span' for inline)
   * @default 'code'
   */
  PreTag?: keyof JSX.IntrinsicElements;
}

export const ThemedSyntaxHighlighter: React.FC<ThemedSyntaxHighlighterProps> = ({
  children,
  language = 'typescript',
  showLineNumbers = false,
  customStyle,
  PreTag = 'code',
}) => {
  const { token } = theme.useToken();
  const isDark = isDarkTheme(token);

  return (
    <SyntaxHighlighter
      language={language}
      style={isDark ? oneDark : oneLight}
      showLineNumbers={showLineNumbers}
      customStyle={{
        margin: 0,
        borderRadius: token.borderRadius,
        ...customStyle,
      }}
      PreTag={PreTag}
    >
      {children}
    </SyntaxHighlighter>
  );
};
