/**
 * UI Constants
 *
 * Centralized constants for consistent UI behavior across components.
 */

/**
 * Text Truncation Limits
 *
 * Used by CollapsibleText and other components to determine when to show
 * "show more/less" controls for long content.
 */
export const TEXT_TRUNCATION = {
  /**
   * Default number of lines to show before truncating
   * Used in tool outputs, thought bubbles, etc.
   */
  DEFAULT_LINES: 10,

  /**
   * Number of lines for compact displays (e.g., in collapsed states)
   */
  COMPACT_LINES: 3,

  /**
   * Default character limit for truncation
   * Used when line-based truncation isn't appropriate
   */
  DEFAULT_CHARS: 500,

  /**
   * Character limit for preview text in collapsed states
   */
  PREVIEW_CHARS: 150,
} as const;
