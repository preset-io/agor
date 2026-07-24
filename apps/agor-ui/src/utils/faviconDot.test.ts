// biome-ignore-all lint/plugin/noHardcodedColorLiteral: exact favicon pixel inputs are the regression-test contract
import { describe, expect, it } from 'vitest';
import { createFaviconWithDot } from './faviconDot';

describe('createFaviconWithDot', () => {
  it('keeps the canonical SVG when no status overlay is needed', async () => {
    await expect(
      createFaviconWithDot('/logo.svg', false, false, {
        running: '#ffffff',
        ready: '#00ff00',
        border: '#000000',
      })
    ).resolves.toBe('/logo.svg');
  });
});
