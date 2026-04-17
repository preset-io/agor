/**
 * Tiny in-memory rate limiter shared by the authentication and refresh routes.
 *
 * Keyed on a composite of (ip, email) so an attacker rotating the email field
 * can't reset the counter on a fixed IP, and a real user moving between IPs
 * (mobile / VPN) doesn't get locked out by someone else's failures on the
 * same IP.
 *
 * Intentionally process-local — multi-instance deployments should front the
 * daemon with a real WAF / proxy rate-limit layer.
 */

export interface AuthRateLimiter {
  /** True if the attempt was allowed; false if the bucket is exhausted. */
  check(ip: string, email?: string | null): boolean;
  /** Build the composite bucket key. Exposed for tests / observability. */
  buildKey(ip: string, email?: string | null): string;
  /** Drop expired buckets. Safe to call from a setInterval. */
  sweepExpired(now?: number): void;
  /** Total number of live buckets — for tests. */
  size(): number;
}

export interface AuthRateLimiterOptions {
  /** Maximum attempts allowed within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export function createAuthRateLimiter(opts: AuthRateLimiterOptions): AuthRateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  function buildKey(ip: string, email?: string | null): string {
    const ipPart = (ip || 'unknown').toLowerCase();
    const emailPart = (email || '').trim().toLowerCase();
    return `${ipPart}|${emailPart}`;
  }

  function check(ip: string, email?: string | null): boolean {
    const key = buildKey(ip, email);
    const now = Date.now();
    const record = buckets.get(key);
    if (!record || now > record.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return true;
    }
    if (record.count >= opts.limit) return false;
    record.count++;
    return true;
  }

  function sweepExpired(now: number = Date.now()): void {
    for (const [key, record] of buckets.entries()) {
      if (now > record.resetAt) buckets.delete(key);
    }
  }

  return { check, buildKey, sweepExpired, size: () => buckets.size };
}
