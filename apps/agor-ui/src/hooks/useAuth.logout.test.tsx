import { createRestClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshTokensSingleFlight, resetRefreshFailureState } from '../utils/singleFlightRefresh';
import {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  SupersededAuthenticationError,
} from '../utils/tokenRefresh';
import { useAuth } from './useAuth';

const authenticate = vi.fn();
const launchCreate = vi.fn();
const refreshCreate = vi.fn();
vi.mock('@agor-live/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor-live/client')>()),
  createRestClient: vi.fn(async () => ({
    authenticate,
    service: (name: string) => ({ create: name === 'auth/launch' ? launchCreate : refreshCreate }),
  })),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function session(accessToken = 'tenant-a-access', refreshToken = 'tenant-a-refresh') {
  return {
    accessToken,
    refreshToken,
    user: { user_id: 'alice', role: 'member', email: 'a@example.test' },
  };
}
describe('logout wins over pending runtime authentication', () => {
  beforeEach(() => {
    resetRefreshFailureState();
    localStorage.clear();
    window.history.replaceState({}, '', '/ui/');
    authenticate.mockReset();
    launchCreate.mockReset();
    refreshCreate.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });
  it.each(['jwt', 'launch', 'refresh'])(
    'does not reinstall a held %s session after logout',
    async (kind) => {
      const held = deferred<ReturnType<typeof session>>();
      if (kind === 'launch') {
        window.history.replaceState({}, '', '/ui/?launch_code=tenant-a-code');
        launchCreate.mockReturnValue(held.promise);
      } else {
        localStorage.setItem(ACCESS_TOKEN_KEY, 'tenant-a-access');
        localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-a-refresh');
        authenticate.mockImplementation(() =>
          kind === 'jwt'
            ? held.promise
            : Promise.reject(Object.assign(new Error('expired'), { code: 401 }))
        );
        refreshCreate.mockReturnValue(held.promise);
      }
      const { result } = renderHook(() => useAuth());
      await waitFor(() =>
        expect(
          kind === 'launch' ? launchCreate : kind === 'refresh' ? refreshCreate : authenticate
        ).toHaveBeenCalled()
      );
      await act(async () => {
        await result.current.logout();
      });
      await act(async () => {
        held.resolve(session('late-access', 'late-refresh'));
        await held.promise;
      });
      expect(result.current.authenticated).toBe(false);
      expect(result.current.user).toBeNull();
      expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
      expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    }
  );
  it.each(['success', 'auth-failure', 'transient-failure'])(
    'keeps replacement tenant B after tenant A refresh %s',
    async (outcome) => {
      localStorage.setItem(ACCESS_TOKEN_KEY, 'tenant-a-access');
      localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-a-refresh');
      authenticate.mockResolvedValueOnce(session());
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.authenticated).toBe(true));
      const held = deferred<ReturnType<typeof session>>();
      refreshCreate.mockReturnValueOnce(held.promise);
      const client = await createRestClient('http://localhost:3030');
      const refresh = refreshTokensSingleFlight(client, 'tenant-a-refresh');
      const rejected = expect(refresh).rejects.toBeInstanceOf(SupersededAuthenticationError);
      authenticate.mockResolvedValueOnce({
        ...session('tenant-b-access', 'tenant-b-refresh'),
        user: { user_id: 'bob', role: 'member', email: 'b@example.test' },
      });
      await act(async () => {
        expect(await result.current.login('b@example.test', 'secret')).toBe(true);
      });
      await act(async () => {
        if (outcome === 'success') held.resolve(session('late-a-access', 'late-a-refresh'));
        else
          held.reject(
            Object.assign(new Error('old refresh failed'), {
              code: outcome === 'auth-failure' ? 401 : 503,
            })
          );
        await rejected;
      });
      expect(result.current.user?.user_id).toBe('bob');
      expect(result.current.error).toBeNull();
      expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('tenant-b-access');
      expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('tenant-b-refresh');
    }
  );
  it('does not reuse tenant A in-flight refresh for a new tenant B credential', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'tenant-a-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-a-refresh');
    authenticate.mockResolvedValueOnce(session());
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.authenticated).toBe(true));
    const held = deferred<ReturnType<typeof session>>();
    refreshCreate.mockReturnValueOnce(held.promise);
    const client = await createRestClient('http://localhost:3030');
    const oldRefresh = refreshTokensSingleFlight(client, 'tenant-a-refresh');
    const rejected = expect(oldRefresh).rejects.toBeInstanceOf(SupersededAuthenticationError);
    authenticate.mockResolvedValueOnce({
      ...session('tenant-b-access', 'tenant-b-refresh'),
      user: { user_id: 'bob', role: 'member', email: 'b@example.test' },
    });
    await act(async () => {
      await result.current.login('b@example.test', 'secret');
    });
    const fresh = {
      ...session('fresh-b-access', 'fresh-b-refresh'),
      user: { user_id: 'bob', role: 'member', email: 'b@example.test' },
    };
    refreshCreate.mockResolvedValueOnce(fresh);
    await act(async () => {
      expect(await refreshTokensSingleFlight(client, 'tenant-b-refresh')).toEqual(fresh);
    });
    await act(async () => {
      held.resolve(session());
      await rejected;
    });
    expect(result.current.user?.user_id).toBe('bob');
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('fresh-b-access');
  });
  it.each(['success', 'auth-failure', 'transient-failure'])(
    'ignores old access-only reauth %s after another tab replaces credentials',
    async (outcome) => {
      localStorage.setItem(ACCESS_TOKEN_KEY, 'tenant-a-access');
      const held = deferred<ReturnType<typeof session>>();
      authenticate.mockReturnValueOnce(held.promise);
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(authenticate).toHaveBeenCalled());
      // Storage mutation models another same-origin tab without our module epoch.
      localStorage.setItem(ACCESS_TOKEN_KEY, 'tenant-b-access');
      localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-b-refresh');
      await act(async () => {
        if (outcome === 'success') held.resolve(session());
        else
          held.reject(
            Object.assign(new Error('stale authentication'), {
              code: outcome === 'auth-failure' ? 401 : 503,
            })
          );
        await held.promise.catch(() => {});
      });
      expect(result.current.user).toBeNull();
      expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('tenant-b-access');
      expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('tenant-b-refresh');
      expect(refreshCreate).not.toHaveBeenCalled();
    }
  );
  it('lets a pending replacement login supersede an old refresh', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'tenant-a-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-a-refresh');
    authenticate.mockResolvedValueOnce(session());
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.authenticated).toBe(true));
    const heldRefresh = deferred<ReturnType<typeof session>>();
    const heldLogin = deferred<ReturnType<typeof session>>();
    refreshCreate.mockReturnValueOnce(heldRefresh.promise);
    const client = await createRestClient('http://localhost:3030');
    const oldRefresh = refreshTokensSingleFlight(client, 'tenant-a-refresh');
    const rejected = expect(oldRefresh).rejects.toBeInstanceOf(SupersededAuthenticationError);
    authenticate.mockReturnValueOnce(heldLogin.promise);
    let login!: Promise<boolean>;
    act(() => {
      login = result.current.login('b@example.test', 'secret');
    });
    await act(async () => {
      heldRefresh.resolve(session('late-a', 'late-a-refresh'));
      await rejected;
    });
    await act(async () => {
      heldLogin.resolve({
        ...session('tenant-b-access', 'tenant-b-refresh'),
        user: { user_id: 'bob', role: 'member', email: 'b@example.test' },
      });
      expect(await login).toBe(true);
    });
    expect(result.current.user?.user_id).toBe('bob');
  });
  it('does not retry a sleeping reconnect after logout', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'tenant-a-access');
    authenticate.mockResolvedValueOnce(session());
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.authenticated).toBe(true));
    vi.useFakeTimers();
    try {
      authenticate.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      let retry!: Promise<void>;
      await act(async () => {
        retry = result.current.reAuthenticate();
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.logout();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
        await retry;
      });
      expect(authenticate).toHaveBeenCalledTimes(2);
      expect(result.current.authenticated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not start timer or visibility recovery while a replacement login is pending', async () => {
    const expiringAccess = `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 30 }))}.signature`;
    localStorage.setItem(ACCESS_TOKEN_KEY, expiringAccess);
    localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-a-refresh');
    authenticate.mockResolvedValueOnce(session(expiringAccess));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.authenticated).toBe(true);
      const held = deferred<ReturnType<typeof session>>();
      authenticate.mockReturnValueOnce(held.promise);
      let login!: Promise<boolean>;
      act(() => {
        login = result.current.login('b@example.test', 'secret');
      });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(refreshCreate).not.toHaveBeenCalled();
      expect(authenticate).toHaveBeenCalledTimes(2);
      await act(async () => {
        held.resolve({
          ...session('tenant-b-access', 'tenant-b-refresh'),
          user: { user_id: 'bob', role: 'member', email: 'b@example.test' },
        });
        expect(await login).toBe(true);
      });
      expect(result.current.user?.user_id).toBe('bob');
    } finally {
      vi.useRealTimers();
    }
  });
  it('resumes automatic refresh after a pending replacement login fails', async () => {
    const expiringAccess = `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 30 }))}.signature`;
    localStorage.setItem(ACCESS_TOKEN_KEY, expiringAccess);
    localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-a-refresh');
    authenticate.mockResolvedValueOnce(session(expiringAccess));
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const held = deferred<ReturnType<typeof session>>();
      authenticate.mockReturnValueOnce(held.promise);
      let login!: Promise<boolean>;
      act(() => {
        login = result.current.login('b@example.test', 'wrong-password');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(refreshCreate).not.toHaveBeenCalled();
      await act(async () => {
        held.reject(Object.assign(new Error('Invalid login'), { code: 401 }));
        expect(await login).toBe(false);
      });
      refreshCreate.mockResolvedValueOnce(session('refreshed-a-access', 'refreshed-a-refresh'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(refreshCreate).toHaveBeenCalledTimes(1);
      expect(result.current.user?.user_id).toBe('alice');
      expect(result.current.accessToken).toBe('refreshed-a-access');
    } finally {
      vi.useRealTimers();
    }
  });
});
