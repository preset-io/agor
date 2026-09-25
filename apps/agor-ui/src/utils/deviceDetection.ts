/**
 * Viewport-based shell selection for the responsive web app.
 *
 * The shell is chosen by viewport WIDTH, not device user-agent, so a landscape
 * iPad / laptop gets the desktop 3-pane shell while a phone or portrait iPad
 * gets the touch shell. Rotating a tablet changes `innerWidth`, so width alone
 * also captures orientation.
 */

/**
 * Viewports narrower than this (px) use the mobile shell; this width and wider
 * use the desktop shell. 1024 keeps a landscape iPad on desktop and a portrait
 * iPad on mobile. Single source of truth for the shell breakpoint.
 */
export const MOBILE_SHELL_MAX_WIDTH = 1024;

/** The exact complement of AntD's `md` query, so it agrees with `!screens.md` at fractional widths too. */
export const COMPACT_SETTINGS_MEDIA_QUERY = 'not all and (min-width: 768px)';

/** Minimum touch-target size (px) for interactive controls on mobile-shell viewports. */
export const MOBILE_TOUCH_TARGET = 44;

/** Whether the current viewport should render the mobile shell. */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < MOBILE_SHELL_MAX_WIDTH;
}
