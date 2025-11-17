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

/**
 * Default board backgrounds keyed by theme mode.
 * Used when a board doesn't have a custom background configured.
 */
export const DEFAULT_BACKGROUNDS = {
  dark: 'radial-gradient(ellipse at top, #1b2735 0%, #090a0f 100%), radial-gradient(circle at 20% 50%, rgba(120, 0, 255, 0.3) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(255, 0, 120, 0.3) 0%, transparent 50%)',
  light:
    'radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.75) 0%, rgba(255, 255, 255, 0) 45%), radial-gradient(circle at 50% 50%, rgba(210, 216, 224, 0.35) 35%, rgba(210, 216, 224, 0) 80%), linear-gradient(90deg, #d9dde3 0%, #ffffff 45%, #ffffff 55%, #d9dde3 100%)',
} as const;
