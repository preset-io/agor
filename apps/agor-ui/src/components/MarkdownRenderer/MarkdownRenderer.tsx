/**
 * MarkdownRenderer - Renders markdown content using Streamdown or markdown-it
 *
 * Uses Streamdown for streaming content (handles incomplete markdown gracefully)
 * Falls back to markdown-it for static/completed content (lighter weight)
 * Typography wrapper provides consistent Ant Design styling.
 */

import { Typography } from 'antd';
import markdownit from 'markdown-it';
import type React from 'react';
import { Streamdown } from 'streamdown';

// Initialize markdown-it instance (cached) for completed messages
// Security: html disabled to prevent XSS from AI-generated content
const md = markdownit({ html: false, breaks: true });

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
