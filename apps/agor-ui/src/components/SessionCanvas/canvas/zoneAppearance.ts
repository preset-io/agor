import { AggregationColor } from 'antd/es/color-picker/color';

/** Opacity used by the default translucent zone fill palette. */
export const ZONE_CONTENT_OPACITY = 0.1;

/**
 * Apply the historical zone-fill opacity to a user-selected color.
 *
 * Kept here so the compact appearance popover, full settings modal, and zone
 * renderer cannot drift when migrating the legacy single `color` field.
 */
export function toTranslucentZoneFill(color: string, fallback: string): string {
  try {
    const rgb = new AggregationColor(color).toRgb();
    // biome-ignore lint/plugin/noHardcodedColorLiteral: user color resolver emits CSS syntax from parsed channels
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${rgb.a * ZONE_CONTENT_OPACITY})`;
  } catch {
    return fallback;
  }
}
