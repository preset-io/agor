/**
 * MarkdownRenderer - Renders markdown content using Streamdown
 *
 * Uses Streamdown for all markdown rendering with support for:
 * - Incomplete markdown during streaming (handles partial syntax gracefully)
 * - Mermaid diagrams
 * - LaTeX math expressions
 * - GFM tables with copy/download buttons
 * - Code blocks with syntax highlighting and copy buttons
 *
 * Typography wrapper provides consistent Ant Design styling.
 */

import { Typography, theme } from 'antd';
import React, { useMemo } from 'react';
import { defaultRehypePlugins, Streamdown } from 'streamdown';
import { rehypeHeadingAnchors } from '../../utils/headingAnchors';
import { highlightMentionsInMarkdown } from '../../utils/highlightMentions';
import { isDarkTheme } from '../../utils/theme';
import {
  streamdownRemarkPlugins,
  streamdownRichContentPlugins,
  streamdownRichContentPluginsWithVegaLite,
} from './richContentPlugins';
import {
  createVegaLiteActivationBudget,
  VegaLiteActivationBudgetContext,
} from './vegaLiteActivationBudget';
import './MarkdownRenderer.css';

interface MarkdownRendererProps {
  /**
   * Markdown content to render
   */
  content: string | string[];
  /**
   * If true, renders inline (without <p> wrapper)
   */
  inline?: boolean;
  /**
   * Optional style to apply to the wrapper
   */
  style?: React.CSSProperties;
  /**
   * If true, uses Streamdown to handle incomplete markdown gracefully
   * Recommended for streaming content from AI agents
   */
  isStreaming?: boolean;
  /**
   * If true, uses compact styling suitable for cards/constrained spaces
   * Reduces heading sizes, margins, and limits max height with scroll
   */
  compact?: boolean;
  /**
   * If false, hides Streamdown controls (copy/download buttons)
   * Useful for compact contexts where controls add clutter
   */
  showControls?: boolean;
  /**
   * If true, rendered headings receive stable ids and visible self-links.
   * Intended for non-streaming document views such as Knowledge Base pages.
   */
  headingAnchors?: boolean;
  /** Demo-only POC: opt in to constrained Vega-Lite fenced blocks. */
  enableVegaLite?: boolean;
}

const MAX_VEGA_LITE_CHARTS_PER_DOCUMENT = 4;

// Memoized: Streamdown does meaningful per-render work (syntax highlighting,
// Mermaid, KaTeX) and this component is rendered once per text block in every
// message. During streaming, the conversation pane's parent re-renders on
// every chunk; without memo, every prior message's MarkdownRenderer re-ran
// even though its `content` was unchanged. Default shallow compare is fine —
// all props are primitives or stable refs at call sites in the conversation
// pane (MessageBlock, ThinkingBlock, CollapsibleMarkdown).
const MarkdownRendererInner: React.FC<MarkdownRendererProps> = ({
  content,
  inline = false,
  style,
  isStreaming = false,
  compact = false,
  showControls = true,
  headingAnchors = false,
  enableVegaLite = false,
}) => {
  const { token } = theme.useToken();

  // Handle array of strings: filter empty, join with double newlines
  const rawText = Array.isArray(content) ? content.filter((t) => t.trim()).join('\n\n') : content;
  let text = rawText;

  // Pre-process text to highlight @ mentions
  text = highlightMentionsInMarkdown(text);

  // Detect dark mode from Ant Design token system
  const isDarkMode = isDarkTheme(token);

  // Configure Mermaid theme based on current theme mode
  const mermaidConfig = {
    theme: (isDarkMode ? 'dark' : 'default') as 'dark' | 'default',
  };

  // Compact mode: reduce spacing and size for card contexts
  const compactStyles: React.CSSProperties = compact
    ? {
        maxHeight: '200px',
        overflowY: 'auto',
        fontSize: '12px',
        lineHeight: '1.5',
      }
    : {};

  const mergedStyles = { ...style, ...compactStyles };
  const plugins = enableVegaLite
    ? streamdownRichContentPluginsWithVegaLite
    : streamdownRichContentPlugins;
  const vegaLiteActivationBudget = useMemo(
    () => createVegaLiteActivationBudget(MAX_VEGA_LITE_CHARTS_PER_DOCUMENT, rawText),
    // A changed Markdown source receives a fresh budget. Streamdown may retain
    // renderer component positions while streaming, so source identity—not a
    // regex approximation of fence syntax—is the correct reset boundary.
    [rawText]
  );
  const rehypePlugins = useMemo(
    () =>
      headingAnchors ? [...Object.values(defaultRehypePlugins), rehypeHeadingAnchors] : undefined,
    [headingAnchors]
  );
  const components = useMemo(
    () => ({
      blockquote: MarkdownBlockquote,
      ...(headingAnchors ? { a: MarkdownAnchor } : {}),
    }),
    [headingAnchors]
  );

  // Use default dual theme [light, dark] - Streamdown handles CSS-based switching
  // Note: This may render both themes in the DOM, controlled by CSS media queries
  // Always use Streamdown for rich features (Mermaid, math, GFM, copy/download buttons)
  // Only enable incomplete markdown parsing during active streaming
  // Security: Streamdown sanitizes HTML by default to prevent XSS
  return (
    <Typography style={mergedStyles} className={compact ? 'markdown-compact' : undefined}>
      <VegaLiteActivationBudgetContext.Provider value={vegaLiteActivationBudget}>
        <Streamdown
          key={isStreaming ? undefined : markdownContentKey(rawText, { headingAnchors })}
          mode={isStreaming ? 'streaming' : 'static'}
          parseIncompleteMarkdown={isStreaming} // Parse incomplete syntax only while streaming
          className={inline ? 'inline-markdown' : 'markdown-content'}
          isAnimating={isStreaming} // Disable buttons during streaming
          controls={showControls} // Show/hide controls based on context
          mermaid={{ config: mermaidConfig }} // Set Mermaid theme based on current theme mode
          plugins={plugins}
          components={components}
          rehypePlugins={rehypePlugins}
          remarkPlugins={streamdownRemarkPlugins}
          // Keep anchored documents in one Streamdown block so the heading slugger
          // sees the whole document and duplicate headings are deduped globally.
          parseMarkdownIntoBlocksFn={headingAnchors ? parseMarkdownAsSingleBlock : undefined}
          // Use default ['github-light', 'github-dark'] for automatic theme switching
        >
          {text}
        </Streamdown>
      </VegaLiteActivationBudgetContext.Provider>
    </Typography>
  );
};

export const MarkdownRenderer = React.memo(MarkdownRendererInner);
MarkdownRenderer.displayName = 'MarkdownRenderer';

function markdownContentKey(text: string, options: { headingAnchors?: boolean } = {}): string {
  // Streamdown memoizes several rendered markdown node components by AST
  // position. Container positions (for example a `<ul>` spanning multiple
  // bullets) do not change when text changes inside an earlier child line, so
  // React can skip reconciling that subtree and leave stale preview text. Use a
  // content-derived key for non-streaming renders to remount Streamdown whenever
  // the markdown source changes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${options.headingAnchors ? 'anchors' : 'plain'}:${text.length}:${(hash >>> 0).toString(
    36
  )}`;
}

const parseMarkdownAsSingleBlock = (markdown: string) => [markdown];

type MarkdownAnchorProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  node?: unknown;
};

type MarkdownBlockquoteProps = React.BlockquoteHTMLAttributes<HTMLQuoteElement> & {
  node?: unknown;
};

const CALLOUT_TITLES = new Set(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']);

function MarkdownBlockquote({
  children,
  className,
  node: _node,
  ...props
}: MarkdownBlockquoteProps) {
  // remark-github-blockquote-alert inserts a title paragraph with dir="auto".
  // Its classes are correctly removed by Streamdown's sanitizer, so restore
  // only the five closed-set GitHub alert classes at the React boundary.
  const firstChild = React.Children.toArray(children).find(React.isValidElement);
  const firstProps = React.isValidElement(firstChild)
    ? (firstChild.props as { children?: React.ReactNode; dir?: string })
    : undefined;
  const title =
    firstProps?.dir === 'auto' ? reactText(firstProps.children).trim().toUpperCase() : '';
  const calloutClass = CALLOUT_TITLES.has(title)
    ? `markdown-alert-${title.toLowerCase()}`
    : undefined;

  return (
    <blockquote
      className={[
        'my-4 border-muted-foreground/30 border-l-4 pl-4 text-muted-foreground italic',
        calloutClass ? 'markdown-alert' : undefined,
        calloutClass,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-streamdown="blockquote"
      {...props}
    >
      {children}
    </blockquote>
  );
}

function reactText(value: React.ReactNode): string {
  return React.Children.toArray(value)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      if (React.isValidElement(child)) {
        return reactText((child.props as { children?: React.ReactNode }).children);
      }
      return '';
    })
    .join('');
}

function MarkdownAnchor({ children, className, href, node: _node, ...props }: MarkdownAnchorProps) {
  if (className?.split(/\s+/).includes('markdown-heading-anchor') && href?.startsWith('#')) {
    return (
      <a className={className} href={href} {...props}>
        {children}
      </a>
    );
  }

  return (
    <a
      className={['wrap-anywhere font-medium text-primary underline', className]
        .filter(Boolean)
        .join(' ')}
      data-streamdown="link"
      href={href}
      rel="noreferrer"
      target="_blank"
      {...props}
    >
      {children}
    </a>
  );
}
