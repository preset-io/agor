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
 * The CSP is resolved from `~/.agor/config.yaml` (`security.csp.*`) via
 * `resolveSecurity()` in @agor/core, so operators can append per-directive
 * sources (`extras`) or replace them wholesale (`override`) without touching
 * code. Built-in defaults are chosen so every bundled Agor feature works out
 * of the box — notably Sandpack-backed artifacts, which need `frame-src` and
 * `worker-src` to be non-restrictive.
 *
 * The CSP intentionally allows `style-src 'unsafe-inline'` because Ant Design
 * still injects inline styles. TODO: migrate to nonces and tighten.
 *
 * Routes that need their own CSP (e.g. the OAuth callback HTML response) can
 * call `res.setHeader('Content-Security-Policy', ...)` to override the value
 * set here — `setHeader` replaces, so per-route CSPs continue to work.
 */

import type { ResolvedCsp } from '@agor/core/config';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface SecurityHeadersOptions {
  /**
   * Resolved CSP (from `resolveSecurity()`). When omitted, CSP is emitted as
   * an empty `default-src 'self'` — safe but likely to block legitimate
   * resources. The daemon entrypoint always passes a resolved value; this
   * default exists for unit tests that need a no-config middleware.
   */
  csp?: ResolvedCsp;
}

const MINIMAL_FALLBACK_CSP: ResolvedCsp = {
  directives: { 'default-src': ["'self'"] },
  disabled: false,
  reportOnly: false,
  headerValue: "default-src 'self'",
};

/**
 * Returns an Express middleware that sets the standard security headers.
 *
 * HSTS is only emitted when the request itself is secure (`req.secure` true,
 * which respects `app.set('trust proxy', ...)`). This avoids breaking plain
 * http://localhost development.
 */
export function securityHeaders(opts: SecurityHeadersOptions = {}): RequestHandler {
  const csp = opts.csp ?? MINIMAL_FALLBACK_CSP;
  const cspHeaderName = csp.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';

  // When `report_uri` is set, emit a matching `Report-To` header so that
  // modern browsers prefer the Reporting API over the legacy `report-uri`
  // directive. The group name is taken from the resolver (which derives it
  // from the `report-to` directive — either our default `agor-csp` or the
  // operator's override) so the header and directive can't drift.
  const reportToHeader =
    csp.reportUri !== undefined && csp.reportToGroup !== undefined
      ? JSON.stringify({
          group: csp.reportToGroup,
          max_age: 10886400, // 126 days — Chrome caps at ~1yr; this matches Mozilla's recommendation
          endpoints: [{ url: csp.reportUri }],
        })
      : undefined;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!csp.disabled) {
      res.setHeader(cspHeaderName, csp.headerValue);
      if (reportToHeader) {
        res.setHeader('Report-To', reportToHeader);
      }
    }
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
