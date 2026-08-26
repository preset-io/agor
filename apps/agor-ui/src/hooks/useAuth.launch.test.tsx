import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimMarketplaceOAuthPrompt,
  readPendingMarketplaceOAuthPrompt,
  savePendingMarketplaceOAuthPrompt,
} from '../utils/marketplaceOAuthPrompt';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '../utils/tokenRefresh';
import { useAuth } from './useAuth';

const authenticate = vi.fn();
const launchCreate = vi.fn();
const refreshCreate = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function authorityOperation(isCurrent: () => boolean) {
  const listeners = new Set<() => void>();
  return {
    isCurrent,
    onInvalidate(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate() {
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

vi.mock('@agor-live/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor-live/client')>();
  return {
    ...actual,
    createRestClient: vi.fn(async () => ({
      authenticate,
      service: vi.fn((name: string) => {
        if (name === 'auth/launch') return { create: launchCreate };
        if (name === 'authentication/refresh') return { create: refreshCreate };
        throw new Error(`unexpected service: ${name}`);
      }),
    })),
  };
});

describe('useAuth launch-code fallback', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    authenticate.mockReset();
    launchCreate.mockReset();
    refreshCreate.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.replaceState({}, '', '/ui/?launch_code=stale-code');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/ui/');
  });

  it('notifies socket clients when launch sign-in stores fresh tokens', async () => {
    launchCreate.mockResolvedValue({
      accessToken: 'launch-access',
      refreshToken: 'launch-refresh',
      user: { user_id: 'u1', email: 'person@example.test' },
    });

    const listener = vi.fn();
    window.addEventListener(TOKENS_REFRESHED_EVENT, listener);

    try {
      const { result } = renderHook(() => useAuth());

      await waitFor(() => expect(result.current.authenticated).toBe(true));

      expect(result.current.authenticationGeneration).toBeGreaterThan(0);
      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
        accessToken: 'launch-access',
        refreshToken: 'launch-refresh',
        user: { user_id: 'u1', email: 'person@example.test' },
      });
      expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('launch-access');
      expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('launch-refresh');
    } finally {
      window.removeEventListener(TOKENS_REFRESHED_EVENT, listener);
    }
  });

  it('cleans a held Marketplace handoff on logout without a SessionPanel mounted', async () => {
    window.history.replaceState({}, '', '/ui/');
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(TOKENS_REFRESHED_EVENT, {
          detail: {
            accessToken: 'alice-access',
            refreshToken: 'alice-refresh',
            user: { user_id: 'alice', email: 'alice@example.test', role: 'member' },
          },
        })
      );
    });
    await waitFor(() => expect(result.current.user?.user_id).toBe('alice'));

    const pending = {
      sessionId: 'session-logout',
      serverId: 'server-logout',
      attemptId: 'attempt-logout',
      popupOperationId: 'popup-logout',
      prompt: 'Try it',
      createdAt: Date.now(),
      userId: 'alice',
      role: 'member',
      authGeneration: 9,
    };
    savePendingMarketplaceOAuthPrompt(pending);
    const bobPending = {
      ...pending,
      sessionId: 'session-bob',
      attemptId: 'attempt-bob',
      popupOperationId: 'popup-bob',
      userId: 'bob',
    };
    savePendingMarketplaceOAuthPrompt(bobPending);
    let rejectAttempt!: (error: Error) => void;
    const heldStatus = new Promise<never>((_, reject) => {
      rejectAttempt = reject;
    });
    const claim = claimMarketplaceOAuthPrompt({
      client: {
        service: () => ({ get: () => heldStatus }),
      } as never,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set(),
      authority: pending,
      isCurrent: () => result.current.user?.user_id === 'alice',
    });

    await act(async () => {
      await result.current.logout();
    });
    rejectAttempt(new Error('offline after logout'));
    await expect(claim).resolves.toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(bobPending.sessionId)).toEqual(bobPending);
  });

  it('cleans only the departing identity on central auth replacement', async () => {
    window.history.replaceState({}, '', '/ui/');
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      window.dispatchEvent(
        new CustomEvent(TOKENS_REFRESHED_EVENT, {
          detail: {
            accessToken: 'alice-access',
            refreshToken: 'alice-refresh',
            user: { user_id: 'alice', email: 'alice@example.test', role: 'member' },
          },
        })
      );
    });
    await waitFor(() => expect(result.current.user?.user_id).toBe('alice'));

    const alicePending = {
      sessionId: 'session-alice-transition',
      serverId: 'server-alice',
      attemptId: 'attempt-alice',
      popupOperationId: 'popup-alice',
      prompt: 'Alice prompt',
      createdAt: Date.now(),
      userId: 'alice',
      role: 'member',
      authGeneration: 3,
    };
    const bobPending = {
      ...alicePending,
      sessionId: 'session-bob-transition',
      attemptId: 'attempt-bob',
      popupOperationId: 'popup-bob',
      userId: 'bob',
    };
    savePendingMarketplaceOAuthPrompt(alicePending);
    savePendingMarketplaceOAuthPrompt(bobPending);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(TOKENS_REFRESHED_EVENT, {
          detail: {
            accessToken: 'bob-access',
            refreshToken: 'bob-refresh',
            user: { user_id: 'bob', email: 'bob@example.test', role: 'member' },
          },
        })
      );
    });
    await waitFor(() => expect(result.current.user?.user_id).toBe('bob'));

    expect(readPendingMarketplaceOAuthPrompt(alicePending.sessionId)).toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(bobPending.sessionId)).toEqual(bobPending);
  });

  it('preserves stored tokens and restores the normal session when launch sign-in fails', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'stored-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'stored-refresh');
    launchCreate.mockRejectedValue(new Error('launch code consumed'));
    authenticate.mockResolvedValue({
      accessToken: 'stored-access',
      user: { user_id: 'u1', email: 'person@example.test' },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.authenticated).toBe(true));

    expect(launchCreate).toHaveBeenCalledWith({ launchCode: 'stale-code' });
    expect(authenticate).toHaveBeenCalledWith({ strategy: 'jwt', accessToken: 'stored-access' });
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('stored-access');
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('stored-refresh');
    expect(window.location.search).toBe('');
    expect(result.current.error).toBeNull();
  });

  it('surfaces a helpful launch failure when no stored session is available', async () => {
    launchCreate.mockRejectedValue(new Error('launch code consumed'));

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.authenticated).toBe(false);
    expect(result.current.error).toContain('Launch sign-in failed');
    expect(window.location.search).toBe('');
  });

  it('replaces REST JSON parse failures during local login with a helpful message', async () => {
    authenticate.mockRejectedValue(new Error('JSON parsing error'));

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = true;
    await act(async () => {
      ok = await result.current.login('person@example.test', 'password-123');
    });

    expect(ok).toBe(false);
    expect(result.current.error).toContain('unexpected response');
    expect(result.current.error).toContain('daemon URL');
    expect(result.current.error).not.toContain('JSON parsing error');
  });

  it('notifies socket clients when local login replaces invalidated password-change tokens', async () => {
    window.history.replaceState({}, '', '/ui/');
    authenticate.mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      user: { user_id: 'u1', email: 'person@example.test' },
    });

    const listener = vi.fn();
    window.addEventListener(TOKENS_REFRESHED_EVENT, listener);

    try {
      const { result } = renderHook(() => useAuth());

      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await expect(result.current.login('person@example.test', 'password-123')).resolves.toBe(
          true
        );
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        user: { user_id: 'u1', email: 'person@example.test' },
      });
    } finally {
      window.removeEventListener(TOKENS_REFRESHED_EVENT, listener);
    }
  });

  it('advances auth generation for explicit login/logout but not same-user token refresh', async () => {
    window.history.replaceState({}, '', '/ui/');
    const user = { user_id: 'u1', email: 'person@example.test' };
    authenticate.mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      user,
    });
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const initialGeneration = result.current.authenticationGeneration;

    await act(async () => {
      await result.current.login('person@example.test', 'password-123');
    });
    const loggedInGeneration = result.current.authenticationGeneration;
    expect(loggedInGeneration).toBeGreaterThan(initialGeneration);
    expect(result.current.isAuthenticationGenerationCurrent(loggedInGeneration)).toBe(true);
    expect(result.current.isAuthenticationOwnerCurrent('u1', loggedInGeneration)).toBe(true);
    expect(result.current.isAuthenticationOwnerCurrent('u2', loggedInGeneration)).toBe(false);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(TOKENS_REFRESHED_EVENT, {
          detail: { accessToken: 'refreshed-access', refreshToken: 'new-refresh', user },
        })
      );
    });
    expect(result.current.authenticationGeneration).toBe(loggedInGeneration);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(TOKENS_REFRESHED_EVENT, {
          detail: {
            accessToken: 'replacement-access',
            refreshToken: 'replacement-refresh',
            user: { user_id: 'u2', email: 'other@example.test' },
          },
        })
      );
    });
    const replacedGeneration = result.current.authenticationGeneration;
    expect(replacedGeneration).toBeGreaterThan(loggedInGeneration);
    expect(result.current.isAuthenticationOwnerCurrent('u1', replacedGeneration)).toBe(false);
    expect(result.current.isAuthenticationOwnerCurrent('u2', replacedGeneration)).toBe(true);

    await act(async () => {
      await result.current.logout();
    });
    expect(result.current.authenticationGeneration).toBeGreaterThan(replacedGeneration);
    expect(result.current.isAuthenticationGenerationCurrent(loggedInGeneration)).toBe(false);
    expect(result.current.isAuthenticationOwnerCurrent('u1', loggedInGeneration)).toBe(false);
  });

  it('advances generation when the final login authority is committed', async () => {
    window.history.replaceState({}, '', '/ui/');
    let resolveLogin: ((result: unknown) => void) | undefined;
    authenticate.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve;
      })
    );
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let loginPromise: Promise<boolean> | undefined;
    act(() => {
      loginPromise = result.current.login('person@example.test', 'password-123');
    });
    await waitFor(() => expect(result.current.loading).toBe(true));
    const invalidatedGeneration = result.current.authenticationGeneration;

    await act(async () => {
      resolveLogin?.({
        accessToken: 'committed-access',
        refreshToken: 'committed-refresh',
        user: { user_id: 'u1', email: 'person@example.test' },
      });
      await loginPromise;
    });

    expect(result.current.authenticated).toBe(true);
    expect(result.current.authenticationGeneration).toBeGreaterThan(invalidatedGeneration);
  });

  it.each(['success', 'failure'] as const)(
    'does not let a delayed A local-login %s overwrite B tokens or auth state',
    async (outcome) => {
      window.history.replaceState({}, '', '/ui/');
      const pendingAuth = deferred<{
        accessToken: string;
        refreshToken: string;
        user: { user_id: string; email: string };
      }>();
      const refreshed = vi.fn();
      window.addEventListener(TOKENS_REFRESHED_EVENT, refreshed);

      try {
        const { result } = renderHook(() => useAuth());
        await waitFor(() => expect(result.current.loading).toBe(false));
        let authorityA = true;
        localStorage.setItem(ACCESS_TOKEN_KEY, 'admin-a-access');
        localStorage.setItem(REFRESH_TOKEN_KEY, 'admin-a-refresh');
        act(() => {
          window.dispatchEvent(
            new CustomEvent(TOKENS_REFRESHED_EVENT, {
              detail: {
                accessToken: 'admin-a-access',
                refreshToken: 'admin-a-refresh',
                user: {
                  user_id: 'admin-a',
                  email: 'admin-a@example.test',
                  role: 'admin',
                },
              },
            })
          );
        });
        const operation = authorityOperation(() => authorityA);
        const authorityCycle = result.current.captureAuthorityCycle(operation);
        expect(authorityCycle).not.toBeNull();
        authenticate.mockImplementationOnce(() => pendingAuth.promise);
        let login!: ReturnType<typeof result.current.loginForAuthorityCycle>;
        act(() => {
          login = result.current.loginForAuthorityCycle(
            'admin-a@example.test',
            'new-password',
            authorityCycle!
          );
        });

        authorityA = false;
        operation.invalidate();
        localStorage.setItem(ACCESS_TOKEN_KEY, 'admin-b-access');
        localStorage.setItem(REFRESH_TOKEN_KEY, 'admin-b-refresh');
        act(() => {
          window.dispatchEvent(
            new CustomEvent(TOKENS_REFRESHED_EVENT, {
              detail: {
                accessToken: 'admin-b-access',
                refreshToken: 'admin-b-refresh',
                user: { user_id: 'admin-b', email: 'admin-b@example.test', role: 'admin' },
              },
            })
          );
        });

        if (outcome === 'success') {
          pendingAuth.resolve({
            accessToken: 'stale-admin-a-access',
            refreshToken: 'stale-admin-a-refresh',
            user: { user_id: 'admin-a', email: 'admin-a@example.test', role: 'admin' },
          });
        } else {
          pendingAuth.reject(new Error('stale A credentials failed'));
        }
        await act(async () => {
          await expect(login).resolves.toEqual({ status: 'obsolete' });
        });

        expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('admin-b-access');
        expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('admin-b-refresh');
        expect(result.current.user?.user_id).toBe('admin-b');
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
        // Only the explicit A fixture and B replacement were announced. A's
        // stale disposable REST result never dispatches a third event.
        expect(refreshed).toHaveBeenCalledTimes(2);
      } finally {
        window.removeEventListener(TOKENS_REFRESHED_EVENT, refreshed);
      }
    }
  );

  it('deterministically releases loading when a captured reconnect cycle becomes obsolete', async () => {
    window.history.replaceState({}, '', '/ui/');
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));

    localStorage.setItem(ACCESS_TOKEN_KEY, 'admin-a-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'admin-a-refresh');
    act(() => {
      window.dispatchEvent(
        new CustomEvent(TOKENS_REFRESHED_EVENT, {
          detail: {
            accessToken: 'admin-a-access',
            refreshToken: 'admin-a-refresh',
            user: { user_id: 'admin-a', email: 'admin-a@example.test', role: 'admin' },
          },
        })
      );
    });
    let connectionReady = true;
    const operation = authorityOperation(() => connectionReady);
    const authorityCycle = result.current.captureAuthorityCycle(operation);
    expect(authorityCycle).not.toBeNull();
    const pendingAuth = deferred<{
      accessToken: string;
      refreshToken: string;
      user: { user_id: string; email: string; role: string };
    }>();
    authenticate.mockImplementationOnce(() => pendingAuth.promise);

    let login!: ReturnType<typeof result.current.loginForAuthorityCycle>;
    act(() => {
      login = result.current.loginForAuthorityCycle(
        'admin-a@example.test',
        'new-password',
        authorityCycle!
      );
    });
    await waitFor(() => expect(result.current.loading).toBe(true));
    connectionReady = false;
    act(() => {
      operation.invalidate();
    });

    await act(async () => {
      await expect(login).resolves.toEqual({ status: 'obsolete' });
    });
    // The held REST authentication has not resolved. Cancellation itself owns
    // and releases the global loading gate.
    expect(result.current.loading).toBe(false);
    expect(result.current.user?.user_id).toBe('admin-a');
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('admin-a-access');

    pendingAuth.resolve({
      accessToken: 'obsolete-access',
      refreshToken: 'obsolete-refresh',
      user: { user_id: 'admin-a', email: 'admin-a@example.test', role: 'admin' },
    });
    await act(() => pendingAuth.promise);
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('admin-a-access');
  });

  it('does not let a delayed guarded current-user refresh install an obsolete row', async () => {
    window.history.replaceState({}, '', '/ui/');
    localStorage.setItem(ACCESS_TOKEN_KEY, 'admin-a-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'admin-a-refresh');
    authenticate.mockResolvedValueOnce({
      accessToken: 'admin-a-access',
      user: { user_id: 'admin-a', email: 'admin-a@example.test' },
    });

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.user?.user_id).toBe('admin-a'));

    const pendingRefresh = deferred<{
      accessToken: string;
      user: { user_id: string; email: string };
    }>();
    authenticate.mockImplementationOnce(() => pendingRefresh.promise);
    let authorityA = true;
    let refresh!: Promise<boolean>;
    act(() => {
      refresh = result.current.refreshCurrentUserForAuthorityCycle(() => authorityA);
    });

    authorityA = false;
    localStorage.setItem(ACCESS_TOKEN_KEY, 'admin-b-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'admin-b-refresh');
    act(() => {
      window.dispatchEvent(
        new CustomEvent(TOKENS_REFRESHED_EVENT, {
          detail: {
            accessToken: 'admin-b-access',
            refreshToken: 'admin-b-refresh',
            user: { user_id: 'admin-b', email: 'admin-b@example.test' },
          },
        })
      );
    });
    pendingRefresh.resolve({
      accessToken: 'admin-a-access',
      user: { user_id: 'admin-a', email: 'stale-admin-a@example.test' },
    });

    await act(async () => {
      await expect(refresh).resolves.toBe(false);
    });
    expect(result.current.user?.user_id).toBe('admin-b');
    expect(result.current.user?.email).toBe('admin-b@example.test');
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('admin-b-access');
  });

  it('refreshes a self-updated onboarding gate without replacing the authority generation', async () => {
    window.history.replaceState({}, '', '/ui/');
    localStorage.setItem(ACCESS_TOKEN_KEY, 'member-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'member-refresh');
    authenticate.mockResolvedValueOnce({
      accessToken: 'member-access',
      user: {
        user_id: 'member-a',
        email: 'member-a@example.test',
        role: 'member',
        onboarding_completed: false,
      },
    });

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.user?.user_id).toBe('member-a'));
    const authenticationGeneration = result.current.authenticationGeneration;

    authenticate.mockResolvedValueOnce({
      accessToken: 'member-access',
      user: {
        user_id: 'member-a',
        email: 'member-a@example.test',
        role: 'member',
        onboarding_completed: true,
      },
    });

    await act(async () => {
      await expect(result.current.refreshCurrentUserForAuthorityCycle(() => true)).resolves.toBe(
        true
      );
    });

    expect(result.current.user?.onboarding_completed).toBe(true);
    expect(result.current.authenticationGeneration).toBe(authenticationGeneration);
    expect(authenticate).toHaveBeenLastCalledWith({
      strategy: 'jwt',
      accessToken: 'member-access',
    });
  });

  it('preserves stored tokens when stored-session auth gets a non-auth transport response', async () => {
    window.history.replaceState({}, '', '/ui/');
    localStorage.setItem(ACCESS_TOKEN_KEY, 'stored-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'stored-refresh');
    authenticate.mockRejectedValue(new Error('JSON parsing error'));
    refreshCreate.mockRejectedValue(new Error('JSON parsing error'));

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.authenticated).toBe(false);
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('stored-access');
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('stored-refresh');
  });

  it('preserves stored tokens when launch fallback auth gets a non-auth transport response', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'stored-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'stored-refresh');
    launchCreate.mockRejectedValue(new Error('launch code consumed'));
    authenticate.mockRejectedValue(new Error('JSON parsing error'));
    refreshCreate.mockRejectedValue(new Error('JSON parsing error'));

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.authenticated).toBe(false);
    expect(result.current.error).toContain('Launch sign-in failed');
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('stored-access');
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('stored-refresh');
  });
});
