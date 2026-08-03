// biome-ignore-all lint/plugin/noHardcodedColorLiteral: fixed SVG brand fills are the asset regression contract
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND, brandBadgeHref, brandMarkHref, surfaceTitle } from './brand';

describe('brandMarkHref', () => {
  it('prefixes the mark file with the Vite base path', () => {
    expect(brandMarkHref('/ui/')).toBe('/ui/logo-mark.svg');
    expect(brandMarkHref('/')).toBe('/logo-mark.svg');
    expect(brandBadgeHref('/ui/')).toBe('/ui/logo.svg');
    expect(brandBadgeHref('/')).toBe('/logo.svg');
  });

  it('returns an absolute (base-rooted) URL, never a bare relative href', () => {
    // A relative href (e.g. "logo.svg") resolves against the current
    // document path and 404s on nested SPA routes like /ui/knowledge/<ns>/<doc>.
    for (const base of ['/', '/ui/', '/some/deep/base/']) {
      expect(brandMarkHref(base).startsWith('/')).toBe(true);
    }
  });

  it('defaults to the build-time base path', () => {
    expect(brandMarkHref()).toBe(`${import.meta.env.BASE_URL}${BRAND.markFile}`);
  });

  it.each(['logo.svg', 'logo-mark.svg'])(
    'keeps the package-local %s deployment copy identical to docs',
    (filename) => {
      const uiLogo = readFileSync(path.resolve(process.cwd(), 'public', filename));
      const docsLogo = readFileSync(path.resolve(process.cwd(), '../agor-docs/public', filename));

      expect(uiLogo.equals(docsLogo)).toBe(true);
    }
  );

  it('keeps the display mark transparent and the badge explicitly backed', () => {
    const mark = readFileSync(path.resolve(process.cwd(), 'public/logo-mark.svg'), 'utf8');
    const badge = readFileSync(path.resolve(process.cwd(), 'public/logo.svg'), 'utf8');

    expect(mark).not.toContain('rgb(26,32,42)');
    expect(badge).toContain('rgb(26,32,42)');
  });
});

describe('surfaceTitle', () => {
  it('joins a surface label to the brand name', () => {
    expect(surfaceTitle('Knowledge')).toBe('Knowledge · Agor');
  });

  it('returns the bare brand name when no label is given', () => {
    expect(surfaceTitle()).toBe('Agor');
    expect(surfaceTitle(null)).toBe('Agor');
    expect(surfaceTitle('')).toBe('Agor');
  });
});
