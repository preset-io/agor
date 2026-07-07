import { describe, expect, it } from 'vitest';
import {
  clampZoneFontSize,
  effectiveLabelFontSize,
  sanitizeZoneFontSize,
  statusFontSizeFor,
  ZONE_FONT_SIZE_MAX,
  ZONE_FONT_SIZE_MIN,
} from './zoneFontSize';

describe('sanitizeZoneFontSize', () => {
  it('passes through in-range values', () => {
    expect(sanitizeZoneFontSize(20)).toBe(20);
  });
  it('clamps to [MIN, MAX]', () => {
    expect(sanitizeZoneFontSize(2)).toBe(ZONE_FONT_SIZE_MIN);
    expect(sanitizeZoneFontSize(1_000_000)).toBe(ZONE_FONT_SIZE_MAX);
    expect(sanitizeZoneFontSize(-50)).toBe(ZONE_FONT_SIZE_MIN);
  });
  it('returns undefined for unusable values', () => {
    expect(sanitizeZoneFontSize(undefined)).toBeUndefined();
    expect(sanitizeZoneFontSize(Number.NaN)).toBeUndefined();
    expect(sanitizeZoneFontSize(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(sanitizeZoneFontSize('24' as unknown)).toBeUndefined();
  });
});

describe('effectiveLabelFontSize', () => {
  it('uses the sanitized persisted value when valid', () => {
    expect(effectiveLabelFontSize(20, 14)).toBe(20);
  });
  it('clamps an out-of-range persisted value rather than rendering it raw', () => {
    expect(effectiveLabelFontSize(1_000_000, 14)).toBe(ZONE_FONT_SIZE_MAX);
  });
  it('falls back to the theme default when unset or invalid', () => {
    expect(effectiveLabelFontSize(undefined, 14)).toBe(14);
    expect(effectiveLabelFontSize(Number.NaN, 14)).toBe(14);
  });
});

describe('statusFontSizeFor', () => {
  it('falls back to the theme status default when no custom size is set', () => {
    expect(statusFontSizeFor(undefined, 14, 12)).toBe(12);
  });
  it('scales from the (sanitized) label size preserving the label→status ratio', () => {
    // 24 * (12 / 14) ≈ 20.57 → 21
    expect(statusFontSizeFor(24, 14, 12)).toBe(21);
  });
  it('clamps to 1px when the scaled value would round to 0', () => {
    // sanitize(10) = 10; 10 * (1 / 1000) = 0.01 → Math.round → 0; Math.max(1, 0)
    // = 1. Without the clamp this would be 0 — so toBe(1) actually exercises it.
    expect(statusFontSizeFor(10, 1000, 1)).toBe(1);
  });
});

describe('clampZoneFontSize', () => {
  it('steps within range', () => {
    expect(clampZoneFontSize(20, 2)).toBe(22);
    expect(clampZoneFontSize(20, -2)).toBe(18);
  });
  it('clamps at MAX', () => {
    expect(clampZoneFontSize(ZONE_FONT_SIZE_MAX, 2)).toBe(ZONE_FONT_SIZE_MAX);
  });
  it('clamps at MIN', () => {
    expect(clampZoneFontSize(ZONE_FONT_SIZE_MIN, -2)).toBe(ZONE_FONT_SIZE_MIN);
  });
});
