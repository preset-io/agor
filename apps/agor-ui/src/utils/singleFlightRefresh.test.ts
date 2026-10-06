import type { AuthenticatedAgorClient } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isRefreshUnrecoverable,
  markAuthenticationUnrecoverable,
  RefreshUnrecoverableError,
  refreshTokensSingleFlight,
  resetRefreshFailureState,
  TOKENS_REFRESH_UNRECOVERABLE_EVENT,
  TOKENS_REFRESHED_EVENT,
} from './singleFlightRefresh';
import {
  invalidateTokenAuthority,
  REFRESH_TOKEN_KEY,
  RefreshSupersededError,
  SupersededAuthenticationError,
  storeTokens,
} from './tokenRefresh';

const mockRefresh = vi.fn();

function makeResult(accessToken = 'new-access', refreshToken = 'new-refresh') {
  return {
    accessToken,
    refreshToken,
    user: { user_id: 'u1', email: 'u1@example.com', role: 'member' },
  };
}

function makeClient(): AuthenticatedAgorClient {
  return { service: () => ({ create: mockRefresh }) } as unknown as AuthenticatedAgorClient;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(REFRESH_TOKEN_KEY, 'rt');
  mockRefresh.mockReset();
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

    const second = await refreshTokensSingleFlight(client, 'new-refresh');
    expect(second.accessToken).toBe('second');
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('does not share an in-flight refresh with a different refresh token', async () => {
    let finishOld!: (value: ReturnType<typeof makeResult>) => void;
    let finishNew!: (value: ReturnType<typeof makeResult>) => void;
    mockRefresh.mockReturnValueOnce(new Promise((resolve) => (finishOld = resolve)));
    mockRefresh.mockReturnValueOnce(new Promise((resolve) => (finishNew = resolve)));
    const client = makeClient();
    const oldRefresh = refreshTokensSingleFlight(client, 'rt');
    invalidateTokenAuthority();
    storeTokens('b-access-0', 'b-rt');
    const newRefresh = refreshTokensSingleFlight(client, 'b-rt');
    finishOld(makeResult('late-a', 'late-a-refresh'));
    await expect(oldRefresh).rejects.toBeInstanceOf(SupersededAuthenticationError);
    // The old refresh settling must not free the new account's in-flight slot.
    expect(refreshTokensSingleFlight(client, 'b-rt')).toBe(newRefresh);
    finishNew(makeResult('b-access', 'b-refresh'));
    await expect(newRefresh).resolves.toMatchObject({ accessToken: 'b-access' });
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('b-refresh');
  });

  it('rejects without a request once the session was logged out', async () => {
    localStorage.clear();
    await expect(refreshTokensSingleFlight(makeClient(), 'rt')).rejects.toBeInstanceOf(
      SupersededAuthenticationError
    );
    expect(mockRefresh).not.toHaveBeenCalled();
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

  it('broadcasts once when a refreshed credential still cannot authenticate', () => {
    const listener = vi.fn();
    const cause = Object.assign(new Error('tenant claim rejected'), { code: 401 });
    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, listener);
    try {
      const first = markAuthenticationUnrecoverable(cause);
      const second = markAuthenticationUnrecoverable(cause);

      expect(first).toBeInstanceOf(RefreshUnrecoverableError);
      expect(first.cause).toBe(cause);
      expect(second).toBeInstanceOf(RefreshUnrecoverableError);
      expect(isRefreshUnrecoverable()).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, listener);
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
  it('retains each token flight while discarding an older cross-tab result', async () => {
    const resolvers: Array<(v: ReturnType<typeof makeResult>) => void> = [];
    mockRefresh.mockImplementation(
      () => new Promise<ReturnType<typeof makeResult>>((resolve) => resolvers.push(resolve))
    );
    const client = makeClient();
    const older = refreshTokensSingleFlight(client, 'rt');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'rt-newer');
    const newer = refreshTokensSingleFlight(client, 'rt-newer');
    expect(refreshTokensSingleFlight(client, 'rt')).toBe(older);
    expect(newer).not.toBe(older);
    expect(mockRefresh).toHaveBeenNthCalledWith(1, { refreshToken: 'rt' });
    expect(mockRefresh).toHaveBeenNthCalledWith(2, { refreshToken: 'rt-newer' });
    resolvers[0](makeResult('older'));
    await expect(older).rejects.toBeInstanceOf(RefreshSupersededError);
    expect(refreshTokensSingleFlight(client, 'rt-newer')).toBe(newer);
    resolvers[1](makeResult('newer'));
    await expect(newer).resolves.toMatchObject({ accessToken: 'newer' });
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('a superseded refresh rejection neither latches nor broadcasts nor signs the user out', async () => {
    const authErr = Object.assign(new Error('jwt expired'), {
      name: 'NotAuthenticated',
      code: 401,
    });
    let rejectOlder!: (e: unknown) => void;
    mockRefresh.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOlder = reject;
        })
    );

    const listener = vi.fn();
    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, listener);
    try {
      const older = refreshTokensSingleFlight(makeClient(), 'rt');
      // The user signs in again (or another tab rotates) while the POST is out.
      localStorage.setItem(REFRESH_TOKEN_KEY, 'rt-after-sign-in');
      rejectOlder(authErr);

      await expect(older).rejects.toBeInstanceOf(RefreshSupersededError);
      expect(isRefreshUnrecoverable()).toBe(false);
      expect(listener).not.toHaveBeenCalled();

      // The newer credentials are not fast-failed by the old rejection.
      mockRefresh.mockResolvedValueOnce(makeResult('newer'));
      await expect(refreshTokensSingleFlight(makeClient(), 'rt-after-sign-in')).resolves.toEqual(
        expect.objectContaining({ accessToken: 'newer' })
      );
    } finally {
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, listener);
    }
  });

  it('a rejection after logout cleared the stored token is superseded, not an unrecoverable broadcast', async () => {
    const authErr = Object.assign(new Error('jwt expired'), {
      name: 'NotAuthenticated',
      code: 401,
    });
    mockRefresh.mockImplementationOnce(async () => {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
      throw authErr;
    });
    const listener = vi.fn();
    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, listener);
    try {
      await expect(refreshTokensSingleFlight(makeClient(), 'rt')).rejects.toBeInstanceOf(
        RefreshSupersededError
      );
      expect(isRefreshUnrecoverable()).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, listener);
    }
  });
});
