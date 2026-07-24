import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND, brandMarkHref, surfaceTitle } from './brand';

describe('brandMarkHref', () => {
  it('prefixes the mark file with the Vite base path', () => {
    expect(brandMarkHref('/ui/')).toBe('/ui/logo.svg');
    expect(brandMarkHref('/')).toBe('/logo.svg');
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

  it('keeps the package-local deployment copy identical to the canonical docs SVG', () => {
    const uiLogo = readFileSync(path.resolve(process.cwd(), 'public/logo.svg'));
    const canonicalLogo = readFileSync(path.resolve(process.cwd(), '../agor-docs/public/logo.svg'));

    expect(uiLogo.equals(canonicalLogo)).toBe(true);
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
