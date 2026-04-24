import type { AgorClient } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the underlying refresh call so tests are hermetic — we want to
// exercise the single-flight and event-dispatch behaviour of this module,
// not the HTTP call inside `refreshAndStoreTokens`.
vi.mock('./tokenRefresh', async () => {
  const actual = await vi.importActual<typeof import('./tokenRefresh')>('./tokenRefresh');
  return {
    ...actual,
    refreshAndStoreTokens: vi.fn(),
    getStoredRefreshToken: vi.fn(),
  };
});

import {
  isRefreshUnrecoverable,
  RefreshUnrecoverableError,
  refreshAndReauthenticate,
  refreshTokensSingleFlight,
  resetRefreshFailureState,
  TOKENS_REFRESH_UNRECOVERABLE_EVENT,
  TOKENS_REFRESHED_EVENT,
} from './singleFlightRefresh';
import { getStoredRefreshToken, refreshAndStoreTokens } from './tokenRefresh';

const mockRefresh = refreshAndStoreTokens as unknown as ReturnType<typeof vi.fn>;
const mockGetRefreshToken = getStoredRefreshToken as unknown as ReturnType<typeof vi.fn>;

function makeResult(accessToken = 'new-access', refreshToken = 'new-refresh') {
  return {
    accessToken,
    refreshToken,
    user: { user_id: 'u1', email: 'u1@example.com', role: 'member' },
  };
}

function makeClient(): AgorClient {
  return { authenticate: vi.fn() } as unknown as AgorClient;
}

beforeEach(() => {
  mockRefresh.mockReset();
  mockGetRefreshToken.mockReset();
  // The unrecoverable latch is a module-level singleton — reset between
  // tests so order-dependent state doesn't leak.
  resetRefreshFailureState();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('refreshTokensSingleFlight', () => {
  it('deduplicates concurrent calls to a single underlying refresh', async () => {
    let resolveRefresh!: (v: ReturnType<typeof makeResult>) => void;
    mockRefresh.mockImplementation(
      () =>
        new Promise<ReturnType<typeof makeResult>>((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const client = makeClient();
    const p1 = refreshTokensSingleFlight(client, 'rt');
    const p2 = refreshTokensSingleFlight(client, 'rt');
    const p3 = refreshTokensSingleFlight(client, 'rt');

    expect(mockRefresh).toHaveBeenCalledTimes(1);

    const result = makeResult();
    resolveRefresh(result);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(result);
    expect(r2).toBe(result);
    expect(r3).toBe(result);
  });

  it('issues a new refresh after the previous one settles', async () => {
    mockRefresh
      .mockResolvedValueOnce(makeResult('first'))
      .mockResolvedValueOnce(makeResult('second'));

    const client = makeClient();
    const first = await refreshTokensSingleFlight(client, 'rt');
    expect(first.accessToken).toBe('first');

    const second = await refreshTokensSingleFlight(client, 'rt');
    expect(second.accessToken).toBe('second');
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight slot on failure so the next caller can retry', async () => {
    mockRefresh
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeResult('recovered'));

    const client = makeClient();
    await expect(refreshTokensSingleFlight(client, 'rt')).rejects.toThrow('boom');
    const retry = await refreshTokensSingleFlight(client, 'rt');
    expect(retry.accessToken).toBe('recovered');
  });

  it('dispatches TOKENS_REFRESHED_EVENT with the result on success', async () => {
    const result = makeResult();
    mockRefresh.mockResolvedValueOnce(result);

    const listener = vi.fn();
    window.addEventListener(TOKENS_REFRESHED_EVENT, listener);
    try {
      await refreshTokensSingleFlight(makeClient(), 'rt');
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent;
      expect(event.detail).toBe(result);
    } finally {
      window.removeEventListener(TOKENS_REFRESHED_EVENT, listener);
    }
  });

  it('does not dispatch an event on failure', async () => {
    mockRefresh.mockRejectedValueOnce(new Error('nope'));
    const listener = vi.fn();
    window.addEventListener(TOKENS_REFRESHED_EVENT, listener);
    try {
      await expect(refreshTokensSingleFlight(makeClient(), 'rt')).rejects.toThrow();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(TOKENS_REFRESHED_EVENT, listener);
    }
  });

  it('throws RefreshUnrecoverableError on the first definite failure, latches, and fast-fails subsequent callers', async () => {
    // Simulate a Feathers `NotAuthenticated` from /authentication/refresh:
    // the refresh token has expired/been revoked.
    const authErr = Object.assign(new Error('jwt expired'), {
      name: 'NotAuthenticated',
      code: 401,
    });
    mockRefresh.mockRejectedValueOnce(authErr);

    const client = makeClient();
    const unrecoverableListener = vi.fn();
    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, unrecoverableListener);
    try {
      // First call must reject with RefreshUnrecoverableError (not the raw
      // auth error) so callers can use a single `instanceof` check on every
      // failure — first or fast-failed. The original error is attached as
      // `cause` for diagnostics.
      const firstErr = await refreshTokensSingleFlight(client, 'rt').catch((e) => e);
      expect(firstErr).toBeInstanceOf(RefreshUnrecoverableError);
      expect((firstErr as RefreshUnrecoverableError).cause).toBe(authErr);
      expect(isRefreshUnrecoverable()).toBe(true);
      expect(unrecoverableListener).toHaveBeenCalledTimes(1);

      // Second call MUST NOT hit the network — this is the loop-breaker.
      await expect(refreshTokensSingleFlight(client, 'rt')).rejects.toBeInstanceOf(
        RefreshUnrecoverableError
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, unrecoverableListener);
    }
  });

  it('does NOT latch on transient (non-auth) failures', async () => {
    // Network blip / 5xx — the refresh token may still be good.
    const transient = Object.assign(new Error('server exploded'), { code: 500 });
    mockRefresh.mockRejectedValueOnce(transient);

    const unrecoverableListener = vi.fn();
    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, unrecoverableListener);
    try {
      await expect(refreshTokensSingleFlight(makeClient(), 'rt')).rejects.toBe(transient);
      expect(isRefreshUnrecoverable()).toBe(false);
      expect(unrecoverableListener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, unrecoverableListener);
    }
  });

  it('clears the unrecoverable latch on the next successful refresh', async () => {
    const authErr = Object.assign(new Error('jwt expired'), {
      name: 'NotAuthenticated',
      code: 401,
    });
    mockRefresh.mockRejectedValueOnce(authErr).mockResolvedValueOnce(makeResult('fresh'));

    const client = makeClient();
    await expect(refreshTokensSingleFlight(client, 'rt')).rejects.toBeInstanceOf(
      RefreshUnrecoverableError
    );
    expect(isRefreshUnrecoverable()).toBe(true);

    // Caller explicitly resets (e.g. user logged back in) before retrying.
    resetRefreshFailureState();
    const recovered = await refreshTokensSingleFlight(client, 'rt');
    expect(recovered.accessToken).toBe('fresh');
    expect(isRefreshUnrecoverable()).toBe(false);
  });
});

describe('refreshAndReauthenticate', () => {
  it('returns null when no refresh token is stored', async () => {
    mockGetRefreshToken.mockReturnValue(null);
    const client = makeClient();
    const result = await refreshAndReauthenticate(client);
    expect(result).toBeNull();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(client.authenticate).not.toHaveBeenCalled();
  });

  it('refreshes and re-authenticates the client with the new access token', async () => {
    mockGetRefreshToken.mockReturnValue('stored-rt');
    mockRefresh.mockResolvedValueOnce(makeResult('new-access'));
    const client = makeClient();

    const result = await refreshAndReauthenticate(client);

    expect(result?.accessToken).toBe('new-access');
    expect(client.authenticate).toHaveBeenCalledWith({
      strategy: 'jwt',
      accessToken: 'new-access',
    });
  });

  it('propagates refresh errors (does not call authenticate)', async () => {
    mockGetRefreshToken.mockReturnValue('stored-rt');
    mockRefresh.mockRejectedValueOnce(new Error('refresh-failed'));
    const client = makeClient();

    await expect(refreshAndReauthenticate(client)).rejects.toThrow('refresh-failed');
    expect(client.authenticate).not.toHaveBeenCalled();
  });

  it('propagates authenticate errors', async () => {
    mockGetRefreshToken.mockReturnValue('stored-rt');
    mockRefresh.mockResolvedValueOnce(makeResult());
    const client = makeClient();
    (client.authenticate as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('auth-failed')
    );

    await expect(refreshAndReauthenticate(client)).rejects.toThrow('auth-failed');
  });
});
