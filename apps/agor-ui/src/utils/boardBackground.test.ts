// biome-ignore-all lint/plugin/noHardcodedColorLiteral: test fixtures assert on literal CSS background values
import { GOLD_SHIMMER_BOARD_BACKGROUND } from '@agor/core/design/board-backgrounds';
import { describe, expect, it } from 'vitest';
import { hasBackgroundValue, hasBoardStyling } from './boardBackground';

describe('boardBackground helpers', () => {
  describe('hasBackgroundValue', () => {
    it('is false for empty/undefined', () => {
      expect(hasBackgroundValue(undefined)).toBe(false);
      expect(hasBackgroundValue(null)).toBe(false);
      expect(hasBackgroundValue('')).toBe(false);
      expect(hasBackgroundValue('   ')).toBe(false);
    });

    it('is true for any non-empty value, including the Gold Shimmer gradient', () => {
      expect(hasBackgroundValue('#1a1a1a')).toBe(true);
      expect(hasBackgroundValue('linear-gradient(180deg, #000, #111)')).toBe(true);
      // Gold Shimmer is a real, selectable preset value — never treated as "unset".
      expect(hasBackgroundValue(GOLD_SHIMMER_BOARD_BACKGROUND)).toBe(true);
    });
  });

  describe('hasBoardStyling', () => {
    it('is false only when both fields are empty', () => {
      expect(hasBoardStyling(undefined, undefined)).toBe(false);
      expect(hasBoardStyling('', '')).toBe(false);
    });

    it('is true when a background value is present (Gold Shimmer included)', () => {
      expect(hasBoardStyling('#222', undefined)).toBe(true);
      expect(hasBoardStyling(GOLD_SHIMMER_BOARD_BACKGROUND, undefined)).toBe(true);
    });

    it('is true when custom CSS is present even without a background', () => {
      expect(hasBoardStyling(undefined, 'animation: x 2s;')).toBe(true);
    });
  });
});
