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
const md = markdownit({ html: true, breaks: true });

interface MarkdownRendererProps {
  /**
   * Markdown content to render
   */
  content: string;
  /**
   * If true, renders inline (without <p> wrapper)
   */
  inline?: boolean;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, inline = false }) => {
  const html = inline ? md.renderInline(content) : md.render(content);

  return (
    <Typography>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown content is from trusted source (Agent SDK) */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </Typography>
  );
};
