import { AggregationColor } from 'antd/es/color-picker/color';

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

/**
 * Ensures a color has sufficient visibility by adjusting lightness while preserving hue.
 * For dark themes: increases lightness for pale colors
 * For light themes: decreases lightness for pale colors
 *
 * @param color - Input color (any CSS color format)
 * @param isDark - Whether the current theme is dark
 * @param minLightness - Minimum lightness percentage for dark theme (0-100)
 * @param maxLightness - Maximum lightness percentage for light theme (0-100)
 * @returns Adjusted color as hex string
 */
export const ensureColorVisible = (
  color: string,
  isDark: boolean,
  minLightness = 50,
  maxLightness = 50
): string => {
  try {
    const colorObj = new AggregationColor(color);
    const hsl = colorObj.toHsl();

    // Convert lightness from [0, 1] to [0, 100] for comparison
    const lightnessPercent = hsl.l * 100;

    // For dark theme: ensure color is bright enough
    if (isDark && lightnessPercent < minLightness) {
      hsl.l = minLightness / 100;
      return new AggregationColor(hsl).toHexString();
    }

    // For light theme: ensure color is dark enough
    if (!isDark && lightnessPercent > maxLightness) {
      hsl.l = maxLightness / 100;
      return new AggregationColor(hsl).toHexString();
    }

    // Color is already visible
    return colorObj.toHexString();
  } catch {
    // Fallback if color parsing fails
    return isDark ? '#ffffff' : '#000000';
  }
};
