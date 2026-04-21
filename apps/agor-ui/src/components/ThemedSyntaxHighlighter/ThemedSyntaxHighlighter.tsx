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
   * HTML tag to use for wrapping. Must be a block-level element when
   * `showLineNumbers` is set or when the content can wrap, otherwise soft
   * wraps flow inline from the previous line's end (the "staircase" bug).
   * Use 'span' only for truly inline single-line snippets.
   * @default 'pre'
   */
  PreTag?: keyof JSX.IntrinsicElements;
  /**
   * Props forwarded to the inner <code> element. Use this to override the
   * Prism theme's white-space/overflow rules (e.g. to enable wrapping for
   * long one-liners).
   */
  codeTagProps?: React.HTMLAttributes<HTMLElement> & { style?: CSSProperties };
}

export const ThemedSyntaxHighlighter: React.FC<ThemedSyntaxHighlighterProps> = ({
  children,
  language = 'typescript',
  showLineNumbers = false,
  customStyle,
  PreTag = 'pre',
  codeTagProps,
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
      codeTagProps={codeTagProps}
    >
      {children}
    </SyntaxHighlighter>
  );
};
