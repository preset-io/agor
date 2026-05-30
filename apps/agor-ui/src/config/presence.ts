/**
 * Configuration constants for multiplayer presence features
 * (cursor tracking, facepile, typing indicators)
 */

export const PRESENCE_CONFIG = {
  /** Throttle cursor position updates to max 10 per second */
  CURSOR_EMIT_THROTTLE_MS: 100,

  /**
   * Coalesce global facepile updates to at most once every 10 seconds per user
   * while they stay on the same board. Facepile only needs liveness + board,
   * not every cursor coordinate sample.
   */
  FACEPILE_REFRESH_MS: 10_000,

  /** Hide cursor after 5 seconds of no movement */
  CURSOR_HIDE_AFTER_MS: 5000,

  /** Show user as "active" in facepile if seen within last 5 minutes */
  ACTIVE_USER_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes

  /** Clear typing indicator after 3 seconds of no activity */
  TYPING_TIMEOUT_MS: 3000,
} as const;
