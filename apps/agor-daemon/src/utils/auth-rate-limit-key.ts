/**
 * Composite key used by the express-rate-limit middleware on `/authentication`.
 *
 * - For POST /authentication the key is `${ip}|${email}` — keeping the
 *   per-account bucket separate from the per-IP bucket so an attacker
 *   rotating the email field can't reset the counter, and a real user
 *   moving between IPs (mobile / VPN) doesn't get locked out by someone
 *   else's failures on the same shared IP.
 * - For POST /authentication/refresh there is no email field on the body,
 *   so we bucket purely by IP.
 *
 * Trust ONLY Express's resolved `req.ip` here — `app.set('trust proxy', n)`
 * controls how `req.ip` is derived from X-Forwarded-For. Reading the
 * header directly would let any client spoof their key.
 */

import type { Request } from 'express';

export function buildAuthRateLimitKey(req: Request): string {
  const ip = (req.ip || 'unknown').toLowerCase();
  // `req.path` is mount-relative — when the limiter is mounted at
  // `/authentication`, a request to `/authentication/refresh` arrives here
  // with `req.path === '/refresh'`.
  if (req.path === '/refresh') return ip;
  const body = req.body as { email?: unknown } | undefined;
  const rawEmail = typeof body?.email === 'string' ? body.email : '';
  const email = rawEmail.trim().toLowerCase();
  return `${ip}|${email}`;
}
