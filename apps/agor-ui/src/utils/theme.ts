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

type Rgb = { r: number; g: number; b: number };

const toOpaqueRgb = (color: string, under: Rgb): Rgb => {
  const { r, g, b, a } = new AggregationColor(color).toRgb();
  return {
    r: r * a + under.r * (1 - a),
    g: g * a + under.g * (1 - a),
    b: b * a + under.b * (1 - a),
  };
};

const relativeLuminance = ({ r, g, b }: Rgb): number => {
  const linearize = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
};

/** WCAG contrast of a (possibly translucent) foreground over a background laid on `base`. */
export const contrastRatio = (foreground: string, background: string, base: string): number => {
  const ground = toOpaqueRgb(background, toOpaqueRgb(base, { r: 0, g: 0, b: 0 }));
  const [light, dark] = [
    relativeLuminance(toOpaqueRgb(foreground, ground)),
    relativeLuminance(ground),
  ].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

/**
 * First candidate reaching `minRatio` on the background. If none does, the
 * highest-contrast candidate keeps its hue and moves away from the background's
 * brightness until it passes.
 */
export const pickAccessibleColor = (
  candidates: string[],
  background: string,
  base: string,
  minRatio = 4.5
): string => {
  const ratio = (color: string) => contrastRatio(color, background, base);
  const passing = candidates.find((color) => ratio(color) >= minRatio);
  if (passing) return passing;
  const best = [...candidates].sort((x, y) => ratio(y) - ratio(x))[0];
  const ground = toOpaqueRgb(background, toOpaqueRgb(base, { r: 0, g: 0, b: 0 }));
  const darken = relativeLuminance(ground) > 0.18;
  const hsb = new AggregationColor(best).toHsb();
  for (let step = 0; step < 50; step++) {
    if (darken) hsb.b = Math.max(0, hsb.b - 0.02);
    else if (hsb.b < 1) hsb.b = Math.min(1, hsb.b + 0.02);
    else hsb.s = Math.max(0, hsb.s - 0.02);
    const adjusted = new AggregationColor({ ...hsb, a: 1 }).toHexString();
    if (ratio(adjusted) >= minRatio) return adjusted;
  }
  return darken ? ABSOLUTE_BLACK : ABSOLUTE_WHITE;
};
