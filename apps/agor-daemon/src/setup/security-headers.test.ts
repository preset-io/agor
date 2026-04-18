/**
 * Security headers middleware tests.
 *
 * Spins up a tiny Express app, attaches the middleware, and inspects the
 * response headers via a fake req/res rather than running a real listener.
 */

import { resolveSecurity } from '@agor/core/config';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from './security-headers';

function fakeRes(): Response & {
  _headers: Record<string, string>;
  _has: (name: string) => boolean;
} {
  const headers: Record<string, string> = {};
  const res = {
    _headers: headers,
    _has: (name: string) => name.toLowerCase() in headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
  } as unknown as Response & {
    _headers: Record<string, string>;
    _has: (name: string) => boolean;
  };
  return res;
}

function resolvedCsp(config: Parameters<typeof resolveSecurity>[0] = {}) {
  return resolveSecurity(config, { daemonUrl: 'http://localhost:3030' }).csp;
}

describe('securityHeaders', () => {
  it('sets CSP, X-Frame-Options, nosniff, and Referrer-Policy on every response', () => {
    const mw = securityHeaders({ csp: resolvedCsp() });
    const res = fakeRes();
    mw({ secure: false } as Request, res, () => {});

    const csp = res._headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain('http://localhost:3030');
    expect(csp).toContain('ws:');
    expect(csp).toContain('wss:');
    // Sandpack defaults in — artifacts render out of the box.
    expect(csp).toContain('https://*.codesandbox.io');
    expect(csp).toContain('blob:');

    expect(res._headers['x-frame-options']).toBe('DENY');
    expect(res._headers['x-content-type-options']).toBe('nosniff');
    expect(res._headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('omits HSTS over plain http', () => {
    const mw = securityHeaders({ csp: resolvedCsp() });
    const res = fakeRes();
    mw({ secure: false } as Request, res, () => {});
    expect(res._has('strict-transport-security')).toBe(false);
  });

  it('emits HSTS when req.secure is true', () => {
    const mw = securityHeaders({ csp: resolvedCsp() });
    const res = fakeRes();
    mw({ secure: true } as Request, res, () => {});
    expect(res._headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res._headers['strict-transport-security']).toContain('includeSubDomains');
  });

  it('emits Content-Security-Policy-Report-Only when report_only=true', () => {
    const mw = securityHeaders({
      csp: resolvedCsp({ security: { csp: { report_only: true } } }),
    });
    const res = fakeRes();
    mw({ secure: false } as Request, res, () => {});
    expect(res._has('content-security-policy-report-only')).toBe(true);
    expect(res._has('content-security-policy')).toBe(false);
  });

  it('emits neither CSP header when disabled=true', () => {
    const mw = securityHeaders({
      csp: resolvedCsp({ security: { csp: { disabled: true } } }),
    });
    const res = fakeRes();
    mw({ secure: false } as Request, res, () => {});
    expect(res._has('content-security-policy')).toBe(false);
    expect(res._has('content-security-policy-report-only')).toBe(false);
    // Other headers are still emitted — disabling CSP should NOT drop the rest.
    expect(res._headers['x-frame-options']).toBe('DENY');
  });

  it('emits Report-To header when report_uri is set', () => {
    const mw = securityHeaders({
      csp: resolvedCsp({ security: { csp: { report_uri: '/api/csp-report' } } }),
    });
    const res = fakeRes();
    mw({ secure: false } as Request, res, () => {});
    const reportTo = res._headers['report-to'];
    expect(reportTo).toBeDefined();
    expect(JSON.parse(reportTo)).toMatchObject({
      group: 'agor-csp',
      endpoints: [{ url: '/api/csp-report' }],
    });
  });

  it('Report-To group tracks a custom report-to override (no drift)', () => {
    // Pins the fix for a bug where the CSP directive advertised `custom-group`
    // but the Report-To header hardcoded `agor-csp`, causing browsers to drop
    // reports silently.
    const mw = securityHeaders({
      csp: resolvedCsp({
        security: {
          csp: {
            report_uri: '/api/csp-report',
            override: { 'report-to': ['custom-group'] },
          },
        },
      }),
    });
    const res = fakeRes();
    mw({ secure: false } as Request, res, () => {});
    expect(JSON.parse(res._headers['report-to'])).toMatchObject({ group: 'custom-group' });
    expect(res._headers['content-security-policy']).toContain('report-to custom-group');
  });

  it('extras are reflected in the emitted header', () => {
    const mw = securityHeaders({
      csp: resolvedCsp({
        security: { csp: { extras: { 'script-src': ['https://plausible.io'] } } },
      }),
    });
    const res = fakeRes();
    mw({ secure: false } as Request, res, () => {});
    expect(res._headers['content-security-policy']).toContain('https://plausible.io');
  });
});
