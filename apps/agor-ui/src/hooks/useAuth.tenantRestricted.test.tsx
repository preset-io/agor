/**
 * Authentication-layer half of the suspended workspace.
 *
 * `useAgorClient` covers the socket. This covers what happens before a socket
 * exists: the daemon checks the credential generation on every JWT path, so a
 * member reopening a suspended workspace is rejected during re-authentication
 * and never reaches the handshake at all.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '../utils/tokenRefresh';
import { useAuth } from './useAuth';

const authenticate = vi.fn();
const refreshCreate = vi.fn();

vi.mock('@agor-live/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor-live/client')>();
  return {
    ...actual,
    createRestClient: vi.fn(async () => ({
      authenticate,
      service: vi.fn((name: string) => {
        if (name === 'authentication/refresh') return { create: refreshCreate };
        throw new Error(`unexpected service: ${name}`);
      }),
    })),
  };
});

const restricted = () =>
  Object.assign(new Error('Tenant credential cannot be verified'), {
    code: 401,
    className: 'not-authenticated',
    data: { code: 'tenant_restricted' },
  });

const staleCredential = () =>
  Object.assign(new Error('Tenant credential cannot be verified'), {
    code: 401,
    className: 'not-authenticated',
  });

const user = { user_id: 'u1', email: 'member@example.test', role: 'member' };

describe('useAuth on a suspended workspace', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    authenticate.mockReset();
    refreshCreate.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.replaceState({}, '', '/ui/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('reports the closed workspace and keeps the stored credential', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'member-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'member-refresh');
    authenticate.mockRejectedValue(restricted());

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.tenantRestricted).toBe(true));
    expect(result.current.authenticated).toBe(false);
    // Clearing these would send the member to a sign-in form for a decision
    // their password cannot change, and would lose the session the probe
    // restores when an administrator reopens the workspace.
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('member-access');
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('member-refresh');
    // The suspended screen is the message; no banner may contradict it.
    expect(result.current.error).toBeNull();
    // The refresh token is never spent on a rejection that is not about it.
    expect(refreshCreate).not.toHaveBeenCalled();
  });

  it('still clears tokens when the rejection is an ordinary expired session', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'member-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'member-refresh');
    authenticate.mockRejectedValue(staleCredential());
    refreshCreate.mockRejectedValue(staleCredential());

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tenantRestricted).toBe(false);
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
  });

  it('probes on the slow suspended cadence, not the daemon-restart poll', async () => {
    vi.useFakeTimers();
    localStorage.setItem(ACCESS_TOKEN_KEY, 'member-access');
    authenticate.mockRejectedValue(restricted());

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.tenantRestricted).toBe(true);
    const attempts = authenticate.mock.calls.length;

    // The 3s daemon-restart poll would have run ten times by now.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(authenticate).toHaveBeenCalledTimes(attempts);

    // Release recorded: the next probe is accepted and clears the state
    // without the member touching anything.
    authenticate.mockResolvedValue({ user, accessToken: 'member-access' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(authenticate).toHaveBeenCalledTimes(attempts + 1);
    expect(result.current.authenticated).toBe(true);
    expect(result.current.tenantRestricted).toBe(false);
  });

  it('fails the parked tab over to sign-in once release moves the generation', async () => {
    vi.useFakeTimers();
    localStorage.setItem(ACCESS_TOKEN_KEY, 'member-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'member-refresh');
    authenticate.mockRejectedValue(restricted());
    refreshCreate.mockRejectedValue(restricted());

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.tenantRestricted).toBe(true);

    // Release moves the credential generation, so this tab's probe now gets a
    // plain credential rejection. That is still the daemon answering, and it
    // no longer says the workspace is closed: the member must land on sign-in
    // rather than staying parked on a screen for a workspace that is open.
    authenticate.mockRejectedValue(staleCredential());
    refreshCreate.mockRejectedValue(staleCredential());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(result.current.tenantRestricted).toBe(false);
    expect(result.current.authenticated).toBe(false);
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();

    // And the fresh sign-in that follows succeeds.
    authenticate.mockResolvedValue({ user, accessToken: 'fresh-access' });
    await act(async () => {
      await expect(result.current.login('member@example.test', 'correct-horse')).resolves.toBe(
        true
      );
    });
    expect(result.current.authenticated).toBe(true);
    expect(result.current.tenantRestricted).toBe(false);
  });

  it('keeps the suspended state when a probe fails for an unrelated reason', async () => {
    vi.useFakeTimers();
    localStorage.setItem(ACCESS_TOKEN_KEY, 'member-access');
    authenticate.mockRejectedValue(restricted());

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.tenantRestricted).toBe(true);

    // An unreachable daemon is not an answer; only the daemon may overturn the
    // last one it gave.
    authenticate.mockRejectedValue(new TypeError('Failed to fetch'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.tenantRestricted).toBe(true);
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('member-access');
  });

  it('reports a closed workspace from a fresh sign-in attempt', async () => {
    // Nothing is stored, so this member lands on the sign-in form first. The
    // daemon refuses to issue tokens for a closed workspace, and the answer
    // must be the suspended state rather than a login error they can retry.
    authenticate.mockRejectedValue(restricted());
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tenantRestricted).toBe(false);

    await act(async () => {
      await expect(result.current.login('member@example.test', 'correct-horse')).resolves.toBe(
        false
      );
    });

    expect(result.current.tenantRestricted).toBe(true);
    expect(result.current.authenticated).toBe(false);
  });
});
