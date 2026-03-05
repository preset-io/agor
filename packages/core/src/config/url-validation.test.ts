import { describe, expect, it } from 'vitest';
import { isAllowedHealthCheckUrl } from './url-validation';

describe('isAllowedHealthCheckUrl', () => {
  it('allows http localhost URLs', () => {
    expect(isAllowedHealthCheckUrl('http://localhost:3000/health')).toBe(true);
    expect(isAllowedHealthCheckUrl('http://127.0.0.1:8080/health')).toBe(true);
  });

  it('allows https URLs', () => {
    expect(isAllowedHealthCheckUrl('https://example.com/health')).toBe(true);
  });

  it('blocks cloud metadata endpoints (169.254.x.x)', () => {
    expect(isAllowedHealthCheckUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isAllowedHealthCheckUrl('http://169.254.0.1/')).toBe(false);
  });

  it('blocks non-HTTP protocols', () => {
    expect(isAllowedHealthCheckUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedHealthCheckUrl('gopher://evil.com/')).toBe(false);
    expect(isAllowedHealthCheckUrl('ftp://files.example.com/')).toBe(false);
  });

  it('blocks IPv6 link-local', () => {
    expect(isAllowedHealthCheckUrl('http://[fe80::1]/health')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isAllowedHealthCheckUrl('not-a-url')).toBe(false);
    expect(isAllowedHealthCheckUrl('')).toBe(false);
  });
});
