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

import { Typography } from 'antd';
import type React from 'react';
import { Streamdown } from 'streamdown';

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
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  inline = false,
  style,
  isStreaming = false,
}) => {
  // Handle array of strings: filter empty, join with double newlines
  const text = Array.isArray(content) ? content.filter(t => t.trim()).join('\n\n') : content;

  // Always use Streamdown for rich features (Mermaid, math, GFM, copy/download buttons)
  // Only enable incomplete markdown parsing during active streaming
  return (
    <Typography style={style}>
      <Streamdown
        parseIncompleteMarkdown={isStreaming} // Parse incomplete syntax only while streaming
        className={inline ? 'inline-markdown' : 'markdown-content'}
        isAnimating={isStreaming} // Disable buttons during streaming
        controls={true} // Always show controls (copy/download buttons)
      >
        {text}
      </Streamdown>
    </Typography>
  );
};
