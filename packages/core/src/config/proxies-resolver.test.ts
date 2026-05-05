/**
 * Proxies config resolver tests.
 *
 * Covers the validation contract on the `proxies:` block — these errors
 * fire at daemon startup, so an operator-friendly message matters more
 * than the exact wording. Assertions are on the rule that fails and (where
 * relevant) on the vendor name appearing in the message.
 */

import { describe, expect, it } from 'vitest';
import { resolveProxies } from './proxies-resolver';
import type { AgorConfig } from './types';

describe('resolveProxies', () => {
  it('returns [] when no proxies block is present (off-by-default)', () => {
    expect(resolveProxies({})).toEqual([]);
    expect(resolveProxies({ proxies: undefined })).toEqual([]);
    expect(resolveProxies({ proxies: {} })).toEqual([]);
  });

  it('resolves a minimal valid entry with default GET allowlist', () => {
    const out = resolveProxies({
      proxies: { shortcut: { upstream: 'https://api.app.shortcut.com' } },
    } satisfies AgorConfig);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      vendor: 'shortcut',
      upstream: 'https://api.app.shortcut.com',
      allowed_methods: ['GET'],
    });
  });

  it('strips trailing slash from upstream', () => {
    const [proxy] = resolveProxies({
      proxies: { shortcut: { upstream: 'https://api.app.shortcut.com/' } },
    });
    expect(proxy.upstream).toBe('https://api.app.shortcut.com');
  });

  it('uppercases allowed_methods and accepts mixed case', () => {
    const [proxy] = resolveProxies({
      proxies: {
        linear: {
          upstream: 'https://api.linear.app',
          allowed_methods: ['get', 'Post'] as never,
        },
      },
    });
    expect(proxy.allowed_methods).toEqual(['GET', 'POST']);
  });

  it('rejects http:// upstreams (https-only)', () => {
    expect(() =>
      resolveProxies({
        proxies: { shortcut: { upstream: 'http://api.app.shortcut.com' } },
      })
    ).toThrow(/must use https/);
  });

  it('rejects malformed upstream URLs with a clear message', () => {
    expect(() =>
      resolveProxies({
        proxies: { shortcut: { upstream: 'not a url' } },
      })
    ).toThrow(/proxies\.shortcut\.upstream is not a valid URL/);
  });

  it('rejects missing upstream field', () => {
    expect(() =>
      resolveProxies({
        proxies: { shortcut: {} as never },
      })
    ).toThrow(/upstream is required/);
  });

  it('rejects vendor slugs with disallowed characters', () => {
    expect(() =>
      resolveProxies({
        proxies: { 'Bad Vendor': { upstream: 'https://x.example' } },
      })
    ).toThrow(/lowercase alphanumerics or hyphens/);
    expect(() =>
      resolveProxies({
        proxies: { '../escape': { upstream: 'https://x.example' } },
      })
    ).toThrow(/lowercase alphanumerics or hyphens/);
  });

  it('rejects empty allowed_methods array', () => {
    expect(() =>
      resolveProxies({
        proxies: { shortcut: { upstream: 'https://x.example', allowed_methods: [] } },
      })
    ).toThrow(/non-empty array/);
  });

  it('rejects unsupported HTTP methods', () => {
    expect(() =>
      resolveProxies({
        proxies: {
          shortcut: { upstream: 'https://x.example', allowed_methods: ['CONNECT'] as never },
        },
      })
    ).toThrow(/CONNECT/);
  });

  it('rejects upstreams with a non-root path', () => {
    expect(() =>
      resolveProxies({
        proxies: { shortcut: { upstream: 'https://api.app.shortcut.com/api/v3' } },
      })
    ).toThrow(/bare origin without path/);
  });

  it('rejects upstreams with a query string', () => {
    expect(() =>
      resolveProxies({
        proxies: { shortcut: { upstream: 'https://api.app.shortcut.com?foo=1' } },
      })
    ).toThrow(/bare origin without path/);
  });

  it('rejects upstreams with a fragment', () => {
    expect(() =>
      resolveProxies({
        proxies: { shortcut: { upstream: 'https://api.app.shortcut.com#frag' } },
      })
    ).toThrow(/bare origin without path/);
  });
});
