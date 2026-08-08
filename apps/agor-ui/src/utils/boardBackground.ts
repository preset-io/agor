/**
 * Shared logic for resolving a board's background.
 *
 * A board's look is driven by two persisted fields: `background_color` (a
 * solid color, a gradient, or any CSS `background` value) and `custom_css`
 * (extra scoped CSS for animations/keyframes). When neither carries a value
 * the board renders the theme-aware default (`DEFAULT_BACKGROUNDS`).
 *
 * These helpers are the single source of truth for "is this board styled?"
 * and are used by both the canvas renderer and the background editor so the
 * two never disagree about which mode a board is in.
 *
 * Note: there is deliberately no "legacy default" special-casing here. The old
 * auto-assigned Gold Shimmer gradient is a real, selectable preset value, so it
 * must render exactly as stored — treating it as "unset" would make the preset
 * impossible to preview or apply. New boards get the sober default simply by
 * persisting no background at all (see the boards repository).
 */

/** Whether an explicit background color/gradient value is present. */
export function hasBackgroundValue(backgroundColor: string | undefined | null): boolean {
  return Boolean(backgroundColor?.trim());
}

/**
 * Whether a board carries any explicit styling (background or custom CSS).
 * When false the board is "on the default".
 */
export function hasBoardStyling(
  backgroundColor: string | undefined | null,
  customCss: string | undefined | null
): boolean {
  return hasBackgroundValue(backgroundColor) || Boolean(customCss?.trim());
}
