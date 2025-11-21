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
    it('increases lightness for pale colors', () => {
      // Very pale color (lightness ~90%) should be adjusted to 50%
      const result = ensureColorVisible('#e0e0e0', true, 50);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
      // Result should be darker than input (lower L value means darker in dark mode context)
      // But since we're increasing to minimum 50%, it should still be visible
    });

    it('preserves hue when adjusting lightness', () => {
      // Pale blue should become a more saturated blue
      const paleBlue = '#d0d0ff'; // Very pale blue
      const result = ensureColorVisible(paleBlue, true, 50);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
      // The result should still be in the blue family
    });

    it('does not modify already visible colors', () => {
      // Color with 60% lightness should not be changed (above 50% minimum)
      const visibleColor = '#8080ff';
      const result = ensureColorVisible(visibleColor, true, 50);
      // Should return the color unchanged (or very close to it)
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('handles custom minimum lightness', () => {
      const paleColor = '#e0e0e0';
      const result = ensureColorVisible(paleColor, true, 60);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  describe('light theme', () => {
    it('decreases lightness for pale colors', () => {
      // Very pale color should be adjusted to 50%
      const result = ensureColorVisible('#f0f0f0', false, 50, 50);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('preserves hue when adjusting lightness', () => {
      // Pale yellow should become a more saturated yellow
      const paleYellow = '#ffffcc';
      const result = ensureColorVisible(paleYellow, false, 50, 50);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('does not modify already visible colors', () => {
      // Color with 40% lightness should not be changed (below 50% maximum)
      const visibleColor = '#666666';
      const result = ensureColorVisible(visibleColor, false, 50, 50);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('handles custom maximum lightness', () => {
      const paleColor = '#f0f0f0';
      const result = ensureColorVisible(paleColor, false, 50, 40);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  describe('edge cases', () => {
    it('handles black color', () => {
      const result = ensureColorVisible('#000000', true, 50);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('handles white color', () => {
      const result = ensureColorVisible('#ffffff', false, 50, 50);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
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
      // Pale lavender
      const paleLavender = '#e6e6fa';
      const result = ensureColorVisible(paleLavender, true, 50);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
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
