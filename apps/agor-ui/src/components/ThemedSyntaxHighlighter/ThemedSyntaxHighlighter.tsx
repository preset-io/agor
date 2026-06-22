/**
 * ThemedSyntaxHighlighter - Centralized themed code syntax highlighter
 *
 * A wrapper around react-syntax-highlighter that automatically adapts to the
 * current Ant Design theme (light/dark mode). Provides consistent code
 * highlighting across the app.
 *
 * The actual Prism-backed implementation (`react-syntax-highlighter` +
 * grammars, ~140KB) lives in `ThemedSyntaxHighlighter.inner.tsx` and is pulled
 * in via React.lazy so Vite code-splits it into its own chunk. The first
 * render of any code block triggers the async import; subsequent renders are
 * synchronous.
 *
 * The fallback renders the raw code inside the same wrapper tag (`PreTag`) so
 * the layout doesn't jump — and so the wrapper element identity is preserved
 * while the highlighter chunk downloads.
 *
 * Features:
 * - Auto-switches between oneDark and oneLight based on theme
 * - Supports all Prism languages
 * - Customizable via props
 * - Respects Ant Design token system for borders/radii
 */

import { theme } from 'antd';
import { lazy, Suspense } from 'react';
import type { ThemedSyntaxHighlighterProps } from './ThemedSyntaxHighlighter.inner';

export type { ThemedSyntaxHighlighterProps };

const ThemedSyntaxHighlighterInner = lazy(() => import('./ThemedSyntaxHighlighter.inner'));

/**
 * Plain, unhighlighted fallback shown while the Prism chunk loads. Uses the
 * caller's `PreTag` so the outer wrapper element matches the highlighted
 * output (default block-level `<pre>`; `'span'` for inline snippets).
 */
const PlainCodeFallback: React.FC<ThemedSyntaxHighlighterProps> = ({
  children,
  customStyle,
  PreTag = 'pre',
}) => {
  const { token } = theme.useToken();
  const Tag = PreTag as keyof React.JSX.IntrinsicElements;
  return (
    <Tag
      style={{
        margin: 0,
        borderRadius: token.borderRadius,
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
        whiteSpace: 'pre',
        ...customStyle,
      }}
    >
      {children}
    </Tag>
  );
};

export const ThemedSyntaxHighlighter: React.FC<ThemedSyntaxHighlighterProps> = (props) => (
  <Suspense fallback={<PlainCodeFallback {...props} />}>
    <ThemedSyntaxHighlighterInner {...props} />
  </Suspense>
);
