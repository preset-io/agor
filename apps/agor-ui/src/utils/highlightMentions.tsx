/**
 * Utility for highlighting @ mentions in text
 * Used in both textareas and rendered messages
 */

import { theme } from 'antd';
import type React from 'react';

/**
 * Highlight @ mentions in text for display (JSX version)
 * Returns JSX with highlighted and bolded mentions
 * Use this for non-markdown contexts
 */
export function highlightMentionsInText(text: string): React.ReactNode {
  const { token } = theme.useToken();

  // Match @ followed by either:
  // 1. Quoted text: @"anything including spaces"
  // 2. Unquoted text: @word (until space/newline)
  const mentionRegex = /@(?:"[^"]*"|[^\s]+)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = mentionRegex.exec(text);

  while (match !== null) {
    // Add text before mention
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    // Add highlighted mention
    parts.push(
      <span
        key={`mention-${match.index}`}
        style={{
          backgroundColor: token.colorBgTextHover,
          borderRadius: '3px',
          padding: '0 2px',
          fontWeight: 600,
        }}
      >
        {match[0]}
      </span>
    );

    lastIndex = match.index + match[0].length;
    match = mentionRegex.exec(text);
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts.length > 0 ? <>{parts}</> : text;
}

/**
 * Convert @ mentions to markdown with bold and background color
 * Returns markdown string with inline HTML spans for @ mentions
 * Use this for markdown contexts
 *
 * IMPORTANT: Skips code blocks (``` and `) to avoid corrupting code snippets
 */
export function highlightMentionsInMarkdown(text: string): string {
  // Match @ followed by either:
  // 1. Quoted text: @"anything including spaces"
  // 2. Unquoted text: @word (until space/newline)
  const mentionRegex = /@(?:"[^"]*"|[^\s]+)/g;

  // Build a map of code block ranges to skip
  const codeRanges: Array<{ start: number; end: number }> = [];

  // Match fenced code blocks (```...``` or ~~~...~~~)
  // Markdown allows up to 3 leading spaces before a fence
  const fencedCodeRegex = /^ {0,3}```[\s\S]*?^ {0,3}```|^ {0,3}~~~[\s\S]*?^ {0,3}~~~/gm;
  let match: RegExpExecArray | null = fencedCodeRegex.exec(text);
  while (match !== null) {
    codeRanges.push({ start: match.index, end: match.index + match[0].length });
    match = fencedCodeRegex.exec(text);
  }

  // Match inline code (`...`)
  // More robust: handles escaped backticks and multiple backticks
  const inlineCodeRegex = /`[^`\n]+`|``[^`\n]+``/g;
  match = inlineCodeRegex.exec(text);
  while (match !== null) {
    codeRanges.push({ start: match.index, end: match.index + match[0].length });
    match = inlineCodeRegex.exec(text);
  }

  // Sort ranges by start position
  codeRanges.sort((a, b) => a.start - b.start);

  // Helper to check if a position is inside a code block
  const isInCodeBlock = (pos: number): boolean => {
    return codeRanges.some((range) => pos >= range.start && pos < range.end);
  };

  // Replace @ mentions only if they're not in code blocks
  return text.replace(mentionRegex, (match, offset) => {
    if (isInCodeBlock(offset)) {
      return match; // Keep original if inside code block
    }
    // Use inline HTML with background color and bold
    // The background uses a semi-transparent color that works in both light and dark modes
    return `<span style="background-color: rgba(22, 119, 255, 0.15); border-radius: 3px; padding: 0 2px; font-weight: 600;">${match}</span>`;
  });
}

/**
 * Check if text contains @ mentions
 */
export function hasMentions(text: string): boolean {
  return /@(?:"[^"]*"|[^\s]+)/.test(text);
}
