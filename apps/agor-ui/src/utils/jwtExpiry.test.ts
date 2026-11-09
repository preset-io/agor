import { describe, expect, it, vi } from 'vitest';
import {
  autoRefreshDelayMs,
  autoRefreshRetryDelayMs,
  decodeJwtExpMs,
  isExpiringSoon,
  msUntilExpiry,
} from './jwtExpiry';

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

describe('autoRefreshDelayMs', () => {
  it('refreshes a minute before expiry and falls back when exp is unreadable', () => {
    expect(autoRefreshDelayMs(900_000, false)).toBe(840_000);
    expect(autoRefreshDelayMs(null, false)).toBe(300_000);
  });

  it('never schedules tighter than a second', () => {
    expect(autoRefreshDelayMs(30_000, false)).toBe(1_000);
  });

  it('waits for expiry when the last refresh did not move exp', () => {
    expect(autoRefreshDelayMs(30_000, true)).toBe(30_000);
    expect(autoRefreshDelayMs(-5_000, true)).toBe(1_000);
  });
});

describe('autoRefreshRetryDelayMs', () => {
  it('doubles from five seconds and stays capped', () => {
    expect([1, 2, 3].map(autoRefreshRetryDelayMs)).toEqual([5_000, 10_000, 20_000]);
    expect(autoRefreshRetryDelayMs(8)).toBe(5 * 60_000);
    expect(autoRefreshRetryDelayMs(5_000)).toBe(5 * 60_000);
  });
});
