import { describe, expect, it } from 'vitest';
import {
  MAX_TENANT_CORS_ORIGINS,
  normalizeTenantCorsOrigin,
  normalizeTenantCorsOrigins,
} from './tenant-cors';

describe('normalizeTenantCorsOrigin', () => {
  it('canonicalizes host case, IDNs, root slashes, and default ports', () => {
    expect(normalizeTenantCorsOrigin(' HTTPS://BÜCHER.example:443/ ')).toBe(
      'https://xn--bcher-kva.example'
    );
  });

  it('preserves a non-default port', () => {
    expect(normalizeTenantCorsOrigin('https://app.example.com:8443')).toBe(
      'https://app.example.com:8443'
    );
  });

  it.each([
    'https://app.example.com/path',
    'https://app.example.com/./',
    'https://app.example.com/?q=1',
    'https://app.example.com/#fragment',
    'https://user:secret@app.example.com',
    'https://@app.example.com',
    'file:///tmp/app.html',
    'null',
    '*',
    'https://*.example.com',
    '/\\.example\\.com$/',
    'https://app.example.com.',
    'https://app.exa\nmple.com',
    'https://app.example.com\\@attacker.example',
  ])('rejects non-origin or unsafe value %s', (value) => {
    expect(() => normalizeTenantCorsOrigin(value)).toThrow();
  });

  it('allows exact HTTP and HTTPS origins', () => {
    expect(normalizeTenantCorsOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeTenantCorsOrigin('https://app.example.com')).toBe('https://app.example.com');
  });
});

describe('normalizeTenantCorsOrigins', () => {
  it('deduplicates after canonicalization and sorts for stable revisions', () => {
    expect(
      normalizeTenantCorsOrigins([
        'https://z.example.com/',
        'https://a.example.com:443',
        'https://z.example.com',
      ])
    ).toEqual(['https://a.example.com', 'https://z.example.com']);
  });

  it('enforces the fixed resource limit', () => {
    expect(() =>
      normalizeTenantCorsOrigins(
        Array.from(
          { length: MAX_TENANT_CORS_ORIGINS + 1 },
          (_, index) => `https://${index}.example.com`
        )
      )
    ).toThrow(/at most/);
  });
});
