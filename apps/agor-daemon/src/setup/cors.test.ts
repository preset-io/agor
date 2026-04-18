/**
 * CORS hardening tests.
 *
 * Covers:
 *   - Wildcard reflection drops credentials.
 *   - Tightened localhost regex only matches the configured UI port range.
 *   - Sandpack origins are reachable but excluded from `isAllowedOrigin`
 *     (so they don't get credentials / private-network).
 *   - Configured methods/headers/max_age are passed through to cors().
 */

import type { AgorConfig } from '@agor/core/config';
import { resolveSecurity } from '@agor/core/config';
import { describe, expect, it, vi } from 'vitest';
import { buildCorsConfig, isSandpackOrigin } from './cors';

function resolve(
  config: AgorConfig = {},
  opts: Parameters<typeof resolveSecurity>[1] = {}
): ReturnType<typeof resolveSecurity>['cors'] {
  return resolveSecurity(config, { onWarning: vi.fn(), ...opts }).cors;
}

describe('buildCorsConfig', () => {
  it('drops credentials when resolved mode is wildcard', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = buildCorsConfig({
      uiPort: 5173,
      isCodespaces: false,
      resolved: resolve({}, { corsOriginEnv: '*' }),
    });
    expect(result.isWildcard).toBe(true);
    expect(result.credentialsAllowed).toBe(false);
    // The cors() origin callback returns true (accept any origin), but the
    // isAllowedOrigin predicate is the gate for PNA / credentials. Even in
    // wildcard mode, only the localhost UI port range gets PNA — random
    // origins do NOT.
    expect(result.isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(result.isAllowedOrigin('https://anything.example.com')).toBe(false);
  });

  it('mode=wildcard emits literal "*" (not origin reflection)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = buildCorsConfig({
      uiPort: 5173,
      isCodespaces: false,
      resolved: resolve({ security: { cors: { mode: 'wildcard', credentials: false } } }),
    });
    // `origin: '*'` makes cors() emit Access-Control-Allow-Origin: *, which is
    // observably different from `origin: true` (which reflects the Origin
    // header). This test pins the distinction so wildcard doesn't regress into
    // reflect.
    expect(result.origin).toBe('*');
  });

  it('mode=reflect echoes the request origin (distinct from wildcard)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = buildCorsConfig({
      uiPort: 5173,
      isCodespaces: false,
      resolved: resolve({ security: { cors: { mode: 'reflect', credentials: false } } }),
    });
    // `origin: true` in cors() echoes the request's Origin header back — this
    // is the reflect mode behaviour per the cors package docs.
    expect(result.origin).toBe(true);
  });

  it('only allows the configured UI port range on localhost', () => {
    const result = buildCorsConfig({
      uiPort: 5173,
      isCodespaces: false,
      resolved: resolve(),
    });
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
      resolved: resolve({ security: { cors: { allow_sandpack: true } } }),
    });
    // The actual cors origin callback would still permit the request through,
    // but the public isAllowedOrigin predicate (used to gate PNA + credentials)
    // excludes them.
    expect(result.isAllowedOrigin('https://2-19-8-sandpack.codesandbox.io')).toBe(false);
  });

  it('honours security.cors.origins with exact strings and regex patterns', () => {
    const result = buildCorsConfig({
      uiPort: 5173,
      isCodespaces: false,
      resolved: resolve({
        security: {
          cors: {
            origins: ['https://dash.example.com', '/\\.internal\\.example\\.com$/'],
          },
        },
      }),
    });
    expect(result.isAllowedOrigin('https://dash.example.com')).toBe(true);
    expect(result.isAllowedOrigin('https://api.internal.example.com')).toBe(true);
    expect(result.isAllowedOrigin('https://other.example.com')).toBe(false);
  });

  it('passes methods/allowedHeaders/maxAge through to cors() extraOptions', () => {
    const result = buildCorsConfig({
      uiPort: 5173,
      isCodespaces: false,
      resolved: resolve({
        security: {
          cors: {
            methods: ['GET', 'POST'],
            allowed_headers: ['Authorization', 'X-MCP-Token'],
            max_age_seconds: 600,
          },
        },
      }),
    });
    expect(result.extraOptions.methods).toEqual(['GET', 'POST']);
    expect(result.extraOptions.allowedHeaders).toEqual(['Authorization', 'X-MCP-Token']);
    expect(result.extraOptions.maxAge).toBe(600);
  });

  it('mode=null-origin only accepts Origin: null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = buildCorsConfig({
      uiPort: 5173,
      isCodespaces: false,
      resolved: resolve({ security: { cors: { mode: 'null-origin' } } }),
    });
    const cb = vi.fn();
    (result.origin as (o: string | undefined, cb: typeof cb) => void)('null', cb);
    expect(cb).toHaveBeenLastCalledWith(null, true);
    cb.mockReset();
    (result.origin as (o: string | undefined, cb: typeof cb) => void)('https://attacker.com', cb);
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe('isSandpackOrigin', () => {
  // Exported helper so the daemon entrypoint doesn't have to reproduce the
  // regex (and risk drifting from the cors() origin-allow list).
  it('matches *.codesandbox.io subdomains', () => {
    expect(isSandpackOrigin('https://2-19-8-sandpack.codesandbox.io')).toBe(true);
    expect(isSandpackOrigin('https://anything-here.codesandbox.io')).toBe(true);
  });

  it('rejects non-Sandpack origins', () => {
    expect(isSandpackOrigin('https://attacker.com')).toBe(false);
    expect(isSandpackOrigin('http://localhost:5173')).toBe(false);
    // Defence: must be HTTPS, must be the exact codesandbox.io suffix.
    expect(isSandpackOrigin('http://x.codesandbox.io')).toBe(false);
    expect(isSandpackOrigin('https://codesandbox.io.attacker.com')).toBe(false);
  });
});
