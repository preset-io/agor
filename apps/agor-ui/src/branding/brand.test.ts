import { describe, expect, it } from 'vitest';
import { BRAND, brandMarkHref, surfaceTitle } from './brand';

describe('brandMarkHref', () => {
  it('prefixes the mark file with the Vite base path', () => {
    expect(brandMarkHref('/ui/')).toBe('/ui/favicon.png');
    expect(brandMarkHref('/')).toBe('/favicon.png');
  });

  it('returns an absolute (base-rooted) URL, never a bare relative href', () => {
    // A relative href (e.g. "favicon.png") resolves against the current
    // document path and 404s on nested SPA routes like /ui/knowledge/<ns>/<doc>.
    for (const base of ['/', '/ui/', '/some/deep/base/']) {
      expect(brandMarkHref(base).startsWith('/')).toBe(true);
    }
  });

  it('defaults to the build-time base path', () => {
    expect(brandMarkHref()).toBe(`${import.meta.env.BASE_URL}${BRAND.markFile}`);
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
