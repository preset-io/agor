/**
 * Integrated useAuth + useAgorClient regressions for cross-tab credential
 * changes. The two hooks are wired exactly as App.tsx wires them; only the
 * transport factories are stubbed, so the real single-flight refresh,
 * reconciliation and socket-binding lifecycles run together.
 */
import { createClient } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRefreshFailureState } from '../utils/singleFlightRefresh';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '../utils/tokenRefresh';
import { useAgorClient } from './useAgorClient';
import { useAuth } from './useAuth';

const authenticate = vi.fn();
const refreshCreate = vi.fn();

vi.mock('@agor-live/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor-live/client')>()),
  createClient: vi.fn(),
  createRestClient: vi.fn(async () => ({
    authenticate,
    service: vi.fn((name: string) => {
      if (name === 'authentication/refresh') return { create: refreshCreate };
      throw new Error(`unexpected service: ${name}`);
    }),
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

function jwt(expSeconds: number, sub: string): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub, exp: expSeconds })}.sig`;
}

/** Minimal Socket.IO seam: connect succeeds (or fails) on a microtask. */
function makeSeam() {
  const handlers = new Map<string, Array<{ fn: (...args: unknown[]) => void; once: boolean }>>();
  const nextConnectErrors: Error[] = [];
  const fire = (event: string, ...args: unknown[]) => {
    const current = [...(handlers.get(event) ?? [])];
    handlers.set(
      event,
      current.filter((entry) => !entry.once)
    );
    for (const entry of current) entry.fn(...args);
  };
  const add = (event: string, fn: (...args: unknown[]) => void, once: boolean) => {
    handlers.set(event, [...(handlers.get(event) ?? []), { fn, once }]);
  };
  const io = {
    connected: false,
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => add(event, fn, false)),
    once: vi.fn((event: string, fn: (...args: unknown[]) => void) => add(event, fn, true)),
    off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((entry) => entry.fn !== fn)
      );
    }),
    connect: vi.fn(() => {
      if (io.connected) return;
      queueMicrotask(() => {
        const error = nextConnectErrors.shift();
        if (error) {
          fire('connect_error', error);
          return;
        }
        io.connected = true;
        fire('connect');
      });
    }),
    disconnect: vi.fn(() => {
      if (!io.connected) return;
      io.connected = false;
      fire('disconnect', 'io client disconnect');
    }),
    close: vi.fn(() => {
      io.connected = false;
    }),
    removeAllListeners: vi.fn(() => handlers.clear()),
  };
  const client = {
    io,
    on: vi.fn(),
    off: vi.fn(),
    hooks: vi.fn(),
    service: vi.fn(() => ({ create: vi.fn(async () => ({ session_id: '', subscribed: false })) })),
  };
  return {
    client,
    io,
    /** Server drops the transport, then rejects the reconnect handshake. */
    rejectHandshake() {
      io.connected = false;
      fire('disconnect', 'transport close');
      fire(
        'connect_error',
        Object.assign(new Error('jwt expired'), {
          data: { code: 401, className: 'not-authenticated' },
        })
      );
    },
    rejectNextConnect(error: Error) {
      nextConnectErrors.push(error);
    },
  };
}

type Seam = ReturnType<typeof makeSeam>;

function useWiredAuth() {
  const auth = useAuth();
  const socket = useAgorClient({
    url: 'http://daemon.test',
    accessToken: auth.authenticated ? auth.accessToken : null,
    authorityGeneration: auth.authenticationGeneration,
    reconcileCredentials: auth.reconcileStoredCredentials,
    isAuthorityGenerationCurrent: auth.isAuthenticationGenerationCurrent,
  });
  return { auth, socket };
}

/** The credential the socket binding would present on its next handshake. */
function handshakeToken(seamIndex: number): string | null | undefined {
  const source = vi.mocked(createClient).mock.calls[seamIndex]?.[2]?.socketAuthentication
    ?.accessToken as (() => string | null | undefined) | undefined;
  return source?.();
}

const userA = { user_id: 'user-a', role: 'member', email: 'a@example.test' };
const userB = { user_id: 'user-b', role: 'admin', email: 'b@example.test' };

describe('cross-tab credential reconciliation (useAuth + useAgorClient)', () => {
  let seams: Seam[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    window.history.replaceState({}, '', '/');
    localStorage.clear();
    authenticate.mockReset();
    refreshCreate.mockReset();
    seams = [];
    vi.mocked(createClient).mockImplementation((() => {
      const seam = makeSeam();
      seams.push(seam);
      return seam.client;
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetRefreshFailureState();
    localStorage.clear();
  });

  const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

  async function mountAuthenticated(accessToken: string, refreshToken: string) {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    authenticate.mockImplementation(async ({ accessToken: token }: { accessToken: string }) => {
      if (token === accessToken) return { accessToken, user: userA };
      throw Object.assign(new Error('unexpected token'), { code: 401 });
    });
    const hook = renderHook(() => useWiredAuth());
    for (let i = 0; i < 5; i++) await flush();
    expect(hook.result.current.auth.user).toEqual(userA);
    expect(hook.result.current.socket.connected).toBe(true);
    expect(seams).toHaveLength(1);
    return hook;
  }

  it('rebuilds the socket for B, never presenting B on A’s binding, when another tab signs in as B during handshake refresh', async () => {
    const { result } = await mountAuthenticated('access-a', 'refresh-a');
    const generationA = result.current.auth.authenticationGeneration;
    const post = deferred<unknown>();
    refreshCreate.mockReturnValueOnce(post.promise);

    act(() => seams[0].rejectHandshake());
    await flush();
    expect(refreshCreate).toHaveBeenCalledWith({ refreshToken: 'refresh-a' });

    // Another tab signs in as B (different user and role) while A's refresh is out.
    localStorage.setItem(ACCESS_TOKEN_KEY, 'access-b');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'refresh-b');
    authenticate.mockImplementation(async ({ accessToken }: { accessToken: string }) => {
      if (accessToken === 'access-b') return { accessToken: 'access-b', user: userB };
      throw Object.assign(new Error('revoked'), { code: 401 });
    });
    await act(async () => {
      post.resolve({ accessToken: 'access-a2', refreshToken: 'refresh-a2', user: userA });
    });
    for (let i = 0; i < 5; i++) await flush();
    await act(() => vi.advanceTimersByTimeAsync(2_000));

    const { auth, socket } = result.current;
    expect(auth.user).toEqual(userB);
    expect(auth.user?.role).toBe('admin');
    expect(auth.accessToken).toBe('access-b');
    expect(auth.authenticationGeneration).toBeGreaterThan(generationA);
    // A's binding is retired without ever reconnecting with B's credential.
    expect(seams[0].io.connect).toHaveBeenCalledTimes(1);
    expect(seams[0].io.close).toHaveBeenCalled();
    expect(handshakeToken(0)).not.toBe('access-b');
    // The connected socket is a fresh binding for B, matching the UI identity.
    expect(seams).toHaveLength(2);
    expect(socket.client).toBe(seams[1].client);
    expect(socket.connected).toBe(true);
    expect(handshakeToken(1)).toBe(auth.accessToken);
    // Stored credentials stay B's; A's superseded refresh result is discarded.
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('access-b');
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('refresh-b');
  });

  it('keeps proactive refresh scheduled after another tab wins a same-user rotation', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const first = jwt(nowSeconds + 120, 'user-a');
    const rotated = jwt(nowSeconds + 600, 'user-a');
    const { result } = await mountAuthenticated(first, 'refresh-1');
    const generation = result.current.auth.authenticationGeneration;
    const post = deferred<unknown>();
    refreshCreate.mockReturnValueOnce(post.promise);

    // First proactive refresh fires 60s before `first` expires.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(refreshCreate).toHaveBeenCalledTimes(1);
    expect(refreshCreate).toHaveBeenLastCalledWith({ refreshToken: 'refresh-1' });

    // Another tab (same user) wins the rotation while this tab's POST is out.
    localStorage.setItem(ACCESS_TOKEN_KEY, rotated);
    localStorage.setItem(REFRESH_TOKEN_KEY, 'refresh-2');
    authenticate.mockImplementation(async ({ accessToken }: { accessToken: string }) => {
      if (accessToken === rotated) return { accessToken: rotated, user: userA };
      throw Object.assign(new Error('expired'), { code: 401 });
    });
    await act(async () => {
      post.resolve({ accessToken: 'discarded', refreshToken: 'discarded', user: userA });
    });
    for (let i = 0; i < 5; i++) await flush();

    expect(result.current.auth.accessToken).toBe(rotated);
    expect(result.current.auth.user).toEqual(userA);
    expect(result.current.auth.authenticationGeneration).toBe(generation);
    // Same authority: the healthy socket is kept and presents the adopted token next.
    expect(seams).toHaveLength(1);
    expect(result.current.socket.client).toBe(seams[0].client);
    expect(handshakeToken(0)).toBe(rotated);

    // The next proactive refresh is re-armed from the adopted token's expiry.
    refreshCreate.mockResolvedValueOnce({
      accessToken: jwt(nowSeconds + 1200, 'user-a'),
      refreshToken: 'refresh-3',
      user: userA,
    });
    await act(() => vi.advanceTimersByTimeAsync(600_000));
    expect(refreshCreate).toHaveBeenCalledTimes(2);
    expect(refreshCreate).toHaveBeenLastCalledWith({ refreshToken: 'refresh-2' });
  });

  it('lets logout win while socket recovery waits for reconciliation', async () => {
    const { result } = await mountAuthenticated('access-a', 'refresh-a');
    const post = deferred<unknown>();
    refreshCreate.mockReturnValueOnce(post.promise);

    act(() => seams[0].rejectHandshake());
    await flush();

    // Another tab signs in as B; validating B's credential is slow.
    localStorage.setItem(ACCESS_TOKEN_KEY, 'access-b');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'refresh-b');
    const validation = deferred<unknown>();
    authenticate.mockReturnValue(validation.promise);
    await act(async () => {
      post.resolve({ accessToken: 'access-a2', refreshToken: 'refresh-a2', user: userA });
    });
    for (let i = 0; i < 5; i++) await flush();
    // Well past any manual-reconnect delay: recovery must still be waiting.
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(seams[0].io.connect).toHaveBeenCalledTimes(1);
    expect(handshakeToken(0)).not.toBe('access-b');
    expect(result.current.auth.user).toEqual(userA);
    expect(result.current.socket.connected).toBe(false);

    await act(async () => {
      await result.current.auth.logout();
    });
    await act(async () => {
      validation.resolve({ accessToken: 'access-b', user: userB });
    });
    for (let i = 0; i < 5; i++) await flush();
    await act(() => vi.advanceTimersByTimeAsync(5_000));

    const { auth, socket } = result.current;
    expect(auth.authenticated).toBe(false);
    expect(auth.user).toBeNull();
    expect(auth.loading).toBe(false);
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    expect(socket.client).toBeNull();
    expect(socket.connected).toBe(false);
    expect(socket.connecting).toBe(false);
    expect(seams).toHaveLength(1);
    expect(seams[0].io.connect).toHaveBeenCalledTimes(1);
    expect(seams[0].io.close).toHaveBeenCalled();
  });
});
