import { AggregationColor } from 'antd/es/color-picker/color';
import { describe, expect, it } from 'vitest';
import { ensureColorVisible, isDarkTheme } from './theme';

describe('isDarkTheme', () => {
  it('detects dark theme from #0 prefix', () => {
    expect(isDarkTheme({ colorBgLayout: '#000000' })).toBe(true);
    expect(isDarkTheme({ colorBgLayout: '#0a0a0a' })).toBe(true);
  });

  it('detects dark theme from rgb(0 prefix', () => {
    expect(isDarkTheme({ colorBgLayout: 'rgb(0, 0, 0)' })).toBe(true);
    expect(isDarkTheme({ colorBgLayout: 'rgba(0, 0, 0, 1)' })).toBe(true);
  });

  it('detects light theme', () => {
    expect(isDarkTheme({ colorBgLayout: '#ffffff' })).toBe(false);
    expect(isDarkTheme({ colorBgLayout: '#f0f0f0' })).toBe(false);
  });

  it('handles missing colorBgLayout', () => {
    expect(isDarkTheme({})).toBe(false);
  });
});

describe('ensureColorVisible', () => {
  describe('dark theme', () => {
    it('increases brightness for pale colors', () => {
      // Very pale color (brightness ~88%) should be adjusted to 50%
      const result = ensureColorVisible('#e0e0e0', true, 50);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);

      // Verify brightness was actually adjusted to 50%
      const resultColor = new AggregationColor(result);
      const resultHsb = resultColor.toHsb();
      expect(Math.round(resultHsb.b)).toBe(50);
    });

    it('preserves hue when adjusting brightness', () => {
      // Pale blue should become a more saturated blue
      const paleBlue = '#d0d0ff'; // Very pale blue
      const inputColor = new AggregationColor(paleBlue);
      const inputHsb = inputColor.toHsb();

      const result = ensureColorVisible(paleBlue, true, 50);
      const resultColor = new AggregationColor(result);
      const resultHsb = resultColor.toHsb();

      // Hue should be preserved (blue)
      expect(Math.round(resultHsb.h)).toBe(Math.round(inputHsb.h));
      // Brightness should be adjusted to 50%
      expect(Math.round(resultHsb.b)).toBe(50);
    });

    it('does not modify already visible colors', () => {
      // Color with 100% brightness should not be changed (above 50% minimum)
      const visibleColor = '#8080ff';
      const inputColor = new AggregationColor(visibleColor);
      const inputHsb = inputColor.toHsb();

      const result = ensureColorVisible(visibleColor, true, 50);
      const resultColor = new AggregationColor(result);
      const resultHsb = resultColor.toHsb();

      // Brightness should remain unchanged (already above 50%)
      expect(Math.round(resultHsb.b)).toBe(Math.round(inputHsb.b));
    });

    it('handles custom minimum brightness', () => {
      const paleColor = '#e0e0e0';
      const result = ensureColorVisible(paleColor, true, 60);
      const resultColor = new AggregationColor(result);
      const resultHsb = resultColor.toHsb();

      // Should be adjusted to custom 60% threshold
      expect(Math.round(resultHsb.b)).toBe(60);
    });
  });

  describe('light theme', () => {
    it('decreases brightness for pale colors', () => {
      // Very pale color (brightness ~94%) should be adjusted to 50%
      const result = ensureColorVisible('#f0f0f0', false, 50, 50);
      const resultColor = new AggregationColor(result);
      const resultHsb = resultColor.toHsb();

      // Should be darkened to 50%
      expect(Math.round(resultHsb.b)).toBe(50);
    });

    it('preserves hue when adjusting brightness', () => {
      // Pale yellow should become a more saturated yellow
      const paleYellow = '#ffffcc';
      const inputColor = new AggregationColor(paleYellow);
      const inputHsb = inputColor.toHsb();

      const result = ensureColorVisible(paleYellow, false, 50, 50);
      const resultColor = new AggregationColor(result);
      const resultHsb = resultColor.toHsb();

      // Hue should be preserved (yellow)
      expect(Math.round(resultHsb.h)).toBe(Math.round(inputHsb.h));
      // Brightness should be adjusted to 50%
      expect(Math.round(resultHsb.b)).toBe(50);
    });

    it('does not modify already visible colors', () => {
      // Color with 40% brightness should not be changed (below 50% maximum)
      const visibleColor = '#666666';
      const inputColor = new AggregationColor(visibleColor);
      const inputHsb = inputColor.toHsb();

      const result = ensureColorVisible(visibleColor, false, 50, 50);
      const resultColor = new AggregationColor(result);
      const resultHsb = resultColor.toHsb();

      // Brightness should remain unchanged (already below 50%)
      expect(Math.round(resultHsb.b)).toBe(Math.round(inputHsb.b));
    });

    it('handles custom maximum brightness', () => {
      const paleColor = '#f0f0f0';
      const result = ensureColorVisible(paleColor, false, 50, 40);
      const resultColor = new AggregationColor(result);
      const resultHsb = resultColor.toHsb();

      // Should be darkened to custom 40% threshold
      expect(Math.round(resultHsb.b)).toBe(40);
    });
  });

  describe('edge cases', () => {
    it('handles black color in dark theme', () => {
      const result = ensureColorVisible('#000000', true, 50);
      const resultColor = new AggregationColor(result);
      const resultHsb = resultColor.toHsb();

      // Black (0% brightness) should be brightened to 50%
      expect(Math.round(resultHsb.b)).toBe(50);
    });

    it('handles white color in light theme', () => {
      const result = ensureColorVisible('#ffffff', false, 50, 50);
      const resultColor = new AggregationColor(result);
      const resultHsb = resultColor.toHsb();

      // White (100% brightness) should be darkened to 50%
      expect(Math.round(resultHsb.b)).toBe(50);
    });

    it('handles invalid color input', () => {
      const result = ensureColorVisible('not-a-color', true, 50);
      // Should fallback to white for dark theme
      expect(result).toBe('#ffffff');
    });

    it('handles rgb format', () => {
      const result = ensureColorVisible('rgb(200, 200, 200)', true, 50);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('handles hsl format', () => {
      const result = ensureColorVisible('hsl(240, 100%, 80%)', true, 50);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  describe('real-world zone colors', () => {
    it('ensures visibility for common pale zone borders', () => {
      // Pale lavender (brightness ~98%)
      const paleLavender = '#e6e6fa';
      const result = ensureColorVisible(paleLavender, true, 50);
      const resultColor = new AggregationColor(result);
      const resultHsb = resultColor.toHsb();

      // Should be adjusted to 50% brightness
      expect(Math.round(resultHsb.b)).toBe(50);
      expect(result.toLowerCase()).not.toBe(paleLavender.toLowerCase());
    });

    it('preserves already visible zone borders', () => {
      // Medium blue - already visible
      const mediumBlue = '#4a90e2';
      const result = ensureColorVisible(mediumBlue, true, 50);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });
});
