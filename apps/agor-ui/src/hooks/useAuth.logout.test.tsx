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
function tenantB() {
  return {
    ...session('tenant-b-access', 'tenant-b-refresh'),
    user: { user_id: 'bob', role: 'member', email: 'b@example.test' },
  };
}
async function logOutAndSignInAsB(result: { current: ReturnType<typeof useAuth> }) {
  await act(async () => {
    await result.current.logout();
  });
  authenticate.mockResolvedValueOnce(tenantB());
  await act(async () => {
    expect(await result.current.login('b@example.test', 'secret')).toBe(true);
  });
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
  it('keeps replacement tenant B when tenant A timer refresh fails late', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      localStorage.setItem(ACCESS_TOKEN_KEY, 'tenant-a-access');
      localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-a-refresh');
      authenticate.mockResolvedValueOnce(session());
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.authenticated).toBe(true));
      const held = deferred<ReturnType<typeof session>>();
      refreshCreate.mockReturnValueOnce(held.promise);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
      });
      await waitFor(() => expect(refreshCreate).toHaveBeenCalled());
      authenticate.mockResolvedValueOnce(tenantB());
      await act(async () => {
        expect(await result.current.login('b@example.test', 'secret')).toBe(true);
      });
      await act(async () => {
        held.reject(Object.assign(new Error('old refresh failed'), { code: 401 }));
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(result.current.user?.user_id).toBe('bob');
      expect(result.current.error).toBeNull();
      expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('tenant-b-access');
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not refresh tenant A over tenant B after a late JWT rejection', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'tenant-a-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-a-refresh');
    const held = deferred<ReturnType<typeof session>>();
    authenticate.mockReturnValueOnce(held.promise);
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(authenticate).toHaveBeenCalled());
    authenticate.mockResolvedValueOnce(tenantB());
    await act(async () => {
      expect(await result.current.login('b@example.test', 'secret')).toBe(true);
    });
    refreshCreate.mockResolvedValue(session('late-access', 'late-refresh'));
    await act(async () => {
      held.reject(Object.assign(new Error('expired'), { code: 401 }));
      await held.promise.catch(() => {});
    });
    expect(refreshCreate).not.toHaveBeenCalled();
    expect(result.current.user?.user_id).toBe('bob');
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('tenant-b-access');
  });
  it('does not let a superseded wake refresh cancel a replacement login', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const expiringAccess = `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 30 }))}.signature`;
    localStorage.setItem(ACCESS_TOKEN_KEY, expiringAccess);
    localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-a-refresh');
    authenticate.mockResolvedValueOnce(session(expiringAccess));
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.authenticated).toBe(true));
    const heldRefresh = deferred<ReturnType<typeof session>>();
    refreshCreate.mockReturnValueOnce(heldRefresh.promise);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(refreshCreate).toHaveBeenCalled());
    await act(async () => {
      await result.current.logout();
    });
    const heldLogin = deferred<ReturnType<typeof session>>();
    authenticate.mockReturnValueOnce(heldLogin.promise);
    let login!: Promise<boolean>;
    act(() => {
      login = result.current.login('b@example.test', 'secret');
    });
    await act(async () => {
      heldRefresh.resolve(session('late-a', 'late-a-refresh'));
      await heldRefresh.promise;
    });
    await act(async () => {
      heldLogin.resolve(tenantB());
      expect(await login).toBe(true);
    });
    expect(result.current.user?.user_id).toBe('bob');
  });
  it('does not let a late launch rejection clear a replacement login', async () => {
    window.history.replaceState({}, '', '/ui/?launch_code=tenant-a-code');
    const held = deferred<ReturnType<typeof session>>();
    launchCreate.mockReturnValue(held.promise);
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(launchCreate).toHaveBeenCalled());
    await logOutAndSignInAsB(result);
    await act(async () => {
      held.reject(Object.assign(new Error('bad code'), { code: 401 }));
      await held.promise.catch(() => {});
    });
    expect(result.current.user?.user_id).toBe('bob');
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('tenant-b-access');
  });
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
      heldLogin.resolve(tenantB());
      expect(await login).toBe(true);
    });
    expect(result.current.user?.user_id).toBe('bob');
  });
  it('does not retry a sleeping launch exchange after logout', async () => {
    window.history.replaceState({}, '', '/ui/?launch_code=tenant-a-code');
    launchCreate.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    launchCreate.mockResolvedValue(session('late-access', 'late-refresh'));
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(launchCreate).toHaveBeenCalledTimes(1);
      await act(async () => {
        await result.current.logout();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(launchCreate).toHaveBeenCalledTimes(1);
      expect(result.current.authenticated).toBe(false);
      expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not let a sleeping daemon retry cancel a replacement login', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'tenant-a-access');
    authenticate.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(authenticate).toHaveBeenCalledTimes(1);
      await act(async () => {
        await result.current.logout();
      });
      const heldLogin = deferred<ReturnType<typeof session>>();
      authenticate.mockReturnValueOnce(heldLogin.promise);
      let login!: Promise<boolean>;
      act(() => {
        login = result.current.login('b@example.test', 'secret');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        heldLogin.resolve(tenantB());
        expect(await login).toBe(true);
      });
      expect(result.current.user?.user_id).toBe('bob');
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not refresh a stale launch fallback over a replacement login', async () => {
    window.history.replaceState({}, '', '/ui/?launch_code=tenant-a-code');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-a-refresh');
    const held = deferred<ReturnType<typeof session>>();
    launchCreate.mockReturnValue(held.promise);
    refreshCreate.mockResolvedValue(session('late-a-access', 'late-a-refresh'));
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(launchCreate).toHaveBeenCalled());
    await logOutAndSignInAsB(result);
    await act(async () => {
      held.reject(Object.assign(new Error('bad code'), { code: 401 }));
      await held.promise.catch(() => {});
    });
    expect(refreshCreate).not.toHaveBeenCalled();
    expect(result.current.user?.user_id).toBe('bob');
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('tenant-b-access');
  });
  it('lets a launch sign-in supersede an older in-flight refresh', async () => {
    window.history.replaceState({}, '', '/ui/?launch_code=tenant-b-code');
    localStorage.setItem(ACCESS_TOKEN_KEY, 'tenant-a-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-a-refresh');
    const heldLaunch = deferred<ReturnType<typeof session>>();
    launchCreate.mockReturnValue(heldLaunch.promise);
    const heldRefresh = deferred<ReturnType<typeof session>>();
    refreshCreate.mockReturnValueOnce(heldRefresh.promise);
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(launchCreate).toHaveBeenCalled());
    const client = await createRestClient('http://localhost:3030');
    const oldRefresh = refreshTokensSingleFlight(client, 'tenant-a-refresh').catch((e) => e);
    await act(async () => {
      heldLaunch.resolve(tenantB());
      await heldLaunch.promise;
    });
    await act(async () => {
      heldRefresh.resolve(session('late-a', 'late-a-refresh'));
      expect(await oldRefresh).toBeInstanceOf(SupersededAuthenticationError);
    });
    expect(result.current.user?.user_id).toBe('bob');
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('tenant-b-access');
  });
  it('keeps a replacement login signed in when a stale fallback refresh is superseded', async () => {
    window.history.replaceState({}, '', '/ui/?launch_code=tenant-a-code');
    localStorage.setItem(ACCESS_TOKEN_KEY, 'tenant-a-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'tenant-a-refresh');
    launchCreate.mockRejectedValue(Object.assign(new Error('bad code'), { code: 401 }));
    authenticate.mockRejectedValueOnce(Object.assign(new Error('bad request'), { code: 400 }));
    authenticate.mockRejectedValueOnce(Object.assign(new Error('expired'), { code: 401 }));
    const heldRefresh = deferred<ReturnType<typeof session>>();
    refreshCreate.mockReturnValueOnce(heldRefresh.promise);
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(refreshCreate).toHaveBeenCalled());
    await logOutAndSignInAsB(result);
    await act(async () => {
      heldRefresh.resolve(session('late-a', 'late-a-refresh'));
      await heldRefresh.promise;
    });
    expect(result.current.authenticated).toBe(true);
    expect(result.current.user?.user_id).toBe('bob');
  });
});
