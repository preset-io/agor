import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { setBundledUiFallbackHeaders, setBundledUiStaticHeaders } from './static-assets';

function res(): Response & { headers: Map<string, string> } {
  const headers = new Map<string, string>();
  return {
    headers,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
  } as unknown as Response & { headers: Map<string, string> };
}

describe('bundled UI cache headers', () => {
  it('marks hashed Vite assets immutable', () => {
    const r = res();
    setBundledUiStaticHeaders(r, '/pkg/dist/ui/assets/index-Ck4a1b2c.js');
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('keeps index.html revalidatable', () => {
    const r = res();
    setBundledUiStaticHeaders(r, '/pkg/dist/ui/index.html');
    expect(r.headers.get('cache-control')).toBe('no-cache');
  });

  it('keeps precompressed index.html revalidatable', () => {
    const gzip = res();
    setBundledUiStaticHeaders(gzip, '/pkg/dist/ui/index.html.gz');
    expect(gzip.headers.get('cache-control')).toBe('no-cache');

    const brotli = res();
    setBundledUiStaticHeaders(brotli, '/pkg/dist/ui/index.html.br');
    expect(brotli.headers.get('cache-control')).toBe('no-cache');
  });

  it('marks precompressed hashed Vite assets immutable', () => {
    const r = res();
    setBundledUiStaticHeaders(r, '/pkg/dist/ui/assets/index-Ck4a1b2c.js.gz');
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('does not make unhashed files immutable', () => {
    const r = res();
    setBundledUiStaticHeaders(r, '/pkg/dist/ui/favicon.svg');
    expect(r.headers.has('cache-control')).toBe(false);
  });

  it('marks SPA fallback responses revalidatable', () => {
    const r = res();
    setBundledUiFallbackHeaders(r);
    expect(r.headers.get('cache-control')).toBe('no-cache');
  });
});
