import { describe, expect, it } from 'vitest';
import type { ArtifactID, BoardID, BranchID, SessionID } from '../types/id';
import {
  getArtifactFullscreenUrl,
  getArtifactUrl,
  getBoardUrl,
  getBranchUrl,
  getSessionUrl,
  isAllowedHealthCheckUrl,
  normalizeOptionalHttpUrl,
} from './url';

// Minimal UUIDv7-shaped IDs for URL builder tests.
const SESSION_ID = '01927f9d-0000-7000-8000-000000000001' as SessionID;
const BRANCH_ID = '01927f9d-0000-7000-8000-000000000002' as BranchID;
const BOARD_ID = '01927f9d-0000-7000-8000-000000000003' as BoardID;
const ARTIFACT_ID = '01927f9d-0000-7000-8000-000000000004' as ArtifactID;

describe('entity URL builders — fullUrl double-prefix regression', () => {
  it('produces correct session URL when baseUrl has no /ui suffix', () => {
    const url = getSessionUrl(SESSION_ID, 'https://agor.example.com');
    expect(url).toMatch(/^https:\/\/agor\.example\.com\/ui\/s\//);
    expect(url).not.toContain('/ui/ui/');
  });

  it('strips /ui suffix from baseUrl to prevent double /ui/ui/ prefix in session URLs', () => {
    const url = getSessionUrl(SESSION_ID, 'https://agor.example.com/ui');
    expect(url).toMatch(/^https:\/\/agor\.example\.com\/ui\/s\//);
    expect(url).not.toContain('/ui/ui/');
  });

  it('strips trailing slash then /ui suffix (e.g. https://host/ui/)', () => {
    const url = getSessionUrl(SESSION_ID, 'https://agor.example.com/ui/');
    expect(url).toMatch(/^https:\/\/agor\.example\.com\/ui\/s\//);
    expect(url).not.toContain('/ui/ui/');
  });

  it('produces correct branch URL when baseUrl has /ui suffix', () => {
    const url = getBranchUrl(BRANCH_ID, 'https://agor.example.com/ui');
    expect(url).toMatch(/^https:\/\/agor\.example\.com\/ui\/w\//);
    expect(url).not.toContain('/ui/ui/');
  });

  it('produces correct board URL when baseUrl has /ui suffix', () => {
    const url = getBoardUrl(BOARD_ID, 'my-board', 'https://agor.example.com/ui');
    expect(url).toBe('https://agor.example.com/ui/b/my-board/');
  });

  it('produces correct artifact URL when baseUrl has /ui suffix', () => {
    const url = getArtifactUrl(ARTIFACT_ID, 'https://agor.example.com/ui');
    expect(url).toMatch(/^https:\/\/agor\.example\.com\/ui\/a\//);
    expect(url).not.toContain('/ui/ui/');
  });

  it('produces correct artifact fullscreen URL when baseUrl has /ui suffix', () => {
    const url = getArtifactFullscreenUrl(ARTIFACT_ID, 'https://agor.example.com/ui');
    expect(url).toMatch(/^https:\/\/agor\.example\.com\/ui\/a\//);
    expect(url).toMatch(/\/fullscreen$/);
    expect(url).not.toContain('/ui/ui/');
  });

  it('does not strip /ui from a path-prefixed base (e.g. https://host/myapp)', () => {
    const url = getSessionUrl(SESSION_ID, 'https://agor.example.com/myapp');
    expect(url).toMatch(/^https:\/\/agor\.example\.com\/myapp\/ui\/s\//);
  });
});

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
