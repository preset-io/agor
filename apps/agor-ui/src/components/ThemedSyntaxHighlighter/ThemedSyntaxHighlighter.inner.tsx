/**
 * Inner implementation of ThemedSyntaxHighlighter — the part that actually
 * pulls in `react-syntax-highlighter` (Prism + the bundled language grammars,
 * ~140KB). Loaded via React.lazy from `./ThemedSyntaxHighlighter` so the
 * highlighter chunk is fetched only when the first code block renders.
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
  PreTag?: keyof React.JSX.IntrinsicElements;
  /**
   * Props forwarded to the inner <code> element. Use this to override the
   * Prism theme's white-space/overflow rules (e.g. to enable wrapping for
   * long one-liners).
   */
  codeTagProps?: React.HTMLAttributes<HTMLElement> & { style?: CSSProperties };
}

const ThemedSyntaxHighlighterInner: React.FC<ThemedSyntaxHighlighterProps> = ({
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

export default ThemedSyntaxHighlighterInner;
