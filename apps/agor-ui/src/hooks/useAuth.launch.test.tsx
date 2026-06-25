import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '../utils/tokenRefresh';
import { useAuth } from './useAuth';

const authenticate = vi.fn();
const launchCreate = vi.fn();
const refreshCreate = vi.fn();

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
