// biome-ignore-all lint/plugin/noHardcodedColorLiteral: persisted color fixtures verify zone color conversion
import { describe, expect, it } from 'vitest';
import { toTranslucentZoneFill } from './zoneAppearance';

describe('toTranslucentZoneFill', () => {
  it('preserves source alpha while applying the shared zone opacity', () => {
    expect(toTranslucentZoneFill('rgba(255, 0, 0, 0.5)', 'fallback')).toBe('rgba(255, 0, 0, 0.05)');
  });
});
