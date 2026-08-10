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

  /**
   * Character limit for Bash command preview in collapsed tool headers
   */
  BASH_COMMAND_PREVIEW_CHARS: 70,
} as const;

/**
 * Default board backgrounds keyed by theme mode.
 * Used when a board doesn't have a custom background configured.
 */
export const DEFAULT_BACKGROUNDS = {
  // Sober, primarily-dark default: a deep near-black vertical base with two
  // restrained cool glows (top-center + lower-right) for gentle depth. Quiet
  // enough to sit behind cards and zones without competing with them.
  // biome-ignore lint/plugin/noHardcodedColorLiteral: centralized theme-keyed default for board backgrounds
  dark: 'radial-gradient(75% 55% at 50% -8%, rgba(86, 108, 150, 0.22) 0%, rgba(86, 108, 150, 0) 60%), radial-gradient(60% 45% at 88% 108%, rgba(64, 82, 120, 0.16) 0%, rgba(64, 82, 120, 0) 60%), linear-gradient(180deg, #0f131a 0%, #0b0e14 55%, #090b10 100%)',
  // Light counterpart: a soft neutral paper tone with the same restrained
  // structure so the canvas reads as intentional but calm.
  light:
    // biome-ignore lint/plugin/noHardcodedColorLiteral: centralized theme-keyed default for board backgrounds
    'radial-gradient(75% 55% at 50% -8%, rgba(255, 255, 255, 0.9) 0%, rgba(255, 255, 255, 0) 60%), radial-gradient(60% 45% at 88% 108%, rgba(203, 213, 229, 0.5) 0%, rgba(203, 213, 229, 0) 60%), linear-gradient(180deg, #eef1f6 0%, #e7ebf2 55%, #e2e7ef 100%)',
} as const;
