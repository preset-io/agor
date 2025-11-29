/**
 * Session title formatting utilities
 *
 * Provides consistent session title display logic across the app.
 * Uses CSS line-clamp for responsive truncation that adapts to container width.
 */

import type { Session } from '@agor/core/types';
import type { CSSProperties } from 'react';

export interface FormatSessionTitleOptions {
  /** Maximum number of lines for CSS line-clamp (default: 2) */
  maxLines?: number;
  /** Character limit for fallback truncation (default: 200 - high enough to let CSS work, low enough to prevent mega-descriptions) */
  fallbackChars?: number;
  /** Whether to include agentic_tool as final fallback (default: false) */
  includeAgentFallback?: boolean;
  /** Whether to include session_id as final fallback (default: false) */
  includeIdFallback?: boolean;
}

/**
 * Get display title for a session with smart truncation
 *
 * Priority order:
 * 1. session.title (user-provided)
 * 2. session.description (first prompt, may be very long)
 * 3. session.agentic_tool (if includeAgentFallback=true)
 * 4. session_id short form (if includeIdFallback=true)
 *
 * Strategy: Let CSS line-clamp do the heavy lifting for responsive truncation.
 * Only truncate at character limit for EXTREMELY long descriptions (>200 chars)
 * to prevent performance issues with mega-strings.
 *
 * This allows 2-line clamp to work correctly at all container widths:
 * - Wide container: ~100 chars per line = 200 chars total
 * - Narrow container: ~30 chars per line = 60 chars total
 * - CSS adapts automatically, no manual truncation needed
 *
 * @example
 * ```tsx
 * // In a component
 * <Typography.Text style={getSessionTitleStyles(2)}>
 *   {getSessionDisplayTitle(session)}
 * </Typography.Text>
 * ```
 */
export function getSessionDisplayTitle(
  session: Pick<Session, 'title' | 'description' | 'agentic_tool' | 'session_id'>,
  options: FormatSessionTitleOptions = {}
): string {
  const { fallbackChars = 200, includeAgentFallback = false, includeIdFallback = false } = options;

  // 1. Prefer user-provided title (always show full text, CSS handles clamp)
  if (session.title) {
    return session.title;
  }

  // 2. Use description (first prompt) - let CSS handle truncation in most cases
  if (session.description) {
    // Only truncate EXTREMELY long descriptions to prevent performance issues
    // CSS line-clamp will handle the visual truncation at 2 lines
    if (session.description.length > fallbackChars) {
      return `${session.description.substring(0, fallbackChars)}...`;
    }
    // Return full description, CSS will clamp to 2 lines at any container width
    return session.description;
  }

  // 3. Fallback to agentic tool name if enabled
  if (includeAgentFallback) {
    return session.agentic_tool;
  }

  // 4. Final fallback to short session ID if enabled
  if (includeIdFallback) {
    return `Session ${session.session_id.substring(0, 8)}`;
  }

  // Default fallback (shouldn't happen, but defensive)
  return 'Untitled Session';
}

/**
 * Get CSS styles for session title display with line-clamp
 *
 * Use this with getSessionDisplayTitle() for consistent truncation behavior.
 * Uses modern CSS line-clamp which is now supported in all major browsers.
 *
 * How it works:
 * - Text wraps naturally based on container width
 * - After N lines (default: 2), remaining text is hidden with ellipsis
 * - Automatically responsive - works at any container width
 *
 * @param maxLines - Number of lines to display before truncating (default: 2)
 * @param lineHeight - Line height multiplier for calculating max-height (default: 1.5)
 * @returns CSS properties object for React style prop
 *
 * @example
 * ```tsx
 * <Typography.Text style={getSessionTitleStyles(2)}>
 *   {getSessionDisplayTitle(session)}
 * </Typography.Text>
 * ```
 */
export function getSessionTitleStyles(maxLines = 2, lineHeight = 1.5): CSSProperties {
  return {
    display: '-webkit-box',
    WebkitLineClamp: maxLines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    // Fallback for browsers that don't support line-clamp (very rare now)
    maxHeight: `${maxLines * lineHeight}em`,
    lineHeight,
  };
}
