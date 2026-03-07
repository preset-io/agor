import { describe, expect, it } from 'vitest';
import { isAllowedHealthCheckUrl, normalizeOptionalHttpUrl } from './url';

describe('normalizeOptionalHttpUrl', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeOptionalHttpUrl(undefined, 'issueUrl')).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(normalizeOptionalHttpUrl(null, 'issueUrl')).toBeUndefined();
  });

  it('returns undefined for empty or whitespace-only strings', () => {
    expect(normalizeOptionalHttpUrl('', 'pullRequestUrl')).toBeUndefined();
    expect(normalizeOptionalHttpUrl('   ', 'pullRequestUrl')).toBeUndefined();
  });

  it('normalizes valid http URLs with trimming and canonicalization', () => {
    expect(normalizeOptionalHttpUrl('  http://Example.com/path?q=1#hash  ', 'field')).toBe(
      'http://example.com/path?q=1#hash'
    );
  });

  it('normalizes valid https URLs without a path', () => {
    expect(normalizeOptionalHttpUrl('https://example.com', 'field')).toBe('https://example.com/');
  });

  it('preserves exact formatting for already normalized http URLs', () => {
    expect(normalizeOptionalHttpUrl('http://example.com/foo', 'field')).toBe(
      'http://example.com/foo'
    );
  });

  it('throws for non-string inputs', () => {
    expect(() => normalizeOptionalHttpUrl(123, 'issueUrl')).toThrow('issueUrl must be a string');
    expect(() => normalizeOptionalHttpUrl({})).toThrow('value must be a string');
  });

  it('throws for non http(s) protocol with custom field name', () => {
    expect(() => normalizeOptionalHttpUrl('ftp://example.com', 'pullRequestUrl')).toThrow(
      'pullRequestUrl must use http or https'
    );
  });

  it('throws for non http(s) protocol with default field name', () => {
    expect(() => normalizeOptionalHttpUrl('ws://example.com')).toThrow(
      'value must use http or https'
    );
  });

  it('throws for malformed URLs with custom field name', () => {
    expect(() => normalizeOptionalHttpUrl('not a url', 'issueUrl')).toThrow(
      'issueUrl must be a valid http(s) URL'
    );
  });

  it('throws for malformed URLs with default field name', () => {
    expect(() => normalizeOptionalHttpUrl('not-a-url-at-all')).toThrow(
      'value must be a valid http(s) URL'
    );
  });
});

describe('isAllowedHealthCheckUrl', () => {
  it('allows http localhost URLs', () => {
    expect(isAllowedHealthCheckUrl('http://localhost:3000/health')).toBe(true);
    expect(isAllowedHealthCheckUrl('http://127.0.0.1:8080/health')).toBe(true);
  });

  it('allows https URLs', () => {
    expect(isAllowedHealthCheckUrl('https://example.com/health')).toBe(true);
  });

  it('allows private network URLs (legitimate health check targets)', () => {
    expect(isAllowedHealthCheckUrl('http://192.168.1.100:8080/health')).toBe(true);
    expect(isAllowedHealthCheckUrl('http://10.0.0.5:3000/health')).toBe(true);
  });

  it('blocks cloud metadata endpoints (169.254.x.x)', () => {
    expect(isAllowedHealthCheckUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isAllowedHealthCheckUrl('http://169.254.0.1/')).toBe(false);
  });

  it('blocks GCP metadata hostname', () => {
    expect(isAllowedHealthCheckUrl('http://metadata.google.internal/computeMetadata/v1/')).toBe(
      false
    );
  });

  it('blocks AWS IPv6 metadata endpoint', () => {
    expect(isAllowedHealthCheckUrl('http://[fd00:ec2::254]/latest/meta-data/')).toBe(false);
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
