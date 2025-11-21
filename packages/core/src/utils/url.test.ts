import { describe, expect, it } from 'vitest';
import { normalizeOptionalHttpUrl } from './url';

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
