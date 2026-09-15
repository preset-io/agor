import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { managedOAuthLanding } from './mcp-oauth-managed-landing.js';

function fixture(url = '/mcp-oauth/complete', method = 'GET', path = '/') {
  const req = { originalUrl: url, method, path } as Request;
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    end: vi.fn(),
    redirect: vi.fn(),
  } as unknown as Response;
  const next = vi.fn();
  managedOAuthLanding(req, res, next);
  return { res, next };
}
describe('fixed managed browser landing', () => {
  it('uses fragment-preserving same-origin relative redirect, no ticket transport', () => {
    const { res, next } = fixture();
    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(303, '/ui/mcp-oauth/complete');
    expect(res.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
  it('refuses query-carried credentials without echoing them', () => {
    const { res } = fixture('/mcp-oauth/complete?ticket=fixture-not-live');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.redirect).not.toHaveBeenCalled();
  });
  it('does not absorb wrong method or nested routes', () => {
    expect(fixture('/mcp-oauth/complete', 'POST').next).toHaveBeenCalledOnce();
    expect(fixture('/mcp-oauth/complete/evil', 'GET', '/evil').next).toHaveBeenCalledOnce();
  });
});
