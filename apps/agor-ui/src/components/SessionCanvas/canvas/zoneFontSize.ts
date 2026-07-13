/**
 * Pure helpers for the zone label/status font size.
 *
 * Kept framework-free so the clamp/scale math can be unit-tested without
 * rendering the node. `fontSize` is a user/MCP-writable field, so every read
 * goes through `sanitizeZoneFontSize` to defend against bad data (negative,
 * non-finite, absurdly large) before it reaches the DOM.
 */

/** Zone label font-size bounds and stepper increment (px). */
export const ZONE_FONT_SIZE_MIN = 10;
export const ZONE_FONT_SIZE_MAX = 48;
export const ZONE_FONT_SIZE_STEP = 2;

/**
 * Sanitize a persisted zone `fontSize` on read.
 *
 * Returns `undefined` when the value is unusable (not a finite number) so the
 * caller can fall back to the theme default; otherwise clamps into
 * [MIN, MAX].
 */
export function sanitizeZoneFontSize(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(ZONE_FONT_SIZE_MAX, Math.max(ZONE_FONT_SIZE_MIN, value));
}

/**
 * Effective label font size: the sanitized persisted value, or the theme
 * default when unset/invalid.
 */
export function effectiveLabelFontSize(fontSize: number | undefined, themeDefault: number): number {
  return sanitizeZoneFontSize(fontSize) ?? themeDefault;
}

/**
 * Status font size: scaled down from the (sanitized) label size when a custom
 * size is set, preserving the theme's label→status ratio. Never below 1px.
 * Falls back to the theme small default when no custom size is set.
 */
export function statusFontSizeFor(
  fontSize: number | undefined,
  themeLabelDefault: number,
  themeStatusDefault: number
): number {
  const sanitized = sanitizeZoneFontSize(fontSize);
  if (sanitized === undefined) return themeStatusDefault;
  return Math.max(1, Math.round(sanitized * (themeStatusDefault / themeLabelDefault)));
}

/**
 * Next font size after a stepper click, clamped to [MIN, MAX].
 */
export function clampZoneFontSize(current: number, delta: number): number {
  return Math.max(ZONE_FONT_SIZE_MIN, Math.min(ZONE_FONT_SIZE_MAX, current + delta));
}
