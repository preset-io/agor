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

  const permissive = (target: Record<string, unknown>) =>
    new Proxy(target, {
      get(current, prop: string) {
        if (prop in current) return current[prop];
        const fn = vi.fn();
        current[prop] = fn;
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
    connect: vi.fn(() => {
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
    disconnect: vi.fn(() => {
      if (!io.connected) return;
      io.connected = false;
      fireIo('disconnect', 'io client disconnect');
    }),
    close: vi.fn(() => {
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

  it('runs the authority cleanup boundary before publishing a new generation', async () => {
    const { client } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    let renderedGeneration = 0;
    const beforeGenerationChange = vi.fn((previous: number, next: number) => {
      expect([previous, next]).toEqual([0, 1]);
      expect(renderedGeneration).toBe(0);
    });

    const { result } = renderHook(() => {
      const connection = useAgorClient({
        url: 'http://daemon.test',
        accessToken: 'access-token',
        authorityGeneration: 1,
        onBeforeAuthGenerationChange: beforeGenerationChange,
      });
      renderedGeneration = connection.authGeneration;
      return connection;
    });
    await waitFor(() => expect(result.current.authGeneration).toBe(1));
    expect(beforeGenerationChange).toHaveBeenCalledTimes(1);
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
