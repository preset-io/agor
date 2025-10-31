import { describe, expect, it } from 'vitest';
import { normalizeOptionalHttpUrl } from './url';

describe('normalizeOptionalHttpUrl', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeOptionalHttpUrl(undefined, 'issueUrl')).toBeUndefined();
  });

  it('returns undefined for empty strings', () => {
    expect(normalizeOptionalHttpUrl('   ', 'pullRequestUrl')).toBeUndefined();
  });

  it('normalizes valid http URLs', () => {
    expect(normalizeOptionalHttpUrl('http://example.com/foo', 'field')).toBe(
      'http://example.com/foo'
    );
  });

  it('normalizes valid https URLs', () => {
    expect(normalizeOptionalHttpUrl(' https://example.com/test ', 'field')).toBe(
      'https://example.com/test'
    );
  });

  it('throws for non-string inputs', () => {
    expect(() => normalizeOptionalHttpUrl(123, 'issueUrl')).toThrowError(
      'issueUrl must be a string'
    );
  });

  it('throws for non http(s) protocol', () => {
    expect(() => normalizeOptionalHttpUrl('ftp://example.com', 'issueUrl')).toThrowError(
      'issueUrl must use http or https'
    );
  });

  it('throws for malformed URLs', () => {
    expect(() => normalizeOptionalHttpUrl('not a url', 'issueUrl')).toThrowError(
      'issueUrl must be a valid http(s) URL'
    );
  });
});
