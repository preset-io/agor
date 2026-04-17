/**
 * Tests for the composite key used by the express-rate-limit middleware
 * on /authentication. The actual rate-limit accounting is express-rate-limit's
 * job; what we exercise here is the keying contract — getting that wrong
 * either creates false collisions (locking out unrelated users) or hands
 * an attacker a way to bypass the bucket.
 */

import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { buildAuthRateLimitKey } from './auth-rate-limit-key';

const make = (overrides: Partial<Request>): Request =>
  ({
    ip: '1.2.3.4',
    path: '/',
    body: undefined,
    ...overrides,
  }) as Request;

describe('buildAuthRateLimitKey', () => {
  it('keys POST /authentication by lowercased ip + email', () => {
    const key = buildAuthRateLimitKey(make({ path: '/', body: { email: 'Alice@Example.com' } }));
    expect(key).toBe('1.2.3.4|alice@example.com');
  });

  it('keys POST /authentication/refresh by ip only (no email in body)', () => {
    // Mounted at /authentication, so a hit to /authentication/refresh
    // arrives here as req.path === '/refresh'.
    const key = buildAuthRateLimitKey(make({ path: '/refresh', body: { refreshToken: 'tok' } }));
    expect(key).toBe('1.2.3.4');
  });

  it('treats missing / non-string email as empty (still IP-bucketed)', () => {
    expect(buildAuthRateLimitKey(make({ path: '/', body: undefined }))).toBe('1.2.3.4|');
    expect(buildAuthRateLimitKey(make({ path: '/', body: { email: 42 } }))).toBe('1.2.3.4|');
  });

  it('falls back to "unknown" when req.ip is missing', () => {
    // SECURITY: this branch must NOT silently accept '' as a valid bucket
    // — that would let any IP-less request share a single bucket with all
    // other IP-less requests, which is fine, but the key still has to be
    // non-empty so the limiter actually buckets it.
    const key = buildAuthRateLimitKey(make({ ip: undefined, path: '/', body: { email: 'a@b.c' } }));
    expect(key).toBe('unknown|a@b.c');
  });

  it('lowercases the IP component (defence against case-variant spoofing of IPv6)', () => {
    // IPv6 is hex; keep buckets case-insensitive so :ABCD::1 and :abcd::1
    // map to the same bucket.
    const key = buildAuthRateLimitKey(
      make({ ip: '::FFFF:1.2.3.4', path: '/', body: { email: 'X@Y.com' } })
    );
    expect(key).toBe('::ffff:1.2.3.4|x@y.com');
  });
});
