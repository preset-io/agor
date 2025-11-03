// @ts-nocheck - markdown-it has no type declarations
/**
 * MarkdownRenderer - Renders markdown content using markdown-it
 *
 * Uses markdown-it (Ant Design X recommended approach) for rendering markdown to HTML.
 * Typography wrapper provides consistent Ant Design styling.
 */

import { Typography } from 'antd';
import markdownit from 'markdown-it';
import type React from 'react';

// Initialize markdown-it instance (cached)
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
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  inline = false,
  style,
}) => {
  // Handle array of strings: filter empty, join with double newlines
  const text = Array.isArray(content) ? content.filter(t => t.trim()).join('\n\n') : content;

  let html = md.render(text);

  // If inline, strip wrapping <p> tags but keep inner HTML
  if (inline) {
    html = html.replace(/^<p>(.*)<\/p>\n?$/s, '$1');
  }

  return (
    <Typography style={style}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown content is from trusted source (Agent SDK) */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </Typography>
  );
};
