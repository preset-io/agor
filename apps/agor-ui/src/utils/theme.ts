import { AggregationColor } from 'antd/es/color-picker/color';

// Contrast endpoints are physical display colors, not theme surfaces. They
// must remain absolute so a dark algorithm cannot turn both candidates white.
// biome-ignore lint/plugin/noHardcodedColorLiteral: absolute WCAG contrast endpoint
const ABSOLUTE_BLACK = '#000000';
// biome-ignore lint/plugin/noHardcodedColorLiteral: absolute WCAG contrast endpoint
const ABSOLUTE_WHITE = '#ffffff';

/**
 * Shared theme helpers.
 *
 * Centralizes theme detection logic so components can make consistent
 * decisions based on the current Ant Design token values.
 */
export const isDarkTheme = (token: { colorBgLayout?: string | undefined }): boolean =>
  token.colorBgLayout?.startsWith?.('#0') ||
  token.colorBgLayout?.startsWith?.('rgb(0') ||
  token.colorBgLayout?.startsWith?.('rgba(0') ||
  false;

/** Pick a theme-aware foreground for an arbitrary user/data color. */
export const getContrastingTextColor = (
  background: string,
  token: { colorText: string }
): string => {
  try {
    const { r, g, b, a } = new AggregationColor(background).toRgb();
    if (a < 0.3) return token.colorText;
    const linearize = (channel: number) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
    const blackContrast = (luminance + 0.05) / 0.05;
    const whiteContrast = 1.05 / (luminance + 0.05);
    return blackContrast >= whiteContrast ? ABSOLUTE_BLACK : ABSOLUTE_WHITE;
  } catch {
    return token.colorText;
  }
};

/**
 * Ensures a color has sufficient visibility by adjusting brightness while preserving hue.
 * For dark themes: increases brightness for pale colors
 * For light themes: decreases brightness for pale colors
 *
 * @param color - Input color (any CSS color format)
 * @param isDark - Whether the current theme is dark
 * @param minBrightness - Minimum brightness percentage for dark theme (0-100)
 * @param maxBrightness - Maximum brightness percentage for light theme (0-100)
 * @returns Adjusted color as hex string
 */
export const ensureColorVisible = (
  color: string,
  isDark: boolean,
  minBrightness = 50,
  maxBrightness = 50
): string => {
  try {
    // Clamp inputs to valid range [0, 100]
    const clampedMin = Math.max(0, Math.min(100, minBrightness));
    const clampedMax = Math.max(0, Math.min(100, maxBrightness));

    const colorObj = new AggregationColor(color);
    const hsb = colorObj.toHsb();

    // For dark theme: ensure color is bright enough
    if (isDark && hsb.b < clampedMin) {
      hsb.b = clampedMin;
      return new AggregationColor(hsb).toHexString();
    }

    // For light theme: ensure color is dark enough
    if (!isDark && hsb.b > clampedMax) {
      hsb.b = clampedMax;
      return new AggregationColor(hsb).toHexString();
    }

    // Color is already visible
    return colorObj.toHexString();
  } catch {
    // Fallback if color parsing fails
    return isDark ? ABSOLUTE_WHITE : ABSOLUTE_BLACK;
  }
};
