import { createClient, createRestClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_REVALIDATE_REQUESTED_EVENT,
  resetRefreshFailureState,
  TOKENS_REFRESH_UNRECOVERABLE_EVENT,
} from '../utils/singleFlightRefresh';
import { RefreshSupersededError } from '../utils/tokenRefresh';
import {
  TENANT_RESTRICTION_PROBE_DELAYS_MS,
  tenantRestrictionProbeDelay,
  useAgorClient,
} from './useAgorClient';
import type { CredentialReconciliation } from './useAuth';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Keep every real export; only stub the client factory so the hook wires a
// controllable mock instead of opening a real socket.
vi.mock('@agor-live/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor-live/client')>()),
  createClient: vi.fn(),
  createRestClient: vi.fn(),
}));

const { refreshTokensMock } = vi.hoisted(() => ({ refreshTokensMock: vi.fn() }));
vi.mock('../utils/singleFlightRefresh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/singleFlightRefresh')>()),
  refreshTokensSingleFlight: refreshTokensMock,
}));

type SocketHandler = { fn: (...args: unknown[]) => void; once: boolean };

/**
 * Socket seam with the lifecycle guarantees useAgorClient relies on. A call
 * to connect completes asynchronously and emits the namespace `connect`
 * event, exactly as a successfully authenticated real handshake does.
 */
function makeSeamClient() {
  const create = vi.fn(async () => ({ session_id: '', subscribed: false }));
  const ioHandlers = new Map<string, SocketHandler[]>();

  const addHandler = (event: string, fn: (...args: unknown[]) => void, once: boolean) => {
    ioHandlers.set(event, [...(ioHandlers.get(event) ?? []), { fn, once }]);
  };
  const removeHandler = (event: string, fn: (...args: unknown[]) => void) => {
    ioHandlers.set(
      event,
      (ioHandlers.get(event) ?? []).filter((entry) => entry.fn !== fn)
    );
  };
  const fireIo = (event: string, ...args: unknown[]) => {
    const handlers = [...(ioHandlers.get(event) ?? [])];
    ioHandlers.set(
      event,
      handlers.filter((entry) => !entry.once)
    );
    for (const handler of handlers) handler.fn(...args);
  };
  const nextConnectErrors: Error[] = [];

  const permissive = <T extends Record<string, unknown>>(target: T): T =>
    new Proxy(target, {
      get(current, prop: string) {
        if (prop in current) return current[prop];
        const fn = vi.fn();
        (current as Record<string, unknown>)[prop] = fn;
        return fn;
      },
    });

  const io = permissive({
    connected: false,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      addHandler(event, handler, false);
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      addHandler(event, handler, true);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      removeHandler(event, handler);
    }),
    connect: vi.fn((): void => {
      if (io.connected) return;
      queueMicrotask(() => {
        const error = nextConnectErrors.shift();
        if (error) {
          fireIo('connect_error', error);
          return;
        }
        io.connected = true;
        fireIo('connect');
      });
    }),
    disconnect: vi.fn((): void => {
      if (!io.connected) return;
      io.connected = false;
      fireIo('disconnect', 'io client disconnect');
    }),
    close: vi.fn((): void => {
      io.connected = false;
    }),
    removeAllListeners: vi.fn(() => ioHandlers.clear()),
  });

  const client = permissive({
    io,
    on: vi.fn(),
    off: vi.fn(),
    hooks: vi.fn(),
    service: vi.fn((name: string) => (name === 'session-streams' ? { create } : permissive({}))),
    authenticate: vi.fn(() => Promise.resolve({})),
  });

  return {
    client,
    create,
    fireIo,
    io,
    rejectNextConnect(error: Error) {
      nextConnectErrors.push(error);
    },
  };
}

describe('useAgorClient authenticated handshake lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    refreshTokensMock.mockReset();
    resetRefreshFailureState();
    localStorage.clear();
  });

  it('uses neutral copy for initial and repeated failures, then recovers on manual retry', async () => {
    const { client, io, fireIo, rejectNextConnect } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const transportError = new Error('Cannot reach https://internal.test:4444/?token=secret');
    rejectNextConnect(transportError);

    const { result } = renderHook(() =>
      useAgorClient({
        url: 'https://configured.test:8443',
        accessToken: 'access-token',
        authorityGeneration: 1,
      })
    );

    await waitFor(() => expect(result.current.connecting).toBe(false));
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toBe('Failed to connect to Agor daemon');
    // Repeated transport failures retain the same neutral copy.
    act(() => fireIo('connect_error', transportError));
    expect(result.current.error).toBe('Failed to connect to Agor daemon');
    expect(result.current.error).not.toMatch(/3030|pnpm dev|cd apps|internal.test|secret/);

    act(() => result.current.retryConnection());
    expect(result.current.error).toBeNull();
    expect(result.current.connecting).toBe(true);
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.connecting).toBe(false);
    expect(io.connect).toHaveBeenCalledTimes(2);

    act(() => {
      io.connected = false;
      fireIo('disconnect', 'transport close');
      fireIo('connect_error', transportError);
    });
    expect(result.current.connecting).toBe(true);
    expect(result.current.error).toBeNull();
    act(() => io.connect());
    await waitFor(() => expect(result.current.connected).toBe(true));
  });

  it('uses neutral copy on a transport timeout and accepts a later connection', async () => {
    vi.useFakeTimers();
    const { client, io, fireIo } = makeSeamClient();
    vi.mocked(io.connect).mockImplementation(() => {});
    vi.mocked(createClient).mockReturnValue(client as never);
    const { result } = renderHook(() =>
      useAgorClient({ accessToken: 'access-token', authorityGeneration: 1 })
    );

    act(() => fireIo('connect_error', new Error('timeout')));
    expect(result.current.error).toBe('Failed to connect to Agor daemon');
    expect(result.current.connecting).toBe(false);
    expect(result.current.connected).toBe(false);

    act(() => {
      io.connected = true;
      fireIo('connect');
    });
    expect(result.current.error).toBeNull();
    expect(result.current.connected).toBe(true);
  });

  it('announces session-streams capability after the authenticated handshake without live reauthentication', async () => {
    const { client, create } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    const { result } = renderHook(() =>
      useAgorClient({
        url: 'http://daemon.test',
        accessToken: 'access-token',
        authorityGeneration: 1,
      })
    );

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({ capability: true });
    expect(client.authenticate).not.toHaveBeenCalled();
    // The only client-level hook is the restriction observer; the authentication client is never configured here.
    expect(client.hooks).toHaveBeenCalledExactlyOnceWith({ error: [expect.any(Function)] });
    expect(result.current.authGeneration).toBe(1);
  });

  it('re-announces socket-scoped capability after a normal transport reconnect', async () => {
    const { client, create, fireIo, io } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    const { result } = renderHook(() =>
      useAgorClient({
        url: 'http://daemon.test',
        accessToken: 'access-token',
        authorityGeneration: 1,
      })
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(result.current.authGeneration).toBe(1);

    act(() => {
      io.connected = false;
      fireIo('disconnect', 'transport close');
      io.connect();
    });

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenLastCalledWith({ capability: true });
    expect(client.authenticate).not.toHaveBeenCalled();
    expect(result.current.authGeneration).toBe(2);
  });

  it('updates the next handshake token without replacing a same-authority socket', async () => {
    const { client, create, io } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    const { result, rerender } = renderHook(
      ({ accessToken }) =>
        useAgorClient({
          url: 'http://daemon.test',
          accessToken,
          authorityGeneration: 7,
        }),
      { initialProps: { accessToken: 'access-token' } }
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const originalClient = result.current.client;

    const clientOptions = vi.mocked(createClient).mock.calls[0][2];
    const tokenSource = clientOptions?.socketAuthentication?.accessToken;
    expect(typeof tokenSource).toBe('function');
    expect((tokenSource as () => string | null | undefined)()).toBe('access-token');

    rerender({ accessToken: 'fresh' });

    await waitFor(() => expect((tokenSource as () => string | null | undefined)()).toBe('fresh'));
    expect(result.current.client).toBe(originalClient);
    expect(create).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(io.disconnect).not.toHaveBeenCalled();
    expect((tokenSource as () => string | null | undefined)()).toBe('fresh');
    expect(client.authenticate).not.toHaveBeenCalled();
  });

  it('replaces and closes the client when authenticated authority changes', async () => {
    const first = makeSeamClient();
    const second = makeSeamClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(first.client as never)
      .mockReturnValueOnce(second.client as never);
    const renderExposures: Array<{ generation: number; client: unknown }> = [];

    const { result, rerender } = renderHook(
      ({ accessToken, authorityGeneration }) => {
        const value = useAgorClient({
          url: 'http://daemon.test',
          accessToken,
          authorityGeneration,
        });
        renderExposures.push({ generation: authorityGeneration, client: value.client });
        return value;
      },
      {
        initialProps: { accessToken: 'tenant-a-token', authorityGeneration: 1 },
      }
    );

    await waitFor(() => expect(result.current.client).toBe(first.client));
    rerender({ accessToken: 'tenant-b-token', authorityGeneration: 2 });

    // React may already have run the new effect by the time rerender returns,
    // but no generation-2 render may expose generation 1's client.
    expect(
      renderExposures
        .filter(({ generation }) => generation === 2)
        .every(({ client }) => client !== first.client)
    ).toBe(true);
    expect(first.io.close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.client).toBe(second.client));
    expect(createClient).toHaveBeenCalledTimes(2);

    const firstTokenSource =
      vi.mocked(createClient).mock.calls[0][2]?.socketAuthentication?.accessToken;
    const secondTokenSource =
      vi.mocked(createClient).mock.calls[1][2]?.socketAuthentication?.accessToken;
    expect((firstTokenSource as () => string | null | undefined)()).toBe('tenant-a-token');
    expect((secondTokenSource as () => string | null | undefined)()).toBe('tenant-b-token');
  });

  it('refreshes over REST and retries when an authenticated handshake is rejected', async () => {
    const { client, create, rejectNextConnect } = makeSeamClient();
    const restClient = { service: vi.fn() };
    vi.mocked(createClient).mockReturnValue(client as never);
    vi.mocked(createRestClient).mockResolvedValue(restClient as never);
    refreshTokensMock.mockResolvedValue({
      accessToken: 'fresh-after-rejection',
      refreshToken: 'next-refresh',
      user: { user_id: 'u1' },
    });
    localStorage.setItem('agor-refresh-token', 'stored-refresh');
    rejectNextConnect(
      Object.assign(new Error('Invalid or expired authentication token'), {
        data: { code: 401, className: 'not-authenticated' },
      })
    );

    renderHook(() =>
      useAgorClient({
        url: 'http://daemon.test',
        accessToken: 'stale',
        authorityGeneration: 1,
      })
    );

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(createRestClient).toHaveBeenCalledWith('http://daemon.test');
    expect(refreshTokensMock).toHaveBeenCalledWith(restClient, 'stored-refresh');
    const tokenSource = vi.mocked(createClient).mock.calls[0][2]?.socketAuthentication?.accessToken;
    expect((tokenSource as () => string | null | undefined)()).toBe('fresh-after-rejection');
    expect(client.authenticate).not.toHaveBeenCalled();
  });

  it('fails closed when a refreshed credential is still rejected by the handshake', async () => {
    const { client, rejectNextConnect } = makeSeamClient();
    const restClient = { service: vi.fn() };
    vi.mocked(createClient).mockReturnValue(client as never);
    vi.mocked(createRestClient).mockResolvedValue(restClient as never);
    refreshTokensMock.mockResolvedValue({
      accessToken: 'still-rejected',
      refreshToken: 'next-refresh',
      user: { user_id: 'u1' },
    });
    localStorage.setItem('agor-refresh-token', 'stored-refresh');
    const rejected = () =>
      Object.assign(new Error('Invalid or expired authentication token'), {
        data: { code: 401, className: 'not-authenticated' },
      });
    rejectNextConnect(rejected());
    rejectNextConnect(rejected());
    const unrecoverable = vi.fn();
    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, unrecoverable);
    try {
      const { result } = renderHook(() =>
        useAgorClient({
          url: 'http://daemon.test',
          accessToken: 'stale',
          authorityGeneration: 1,
        })
      );

      await waitFor(() =>
        expect(result.current.error).toBe(
          'Authentication could not be restored. Please sign in again.'
        )
      );
      expect(refreshTokensMock).toHaveBeenCalledTimes(1);
      expect(unrecoverable).toHaveBeenCalledTimes(1);
      expect(result.current.connected).toBe(false);
    } finally {
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, unrecoverable);
    }
  });
});

describe('weak-network recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    refreshTokensMock.mockReset();
    localStorage.clear();
  });

  async function connectedSeam(
    auth: Pick<
      Parameters<typeof useAgorClient>[0],
      'reconcileCredentials' | 'isAuthorityGenerationCurrent'
    > = {}
  ) {
    const seam = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(seam.client as never);
    const hook = renderHook(() =>
      useAgorClient({
        url: 'http://daemon.test',
        accessToken: 'token',
        authorityGeneration: 1,
        ...auth,
      })
    );
    await act(async () => {});
    return { ...seam, ...hook };
  }

  it('does not fail a slow initial handshake after an unrelated five-second deadline', async () => {
    vi.useFakeTimers();
    const seam = makeSeamClient();
    vi.mocked(seam.io.connect).mockImplementation(() => {});
    vi.mocked(createClient).mockReturnValue(seam.client as never);
    const { result } = renderHook(() =>
      useAgorClient({
        url: 'http://daemon.test',
        accessToken: 'token',
        authorityGeneration: 1,
      })
    );
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(result.current.error).toBeNull();
    expect(result.current.connecting).toBe(true);
    act(() => {
      seam.io.connected = true;
      seam.fireIo('connect');
    });
    expect(result.current.connected).toBe(true);
  });

  it('keeps the same client and honors disconnect grace through a failed retry', async () => {
    vi.useFakeTimers();
    const { result, io, fireIo } = await connectedSeam();
    const client = result.current.client;
    act(() => {
      io.connected = false;
      fireIo('disconnect', 'transport close');
      fireIo('connect_error', new Error('transport error'));
    });
    expect(result.current.connected).toBe(true);
    expect(result.current.connecting).toBe(true); // mutation gate stays CLOSED
    await act(() => vi.advanceTimersByTimeAsync(1499));
    expect(result.current.connected).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.connected).toBe(false);
    expect(result.current.client).toBe(client);
    expect(result.current.error).toBeNull();
    act(() => {
      io.connected = true;
      fireIo('connect');
    });
    expect(result.current.connected).toBe(true);
    expect(result.current.client).toBe(client);
  });

  it('backs off repeated server kicks with jitter, and resets only after stability', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // lower jitter bound: 50%
    const { io, fireIo, unmount } = await connectedSeam();
    const kick = () =>
      act(() => {
        io.connected = false;
        fireIo('disconnect', 'io server disconnect');
      });
    for (const delay of [250, 500, 1000]) {
      const count = vi.mocked(io.connect).mock.calls.length;
      kick();
      await act(() => vi.advanceTimersByTimeAsync(delay - 1));
      expect(io.connect).toHaveBeenCalledTimes(count);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(io.connect).toHaveBeenCalledTimes(count + 1);
    }
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    kick();
    const count = vi.mocked(io.connect).mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(io.connect).toHaveBeenCalledTimes(count + 1);
    kick();
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(io.connect).toHaveBeenCalledTimes(count + 1);
  });
  it('starts a fresh reconnect budget on Retry after exhaustion and recovers from a transient failure', async () => {
    vi.useFakeTimers();
    const { io, fireIo, result, rejectNextConnect } = await connectedSeam();
    const kick = () =>
      act(() => {
        io.connected = false;
        fireIo('disconnect', 'io server disconnect');
      });

    // Brief successful handshakes must not reset the ten-attempt budget.
    for (let attempt = 0; attempt < 10; attempt++) {
      kick();
      await act(() => vi.advanceTimersByTimeAsync(Math.min(500 * 2 ** attempt, 30_000)));
    }
    kick();
    expect(io.connect).toHaveBeenCalledTimes(11);
    expect(result.current.connecting).toBe(false);
    expect(result.current.error).toContain('after multiple attempts');

    // A rejected namespace cannot auto-reconnect; a transient REST refresh
    // failure must schedule another handshake rather than give up again.
    localStorage.setItem('agor-refresh-token', 'refresh');
    vi.mocked(createRestClient).mockResolvedValue({} as never);
    refreshTokensMock.mockRejectedValueOnce(new Error('network error'));
    rejectNextConnect(Object.assign(new Error('expired'), { code: 401 }));
    await act(async () => result.current.retryConnection());
    expect(io.connect).toHaveBeenCalledTimes(12);
    expect(result.current.error).toBeNull();
    expect(result.current.connecting).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(io.connect).toHaveBeenCalledTimes(13);
    expect(result.current.connected).toBe(true);
    expect(result.current.connecting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('pauses manual retries offline and resumes without replacing the client', async () => {
    vi.useFakeTimers();
    const { io, fireIo, result } = await connectedSeam();
    const client = result.current.client;
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      io.connected = false;
      fireIo('disconnect', 'io server disconnect');
    });
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(io.connect).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    online.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('online')));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(io.connect).toHaveBeenCalledTimes(2);
    expect(result.current.connected).toBe(true);
    expect(result.current.client).toBe(client);
  });

  it('retries a transient REST refresh failure after namespace authentication rejection', async () => {
    vi.useFakeTimers();
    const { io, fireIo, result } = await connectedSeam();
    localStorage.setItem('agor-refresh-token', 'refresh');
    vi.mocked(createRestClient).mockResolvedValue({} as never);
    refreshTokensMock.mockRejectedValueOnce(new Error('network error'));
    act(() => {
      io.connected = false;
      fireIo('disconnect', 'transport close');
      fireIo('connect_error', Object.assign(new Error('expired'), { code: 401 }));
    });
    await act(async () => {});
    expect(result.current.error).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(io.connect).toHaveBeenCalledTimes(2);
    expect(result.current.connected).toBe(true);
    localStorage.clear();
    refreshTokensMock.mockReset();
  });

  it('resumes the handshake with the useAuth-reconciled token when a same-authority refresh is superseded', async () => {
    vi.useFakeTimers();
    const reconcile = deferred<CredentialReconciliation>();
    const reconcileCredentials = vi.fn(() => reconcile.promise);
    const { io, fireIo, result } = await connectedSeam({ reconcileCredentials });
    localStorage.setItem('agor-refresh-token', 'refresh-old');
    vi.mocked(createRestClient).mockResolvedValue({} as never);
    refreshTokensMock.mockRejectedValueOnce(new RefreshSupersededError());
    // Another tab has since rotated and stored fresh credentials.
    localStorage.setItem('agor-access-token', 'access-from-other-tab');
    act(() => {
      io.connected = false;
      fireIo('disconnect', 'transport close');
      fireIo('connect_error', Object.assign(new Error('expired'), { code: 401 }));
    });
    await act(async () => {});
    expect(reconcileCredentials).toHaveBeenCalledTimes(1);
    // The stored token is never adopted directly; recovery waits for useAuth.
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(io.connect).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.connecting).toBe(true);

    await act(async () => {
      reconcile.resolve({
        status: 'authenticated',
        accessToken: 'access-from-other-tab',
        authenticationGeneration: 1,
      });
    });
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(io.connect).toHaveBeenCalledTimes(2);
    expect(result.current.connected).toBe(true);
    const tokenSource = vi.mocked(createClient).mock.calls.at(-1)?.[2]
      ?.socketAuthentication?.accessToken;
    expect((tokenSource as () => string | null | undefined)()).toBe('access-from-other-tab');
    localStorage.clear();
    refreshTokensMock.mockReset();
  });

  it('never reconnects a binding whose authority reconciliation replaced', async () => {
    vi.useFakeTimers();
    const reconcileCredentials = vi.fn(
      async (): Promise<CredentialReconciliation> => ({
        status: 'authenticated',
        accessToken: 'access-user-b',
        authenticationGeneration: 2,
      })
    );
    const { io, fireIo, result } = await connectedSeam({ reconcileCredentials });
    localStorage.setItem('agor-refresh-token', 'refresh-old');
    vi.mocked(createRestClient).mockResolvedValue({} as never);
    refreshTokensMock.mockRejectedValueOnce(new RefreshSupersededError());
    act(() => {
      io.connected = false;
      fireIo('disconnect', 'transport close');
      fireIo('connect_error', Object.assign(new Error('expired'), { code: 401 }));
    });
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    expect(io.connect).toHaveBeenCalledTimes(1);
    const tokenSource = vi.mocked(createClient).mock.calls.at(-1)?.[2]
      ?.socketAuthentication?.accessToken;
    expect((tokenSource as () => string | null | undefined)()).toBe('token');
    expect(result.current.error).toBeNull();
    localStorage.clear();
    refreshTokensMock.mockReset();
  });

  it('does not reconnect with a refresh result once useAuth replaced the authority', async () => {
    vi.useFakeTimers();
    let currentGeneration = 1;
    const { io, fireIo } = await connectedSeam({
      isAuthorityGenerationCurrent: (generation) => generation === currentGeneration,
    });
    localStorage.setItem('agor-refresh-token', 'refresh-of-other-identity');
    vi.mocked(createRestClient).mockResolvedValue({} as never);
    refreshTokensMock.mockImplementationOnce(async () => {
      // The refreshed identity differs, so useAuth adopts it as a new authority.
      currentGeneration = 2;
      return { accessToken: 'access-other', refreshToken: 'refresh-next', user: { user_id: 'u2' } };
    });
    act(() => {
      io.connected = false;
      fireIo('disconnect', 'transport close');
      fireIo('connect_error', Object.assign(new Error('expired'), { code: 401 }));
    });
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    expect(io.connect).toHaveBeenCalledTimes(1);
    const tokenSource = vi.mocked(createClient).mock.calls.at(-1)?.[2]
      ?.socketAuthentication?.accessToken;
    expect((tokenSource as () => string | null | undefined)()).toBe('token');
    localStorage.clear();
    refreshTokensMock.mockReset();
  });

  it('stands down without an error when a superseded refresh left no stored credentials', async () => {
    vi.useFakeTimers();
    const { io, fireIo, result } = await connectedSeam();
    localStorage.setItem('agor-refresh-token', 'refresh-old');
    vi.mocked(createRestClient).mockResolvedValue({} as never);
    refreshTokensMock.mockImplementationOnce(async () => {
      localStorage.clear();
      throw new RefreshSupersededError();
    });
    const revalidate = vi.fn();
    window.addEventListener(AUTH_REVALIDATE_REQUESTED_EVENT, revalidate);
    act(() => {
      io.connected = false;
      fireIo('disconnect', 'transport close');
      fireIo('connect_error', Object.assign(new Error('expired'), { code: 401 }));
    });
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    window.removeEventListener(AUTH_REVALIDATE_REQUESTED_EVENT, revalidate);
    expect(result.current.error).toBeNull();
    expect(result.current.connecting).toBe(false);
    expect(io.connect).toHaveBeenCalledTimes(1);
    // Nothing else notices a cross-tab sign-out, so useAuth must be asked.
    expect(revalidate).toHaveBeenCalledTimes(1);
    refreshTokensMock.mockReset();
  });
});

describe('useAgorClient unavailable handshake', () => {
  const unavailableHandshake = () =>
    Object.assign(new Error('Authentication cannot be verified right now'), {
      data: { code: 503, className: 'unavailable' },
    });

  // Pin reconnect jitter to its ceiling so the backoff schedule is exact.
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.clearAllMocks();
    refreshTokensMock.mockReset();
    resetRefreshFailureState();
    localStorage.clear();
  });

  it('reconnects with backoff after two 503 handshakes without refreshing or signing out', async () => {
    vi.useFakeTimers();
    const { client, io, rejectNextConnect } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    localStorage.setItem('agor-refresh-token', 'stored-refresh');
    rejectNextConnect(unavailableHandshake());
    rejectNextConnect(unavailableHandshake());
    const unrecoverable = vi.fn();
    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, unrecoverable);
    try {
      const { result } = renderHook(() =>
        useAgorClient({ url: 'http://daemon.test', accessToken: 'kept', authorityGeneration: 1 })
      );

      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(io.connect).toHaveBeenCalledTimes(1);
      expect(result.current.connecting).toBe(true);
      expect(result.current.error).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(io.connect).toHaveBeenCalledTimes(2);
      expect(result.current.connected).toBe(false);
      expect(result.current.error).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(999));
      expect(io.connect).toHaveBeenCalledTimes(2);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(io.connect).toHaveBeenCalledTimes(3);
      expect(result.current.connected).toBe(true);
      expect(result.current.error).toBeNull();

      expect(refreshTokensMock).not.toHaveBeenCalled();
      expect(createRestClient).not.toHaveBeenCalled();
      expect(unrecoverable).not.toHaveBeenCalled();
      expect(localStorage.getItem('agor-refresh-token')).toBe('stored-refresh');
      const tokenSource =
        vi.mocked(createClient).mock.calls[0][2]?.socketAuthentication?.accessToken;
      expect((tokenSource as () => string | null | undefined)()).toBe('kept');
    } finally {
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, unrecoverable);
    }
  });

  it('falls back to a slow probe instead of giving up while handshakes stay unavailable', async () => {
    vi.useFakeTimers();
    const { client, io, rejectNextConnect } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    localStorage.setItem('agor-refresh-token', 'stored-refresh');
    for (let i = 0; i < 12; i++) rejectNextConnect(unavailableHandshake());

    const { result } = renderHook(() =>
      useAgorClient({ url: 'http://daemon.test', accessToken: 'kept', authorityGeneration: 1 })
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    // Ten backoff attempts: 500ms, 1s, 2s, 4s, 8s, 16s, then 30s four times.
    await act(() => vi.advanceTimersByTimeAsync(151_500));
    expect(io.connect).toHaveBeenCalledTimes(11);
    expect(result.current.error).toBeNull();
    expect(result.current.connecting).toBe(true);
    expect(result.current.connected).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(TENANT_RESTRICTION_PROBE_DELAYS_MS[0] - 1));
    expect(io.connect).toHaveBeenCalledTimes(11);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(io.connect).toHaveBeenCalledTimes(12);
    expect(result.current.error).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(TENANT_RESTRICTION_PROBE_DELAYS_MS[1]));
    expect(io.connect).toHaveBeenCalledTimes(13);
    expect(result.current.connected).toBe(true);
    expect(result.current.error).toBeNull();
    expect(refreshTokensMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('agor-refresh-token')).toBe('stored-refresh');
    const tokenSource = vi.mocked(createClient).mock.calls[0][2]?.socketAuthentication?.accessToken;
    expect((tokenSource as () => string | null | undefined)()).toBe('kept');
  });

  it('still refreshes over REST when a later handshake is a real 401', async () => {
    vi.useFakeTimers();
    const { client, io, rejectNextConnect } = makeSeamClient();
    const restClient = { service: vi.fn() };
    vi.mocked(createClient).mockReturnValue(client as never);
    vi.mocked(createRestClient).mockResolvedValue(restClient as never);
    refreshTokensMock.mockResolvedValue({
      accessToken: 'fresh-after-401',
      refreshToken: 'next-refresh',
      user: { user_id: 'u1' },
    });
    localStorage.setItem('agor-refresh-token', 'stored-refresh');
    rejectNextConnect(unavailableHandshake());
    rejectNextConnect(
      Object.assign(new Error('Invalid or expired authentication token'), {
        data: { code: 401, className: 'not-authenticated' },
      })
    );

    const { result } = renderHook(() =>
      useAgorClient({ url: 'http://daemon.test', accessToken: 'stale', authorityGeneration: 1 })
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(refreshTokensMock).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(refreshTokensMock).toHaveBeenCalledExactlyOnceWith(restClient, 'stored-refresh');
    expect(io.connect).toHaveBeenCalledTimes(3);
    expect(result.current.connected).toBe(true);
    const tokenSource = vi.mocked(createClient).mock.calls[0][2]?.socketAuthentication?.accessToken;
    expect((tokenSource as () => string | null | undefined)()).toBe('fresh-after-401');
  });

  it('backs off without an error when the handshake retried after a refresh is unavailable', async () => {
    vi.useFakeTimers();
    const { client, io, rejectNextConnect } = makeSeamClient();
    const restClient = { service: vi.fn() };
    vi.mocked(createClient).mockReturnValue(client as never);
    vi.mocked(createRestClient).mockResolvedValue(restClient as never);
    refreshTokensMock.mockResolvedValue({
      accessToken: 'fresh-after-401',
      refreshToken: 'next-refresh',
      user: { user_id: 'u1' },
    });
    localStorage.setItem('agor-refresh-token', 'stored-refresh');
    rejectNextConnect(
      Object.assign(new Error('Invalid or expired authentication token'), {
        data: { code: 401, className: 'not-authenticated' },
      })
    );
    rejectNextConnect(unavailableHandshake());
    const errors: Array<string | null> = [];

    const { result } = renderHook(() => {
      const state = useAgorClient({
        url: 'http://daemon.test',
        accessToken: 'stale',
        authorityGeneration: 1,
      });
      errors.push(state.error);
      return state;
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(refreshTokensMock).toHaveBeenCalledExactlyOnceWith(restClient, 'stored-refresh');
    expect(io.connect).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.connecting).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(io.connect).toHaveBeenCalledTimes(3);
    expect(result.current.connected).toBe(true);
    expect(errors.every((error) => error === null)).toBe(true);
    const tokenSource = vi.mocked(createClient).mock.calls[0][2]?.socketAuthentication?.accessToken;
    expect((tokenSource as () => string | null | undefined)()).toBe('fresh-after-401');
  });
});

describe('useAgorClient suspended workspace lifecycle', () => {
  const restrictedHandshake = () =>
    Object.assign(new Error('Tenant access is restricted'), {
      data: { code: 'tenant_restricted' },
    });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    refreshTokensMock.mockReset();
    resetRefreshFailureState();
    localStorage.clear();
  });

  function renderRestricted() {
    const seam = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(seam.client as never);
    seam.rejectNextConnect(restrictedHandshake());
    const rendered = renderHook(() =>
      useAgorClient({
        url: 'http://daemon.test',
        accessToken: 'access-token',
        authorityGeneration: 1,
      })
    );
    return { ...seam, ...rendered };
  }

  it('re-probes on the documented schedule instead of reconnecting', () => {
    expect([...TENANT_RESTRICTION_PROBE_DELAYS_MS]).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000,
    ]);
    // A long suspension settles on the ceiling rather than growing unbounded.
    expect(tenantRestrictionProbeDelay(4)).toBe(300_000);
    expect(tenantRestrictionProbeDelay(99)).toBe(300_000);
  });

  it('enters the suspended state and stops the reconnect loop', async () => {
    vi.useFakeTimers();
    const { result, io } = renderRestricted();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.tenantRestricted).toBe(true);
    expect(result.current.connected).toBe(false);
    // Not "reconnecting": the socket is closed on purpose.
    expect(result.current.connecting).toBe(false);
    expect(result.current.error).toBeNull();
    // Only closing the socket stops Socket.IO's own retry cadence.
    expect(io.disconnect).toHaveBeenCalled();
    const connectsOnRejection = io.connect.mock.calls.length;

    // Socket.IO's own 1–5s retry cadence would have fired many times here.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(io.connect).toHaveBeenCalledTimes(connectsOnRejection);
  });

  it('backs off 30s, 1m then 2m while the workspace stays suspended', async () => {
    vi.useFakeTimers();
    const { result, io, rejectNextConnect } = renderRestricted();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const baseline = io.connect.mock.calls.length;

    for (const [index, delay] of [30_000, 60_000, 120_000].entries()) {
      rejectNextConnect(restrictedHandshake());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 1);
      });
      expect(io.connect).toHaveBeenCalledTimes(baseline + index);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(io.connect).toHaveBeenCalledTimes(baseline + index + 1);
      expect(result.current.tenantRestricted).toBe(true);
    }
  });

  it('leaves the suspended state on the first accepted probe without a refresh', async () => {
    vi.useFakeTimers();
    const { result, create } = renderRestricted();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.tenantRestricted).toBe(true);

    // Release recorded by the operator: the next handshake is accepted.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(result.current.tenantRestricted).toBe(false);
    expect(result.current.connected).toBe(true);
    expect(create).toHaveBeenCalledWith({ capability: true });
  });

  it('keeps the slow cadence when a probe fails for an unrelated reason', async () => {
    vi.useFakeTimers();
    const { result, io, rejectNextConnect } = renderRestricted();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const baseline = io.connect.mock.calls.length;

    rejectNextConnect(new Error('xhr poll error'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(io.connect).toHaveBeenCalledTimes(baseline + 1);
    // An unreachable daemon neither overturns "restricted" nor restores the fast retry.
    expect(result.current.tenantRestricted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(io.connect).toHaveBeenCalledTimes(baseline + 1);
  });

  it('recovers the credential when a probe is rejected rather than staying parked', async () => {
    vi.useFakeTimers();
    const restClient = { service: vi.fn() };
    vi.mocked(createRestClient).mockResolvedValue(restClient as never);
    refreshTokensMock.mockResolvedValue({
      accessToken: 'fresh-after-release',
      refreshToken: 'next-refresh',
      user: { user_id: 'u1' },
    });
    localStorage.setItem('agor-refresh-token', 'stored-refresh');
    const { result, rejectNextConnect } = renderRestricted();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.tenantRestricted).toBe(true);

    // The credential epoch is checked first and moves on restrict, so an old token gets a credential rejection.
    rejectNextConnect(
      Object.assign(new Error('Invalid or expired authentication token'), {
        data: { code: 401, className: 'not-authenticated' },
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // Recovery runs instead of parking, and an accepted handshake clears the state.
    expect(refreshTokensMock).toHaveBeenCalledWith(restClient, 'stored-refresh');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.tenantRestricted).toBe(false);
    expect(result.current.connected).toBe(true);
  });

  it.each([
    { name: 'the refresh itself', refreshRestricted: true },
    { name: 'the refreshed handshake', refreshRestricted: false },
  ])(
    'keeps probing when $name reports the suspension after a 401 probe',
    async ({ refreshRestricted }) => {
      vi.useFakeTimers();
      vi.mocked(createRestClient).mockResolvedValue({ service: vi.fn() } as never);
      if (refreshRestricted) refreshTokensMock.mockRejectedValue(restrictedHandshake());
      else
        refreshTokensMock.mockResolvedValue({
          accessToken: 'fresh-still-suspended',
          refreshToken: 'next-refresh',
          user: { user_id: 'u1' },
        });
      localStorage.setItem('agor-refresh-token', 'stored-refresh');
      const { result, io, rejectNextConnect } = renderRestricted();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      rejectNextConnect(
        Object.assign(new Error('Invalid or expired authentication token'), {
          data: { code: 401, className: 'not-authenticated' },
        })
      );
      if (!refreshRestricted) rejectNextConnect(restrictedHandshake());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(refreshTokensMock).toHaveBeenCalledOnce();
      expect(result.current.tenantRestricted).toBe(true);
      expect(result.current.error).toBeNull();
      const afterRecovery = io.connect.mock.calls.length;

      // The next probe still fires on the slow schedule; the tab is never parked.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TENANT_RESTRICTION_PROBE_DELAYS_MS[1]!);
      });
      expect(io.connect.mock.calls.length).toBeGreaterThan(afterRecovery);
      expect(result.current.tenantRestricted).toBe(false);
      expect(result.current.connected).toBe(true);
    }
  );

  it('enters the suspended state from a rejected service call', async () => {
    vi.useFakeTimers();
    const seam = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(seam.client as never);
    const { result } = renderHook(() =>
      useAgorClient({
        url: 'http://daemon.test',
        accessToken: 'access-token',
        authorityGeneration: 1,
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.connected).toBe(true);

    const observeError = vi.mocked(seam.client.hooks).mock.calls[0][0].error[0];
    act(() => {
      observeError({
        error: Object.assign(new Error('Tenant access is restricted'), {
          code: 403,
          data: { code: 'tenant_restricted' },
        }),
      });
    });

    expect(result.current.tenantRestricted).toBe(true);
    expect(seam.io.disconnect).toHaveBeenCalled();
  });

  it('enters the suspended state from the coded 401 the credential check raises', async () => {
    // A closed workspace answers JWT paths with a coded 401; like the 403, it must never start a token refresh.
    vi.useFakeTimers();
    localStorage.setItem('agor-refresh-token', 'stored-refresh');
    const seam = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(seam.client as never);
    seam.rejectNextConnect(
      Object.assign(new Error('Tenant credential cannot be verified'), {
        code: 401,
        className: 'not-authenticated',
        data: { code: 'tenant_restricted' },
      })
    );
    const { result } = renderHook(() =>
      useAgorClient({
        url: 'http://daemon.test',
        accessToken: 'access-token',
        authorityGeneration: 1,
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.tenantRestricted).toBe(true);
    expect(result.current.connecting).toBe(false);
    expect(result.current.error).toBeNull();
    expect(refreshTokensMock).not.toHaveBeenCalled();

    const observeError = vi.mocked(seam.client.hooks).mock.calls[0][0].error[0];
    act(() => {
      observeError({
        error: Object.assign(new Error('Tenant credential cannot be verified'), {
          code: 401,
          data: { code: 'tenant_restricted' },
        }),
      });
    });
    expect(result.current.tenantRestricted).toBe(true);
  });

  it('ignores an ordinary service failure', async () => {
    vi.useFakeTimers();
    const seam = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(seam.client as never);
    const { result } = renderHook(() =>
      useAgorClient({
        url: 'http://daemon.test',
        accessToken: 'access-token',
        authorityGeneration: 1,
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const observeError = vi.mocked(seam.client.hooks).mock.calls[0][0].error[0];
    act(() => {
      observeError({ error: Object.assign(new Error('Not found'), { code: 404 }) });
      observeError({ error: Object.assign(new Error('Forbidden'), { code: 403 }) });
    });

    expect(result.current.tenantRestricted).toBe(false);
    expect(result.current.connected).toBe(true);
  });
});
