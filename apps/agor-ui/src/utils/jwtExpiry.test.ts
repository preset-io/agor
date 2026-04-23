import { describe, expect, it, vi } from 'vitest';
import { decodeJwtExpMs, isExpiringSoon, msUntilExpiry } from './jwtExpiry';

/**
 * Build a fake JWT with the given payload. Only the middle segment matters
 * for our client-side decoder — the header/signature are ignored.
 */
function makeToken(payload: Record<string, unknown>): string {
  const base64url = (obj: Record<string, unknown>): string =>
    btoa(JSON.stringify(obj)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const body = base64url(payload);
  return `${header}.${body}.signature-does-not-matter`;
}

describe('decodeJwtExpMs', () => {
  it('returns exp in milliseconds for a valid token', () => {
    const expSeconds = 1_700_000_000;
    const token = makeToken({ sub: 'user-1', exp: expSeconds });
    expect(decodeJwtExpMs(token)).toBe(expSeconds * 1000);
  });

  it('returns null for a malformed token (wrong segment count)', () => {
    expect(decodeJwtExpMs('not-a-jwt')).toBeNull();
    expect(decodeJwtExpMs('only.two')).toBeNull();
  });

  it('returns null when payload has no exp', () => {
    const token = makeToken({ sub: 'user-1' });
    expect(decodeJwtExpMs(token)).toBeNull();
  });

  it('returns null when exp is not a number', () => {
    const token = makeToken({ sub: 'user-1', exp: 'nope' });
    expect(decodeJwtExpMs(token)).toBeNull();
  });

  it('returns null when payload is not valid JSON', () => {
    const header = btoa(JSON.stringify({ alg: 'HS256' }));
    const garbage = btoa('not-json{');
    expect(decodeJwtExpMs(`${header}.${garbage}.sig`)).toBeNull();
  });
});

describe('msUntilExpiry', () => {
  it('returns ms between now and exp', () => {
    const now = 1_700_000_000_000;
    const token = makeToken({ exp: (now + 60_000) / 1000 });
    expect(msUntilExpiry(token, now)).toBe(60_000);
  });

  it('returns a negative number when the token is already expired', () => {
    const now = 1_700_000_000_000;
    const token = makeToken({ exp: (now - 30_000) / 1000 });
    expect(msUntilExpiry(token, now)).toBe(-30_000);
  });

  it('returns null when the token cannot be decoded', () => {
    expect(msUntilExpiry('bogus')).toBeNull();
  });

  it('defaults now to Date.now when not provided', () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const token = makeToken({ exp: (now + 5_000) / 1000 });
      expect(msUntilExpiry(token)).toBe(5_000);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('isExpiringSoon', () => {
  const now = 1_700_000_000_000;

  it('returns true when the token expires inside the buffer', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      // expires in 30s, buffer is 60s → expiring soon
      const token = makeToken({ exp: (now + 30_000) / 1000 });
      expect(isExpiringSoon(token, 60_000)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('returns false when the token expires well beyond the buffer', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      // expires in 10 minutes, buffer is 60s → not expiring soon
      const token = makeToken({ exp: (now + 10 * 60_000) / 1000 });
      expect(isExpiringSoon(token, 60_000)).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('returns true (defensive) when the token cannot be decoded', () => {
    expect(isExpiringSoon('garbage', 60_000)).toBe(true);
  });

  it('returns true when the token has already expired', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const token = makeToken({ exp: (now - 1_000) / 1000 });
      expect(isExpiringSoon(token, 60_000)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
