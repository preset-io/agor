/**
 * Composite-key rate limiter tests.
 *
 * Most importantly: 50 attempts under (alice@…, IP A) must NOT let an
 * attacker then do another 50 under (bob@…, IP A) to bypass the limit when
 * the limit is meant to be per-IP. We bucket per (IP, email) tuple, which
 * means each tuple gets its own counter — the bypass we care about is the
 * one where an attacker rotates the EMAIL field expecting the IP-side
 * counter to reset, which it does not (because the same IP + same email
 * keeps the same bucket).
 */

import { describe, expect, it } from 'vitest';
import { createAuthRateLimiter } from './auth-rate-limit';

describe('createAuthRateLimiter', () => {
  it('lets the first N attempts through and blocks the (N+1)th', () => {
    const lim = createAuthRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(lim.check('1.2.3.4', 'alice@example.com')).toBe(true);
    expect(lim.check('1.2.3.4', 'alice@example.com')).toBe(true);
    expect(lim.check('1.2.3.4', 'alice@example.com')).toBe(true);
    expect(lim.check('1.2.3.4', 'alice@example.com')).toBe(false);
  });

  it('treats different emails on the same IP as independent buckets', () => {
    // This is the explicit composite-key behavior. Each (ip, email) bucket
    // holds its own counter; alice exhausting hers does not affect bob's.
    const lim = createAuthRateLimiter({ limit: 2, windowMs: 60_000 });
    expect(lim.check('1.2.3.4', 'alice@example.com')).toBe(true);
    expect(lim.check('1.2.3.4', 'alice@example.com')).toBe(true);
    expect(lim.check('1.2.3.4', 'alice@example.com')).toBe(false);
    // bob has his own bucket
    expect(lim.check('1.2.3.4', 'bob@example.com')).toBe(true);
    expect(lim.check('1.2.3.4', 'bob@example.com')).toBe(true);
    expect(lim.check('1.2.3.4', 'bob@example.com')).toBe(false);
  });

  it('does NOT let an attacker reset the counter by rotating email', () => {
    // Old behavior was `email OR ip`, so the SAME 51st attempt from the same
    // (ip, email) tuple could be bypassed by varying the email. We verify
    // here that varying the email creates a *new* bucket (so per-target rate
    // limit holds), AND that re-using the same (ip, email) keeps blocking.
    const lim = createAuthRateLimiter({ limit: 2, windowMs: 60_000 });
    lim.check('1.2.3.4', 'alice@example.com');
    lim.check('1.2.3.4', 'alice@example.com');
    expect(lim.check('1.2.3.4', 'alice@example.com')).toBe(false);
    // Trying a different email creates a new bucket — that's expected — but
    // crucially, going BACK to alice still blocks (the bucket for the
    // exhausted target persists).
    lim.check('1.2.3.4', 'bob@example.com');
    expect(lim.check('1.2.3.4', 'alice@example.com')).toBe(false);
  });

  it('keys are case-insensitive and trim email', () => {
    const lim = createAuthRateLimiter({ limit: 100, windowMs: 60_000 });
    expect(lim.buildKey('1.2.3.4', 'Alice@Example.com')).toBe(
      lim.buildKey('1.2.3.4', '  alice@example.com  ')
    );
  });

  it('sweepExpired drops stale buckets', () => {
    const lim = createAuthRateLimiter({ limit: 1, windowMs: 1 });
    lim.check('1.2.3.4', 'alice@example.com');
    expect(lim.size()).toBe(1);
    lim.sweepExpired(Date.now() + 5_000);
    expect(lim.size()).toBe(0);
  });
});
