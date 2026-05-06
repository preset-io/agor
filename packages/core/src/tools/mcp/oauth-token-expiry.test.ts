/**
 * Tests for the OAuth token expiry resolution cascade.
 *
 * One test per cascade step + the unknown fallthrough + a few rejection
 * cases for malformed inputs.
 */

import { describe, expect, it } from 'vitest';

import { resolveTokenExpiry } from './oauth-token-expiry';

// Fixed "now" so absolute-timestamp tests stay deterministic.
const NOW_MS = 1_750_000_000_000; // some date in 2025
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** Build a minimal JWT with the given payload (no signature verification). */
function makeJwt(payload: object): string {
  const b64 = (s: string) =>
    Buffer.from(s, 'utf8')
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return [b64('{"alg":"none"}'), b64(JSON.stringify(payload)), 'sig'].join('.');
}

/** Convert seconds-from-NOW_MS to the absolute Date the resolver should produce. */
function expectedDate(secondsFromNow: number): Date {
  return new Date(NOW_MS + secondsFromNow * 1000);
}

describe('resolveTokenExpiry', () => {
  describe('cascade order', () => {
    it('1. uses tokenResponse.expires_in when present', () => {
      const r = resolveTokenExpiry({ expires_in: 3600 }, undefined, NOW_MS);
      expect(r).toEqual({ expiresAt: expectedDate(3600), source: 'expires_in' });
    });

    it('2. falls through to expires_at when expires_in is missing', () => {
      const r = resolveTokenExpiry({ expires_at: NOW_SEC + 7200 }, undefined, NOW_MS);
      expect(r).toEqual({ expiresAt: expectedDate(7200), source: 'expires_at' });
    });

    it('3. falls through to top-level exp when expires_in/at missing', () => {
      const r = resolveTokenExpiry({ exp: NOW_SEC + 1800 }, undefined, NOW_MS);
      expect(r).toEqual({ expiresAt: expectedDate(1800), source: 'exp' });
    });

    it('4. falls through to ext_expires_in (Microsoft style)', () => {
      const r = resolveTokenExpiry({ ext_expires_in: 5400 }, undefined, NOW_MS);
      expect(r).toEqual({ expiresAt: expectedDate(5400), source: 'ext_expires_in' });
    });

    it('5. JWT-decodes the access_token when nothing else works', () => {
      const jwt = makeJwt({ exp: NOW_SEC + 900 });
      const r = resolveTokenExpiry({}, jwt, NOW_MS);
      expect(r).toEqual({ expiresAt: expectedDate(900), source: 'jwt_exp' });
    });

    it('7. returns null/unknown when no source can supply a TTL', () => {
      const r = resolveTokenExpiry({}, 'opaque-secret_abc', NOW_MS);
      expect(r).toEqual({ expiresAt: null, source: 'unknown' });
    });
  });

  describe('precedence (earlier sources win)', () => {
    it('expires_in wins over a JWT exp claim that disagrees', () => {
      const jwt = makeJwt({ exp: NOW_SEC + 9999 });
      const r = resolveTokenExpiry({ expires_in: 60 }, jwt, NOW_MS);
      expect(r.expiresAt).toEqual(expectedDate(60));
      expect(r.source).toBe('expires_in');
    });

    it('expires_at wins over ext_expires_in', () => {
      const r = resolveTokenExpiry(
        { expires_at: NOW_SEC + 100, ext_expires_in: 9999 },
        undefined,
        NOW_MS
      );
      expect(r.expiresAt).toEqual(expectedDate(100));
      expect(r.source).toBe('expires_at');
    });
  });

  describe('input rejection', () => {
    it('rejects non-positive expires_in', () => {
      expect(resolveTokenExpiry({ expires_in: 0 }, undefined, NOW_MS).source).toBe('unknown');
      expect(resolveTokenExpiry({ expires_in: -5 }, undefined, NOW_MS).source).toBe('unknown');
    });

    it('rejects NaN / Infinity expires_in', () => {
      expect(resolveTokenExpiry({ expires_in: NaN }, undefined, NOW_MS).source).toBe('unknown');
      expect(resolveTokenExpiry({ expires_in: Infinity }, undefined, NOW_MS).source).toBe(
        'unknown'
      );
    });

    it('rejects already-past expires_at', () => {
      const r = resolveTokenExpiry({ expires_at: NOW_SEC - 100 }, undefined, NOW_MS);
      expect(r.source).toBe('unknown');
    });

    it('rejects opaque (non-JWT-shape) access tokens silently', () => {
      const r = resolveTokenExpiry({}, 'xoxe.xoxp-1-abc', NOW_MS);
      expect(r.source).toBe('unknown');
    });

    it('rejects malformed JWT payloads (non-JSON, missing exp, etc.) silently', () => {
      // Three segments but middle is not valid base64-encoded JSON.
      expect(resolveTokenExpiry({}, 'aaa.!!!.ccc', NOW_MS).source).toBe('unknown');

      // Three segments, valid JSON, but no exp claim.
      const noExp = makeJwt({ sub: 'user-1' });
      expect(resolveTokenExpiry({}, noExp, NOW_MS).source).toBe('unknown');

      // Three segments, valid JSON, but exp is in the past.
      const pastExp = makeJwt({ exp: NOW_SEC - 1 });
      expect(resolveTokenExpiry({}, pastExp, NOW_MS).source).toBe('unknown');
    });

    it('rejects absolute timestamps beyond the sanity horizon (likely ms-vs-seconds bug)', () => {
      // A provider returning epoch *milliseconds* in `expires_at` (instead of
      // seconds) would resolve to year ~+58k. Reject silently and let the
      // cascade fall through rather than persist a thousand-year expiry.
      const tooFar = NOW_MS; // i.e. NOW_SEC * 1000 — used as if it were seconds
      expect(resolveTokenExpiry({ expires_at: tooFar }, undefined, NOW_MS).source).toBe('unknown');
      expect(resolveTokenExpiry({ exp: tooFar }, undefined, NOW_MS).source).toBe('unknown');
      const jwtMsExp = makeJwt({ exp: tooFar });
      expect(resolveTokenExpiry({}, jwtMsExp, NOW_MS).source).toBe('unknown');
    });
  });

  describe('the bug we are fixing', () => {
    // Documents the regression we're guarding against: the old code did
    // `tokenResponse.expires_in ?? 3600`. The new resolver must NOT
    // fabricate a 3600 default — Notion-style responses (no expires_in)
    // must produce null so callers persist `expires_at = NULL`.
    it('Notion-style response (no expires_in, no expires_at, opaque token) returns null', () => {
      const notionLike = {
        access_token: 'secret_abcdefghijklmnop',
        token_type: 'bearer',
        // no expires_in, no expires_at, no exp, no ext_expires_in
      };
      const r = resolveTokenExpiry(notionLike, notionLike.access_token, NOW_MS);
      expect(r).toEqual({ expiresAt: null, source: 'unknown' });
    });
  });
});
