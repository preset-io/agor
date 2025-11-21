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

  // Use default dual theme [light, dark] - Streamdown handles CSS-based switching
  // Note: This may render both themes in the DOM, controlled by CSS media queries
  // Always use Streamdown for rich features (Mermaid, math, GFM, copy/download buttons)
  // Only enable incomplete markdown parsing during active streaming
  return (
    <Typography style={style}>
      <Streamdown
        parseIncompleteMarkdown={isStreaming} // Parse incomplete syntax only while streaming
        className={inline ? 'inline-markdown' : 'markdown-content'}
        isAnimating={isStreaming} // Disable buttons during streaming
        controls={true} // Always show controls (copy/download buttons)
        mermaidConfig={mermaidConfig} // Set Mermaid theme based on current theme mode
        // Use default ['github-light', 'github-dark'] for automatic theme switching
      >
        {text}
      </Streamdown>
    </Typography>
  );
};
