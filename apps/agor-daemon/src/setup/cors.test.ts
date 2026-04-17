/**
 * CORS hardening tests.
 *
 * Covers:
 *   - Wildcard reflection (CORS_ORIGIN=*) drops credentials.
 *   - Tightened localhost regex only matches the configured UI port range.
 *   - Sandpack origins are reachable but excluded from `isAllowedOrigin`
 *     (so they don't get credentials / private-network).
 */

import { describe, expect, it, vi } from 'vitest';
import { buildCorsConfig } from './cors';

describe('buildCorsConfig', () => {
  it('drops credentials when CORS_ORIGIN=* is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = buildCorsConfig({
      uiPort: 5173,
      isCodespaces: false,
      corsOriginOverride: '*',
    });
    expect(result.isWildcard).toBe(true);
    expect(result.credentialsAllowed).toBe(false);
    expect(result.isAllowedOrigin('https://anything.example.com')).toBe(true);
    warn.mockRestore();
  });

  it('only allows the configured UI port range on localhost', () => {
    const result = buildCorsConfig({ uiPort: 5173, isCodespaces: false });
    expect(result.isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(result.isAllowedOrigin('http://localhost:5176')).toBe(true);
    // Out-of-range port must be rejected (this was the bug in the old regex).
    expect(result.isAllowedOrigin('http://localhost:9999')).toBe(false);
    expect(result.isAllowedOrigin('http://localhost:80')).toBe(false);
  });

  it('treats Sandpack origins as accepted but not "allowed" for credentials', () => {
    const result = buildCorsConfig({
      uiPort: 5173,
      isCodespaces: false,
      allowSandpack: true,
    });
    // The actual cors origin callback would still permit the request through,
    // but the public isAllowedOrigin predicate (used to gate
    // Access-Control-Allow-Private-Network and credentials) excludes them.
    expect(result.isAllowedOrigin('https://2-19-8-sandpack.codesandbox.io')).toBe(false);
  });

  it('honours configOrigins exact strings and regex patterns', () => {
    const result = buildCorsConfig({
      uiPort: 5173,
      isCodespaces: false,
      configOrigins: ['https://dash.example.com', '/\\.internal\\.example\\.com$/'],
    });
    expect(result.isAllowedOrigin('https://dash.example.com')).toBe(true);
    expect(result.isAllowedOrigin('https://api.internal.example.com')).toBe(true);
    expect(result.isAllowedOrigin('https://other.example.com')).toBe(false);
  });
});
