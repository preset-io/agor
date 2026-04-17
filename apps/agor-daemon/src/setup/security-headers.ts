/**
 * Security headers middleware.
 *
 * Equivalent to a minimal `helmet()` configuration tailored for the Agor
 * daemon. Sets:
 *   - Content-Security-Policy        (locks down script/connect/frame-ancestors)
 *   - X-Frame-Options: DENY          (redundant with frame-ancestors but cheap)
 *   - X-Content-Type-Options: nosniff
 *   - Referrer-Policy: strict-origin-when-cross-origin
 *   - Strict-Transport-Security      (only when the request is over TLS)
 *
 * The CSP intentionally allows `style-src 'unsafe-inline'` because Ant Design
 * still injects inline styles. TODO: migrate to nonces and tighten.
 *
 * Routes that need their own CSP (e.g. the OAuth callback HTML response) can
 * call `res.setHeader('Content-Security-Policy', ...)` to override the value
 * set here — `setHeader` replaces, so per-route CSPs continue to work.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface SecurityHeadersOptions {
  /** The daemon's own URL (e.g. `http://localhost:3030`) — added to connect-src. */
  daemonUrl?: string;
  /** Extra connect-src origins (UI dev server etc). Optional. */
  extraConnectSrc?: string[];
}

/**
 * Build the CSP header value. `connect-src` includes `'self'`, `ws:`/`wss:`
 * (for the FeathersJS socket.io transport in dev/prod), the daemon's own URL
 * if known, and any extra origins the operator wants to allow.
 */
function buildCsp(opts: SecurityHeadersOptions): string {
  const connectSrc = ["'self'", 'ws:', 'wss:'];
  if (opts.daemonUrl) connectSrc.push(opts.daemonUrl);
  if (opts.extraConnectSrc) connectSrc.push(...opts.extraConnectSrc);

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    // TODO: drop 'unsafe-inline' once Ant Design supports CSP nonces.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': connectSrc,
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
  };

  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}

/**
 * Returns an Express middleware that sets the standard security headers.
 *
 * HSTS is only emitted when the request itself is secure (`req.secure` true,
 * which respects `app.set('trust proxy', ...)`). This avoids breaking plain
 * http://localhost development.
 */
export function securityHeaders(opts: SecurityHeadersOptions = {}): RequestHandler {
  const csp = buildCsp(opts);

  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.secure) {
      // 6 months, includeSubDomains. We deliberately do NOT preload.
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  };
}
