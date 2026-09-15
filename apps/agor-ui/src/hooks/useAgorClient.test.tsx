import { createClient, createRestClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetRefreshFailureState,
  TOKENS_REFRESH_UNRECOVERABLE_EVENT,
} from '../utils/singleFlightRefresh';
import { useAgorClient } from './useAgorClient';

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
    vi.clearAllMocks();
    refreshTokensMock.mockReset();
    resetRefreshFailureState();
    localStorage.clear();
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
    expect(client.hooks).not.toHaveBeenCalled();
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
  });

  async function connectedSeam() {
    const seam = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(seam.client as never);
    const hook = renderHook(() =>
      useAgorClient({
        url: 'http://daemon.test',
        accessToken: 'token',
        authorityGeneration: 1,
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
});
