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
import type React from 'react';
import { Streamdown } from 'streamdown';
import { highlightMentionsInMarkdown } from '../../utils/highlightMentions';
import { isDarkTheme } from '../../utils/theme';
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
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  inline = false,
  style,
  isStreaming = false,
  compact = false,
  showControls = true,
}) => {
  const { token } = theme.useToken();

  // Handle array of strings: filter empty, join with double newlines
  let text = Array.isArray(content) ? content.filter((t) => t.trim()).join('\n\n') : content;

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

  // Use default dual theme [light, dark] - Streamdown handles CSS-based switching
  // Note: This may render both themes in the DOM, controlled by CSS media queries
  // Always use Streamdown for rich features (Mermaid, math, GFM, copy/download buttons)
  // Only enable incomplete markdown parsing during active streaming
  // Security: Streamdown sanitizes HTML by default to prevent XSS
  return (
    <Typography style={mergedStyles} className={compact ? 'markdown-compact' : undefined}>
      <Streamdown
        parseIncompleteMarkdown={isStreaming} // Parse incomplete syntax only while streaming
        className={inline ? 'inline-markdown' : 'markdown-content'}
        isAnimating={isStreaming} // Disable buttons during streaming
        controls={showControls} // Show/hide controls based on context
        mermaidConfig={mermaidConfig} // Set Mermaid theme based on current theme mode
        // Use default ['github-light', 'github-dark'] for automatic theme switching
      >
        {text}
      </Streamdown>
    </Typography>
  );
};
