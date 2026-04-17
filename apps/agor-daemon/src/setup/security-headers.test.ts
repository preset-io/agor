/**
 * Security headers middleware tests.
 *
 * Spins up a tiny Express app, attaches the middleware, and inspects the
 * response headers via a fake req/res rather than running a real listener.
 */

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

describe('securityHeaders', () => {
  it('sets CSP, X-Frame-Options, nosniff, and Referrer-Policy on every response', () => {
    const mw = securityHeaders({ daemonUrl: 'http://localhost:3030' });
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

    expect(res._headers['x-frame-options']).toBe('DENY');
    expect(res._headers['x-content-type-options']).toBe('nosniff');
    expect(res._headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('omits HSTS over plain http', () => {
    const mw = securityHeaders();
    const res = fakeRes();
    mw({ secure: false } as Request, res, () => {});
    expect(res._has('strict-transport-security')).toBe(false);
  });

  it('emits HSTS when req.secure is true', () => {
    const mw = securityHeaders();
    const res = fakeRes();
    mw({ secure: true } as Request, res, () => {});
    expect(res._headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res._headers['strict-transport-security']).toContain('includeSubDomains');
  });
});
