import { createClient } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';
import { useAgorClient } from './useAgorClient';

// Keep every real export; only stub the client factory so the hook wires a
// controllable mock instead of opening a real socket.
vi.mock('@agor-live/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor-live/client')>()),
  createClient: vi.fn(),
}));

// Mock only refreshAndReauthenticate so the reconnect refresh-fallback path is
// drivable; keep the event name + error class real for the other paths.
const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('../utils/singleFlightRefresh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/singleFlightRefresh')>()),
  refreshAndReauthenticate: refreshMock,
}));

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Mock client that drives the REAL connect→authenticate flow: io.connect()
// marks the socket connected so connect()'s wait-promise resolves; io 'connect'
// handlers are captured so reconnects can be fired; authenticate() resolves by
// default and can be overridden per-call. Unknown property access resolves to a
// no-op fn so the rest of connect() can't throw.
function makeSeamClient() {
  const create = vi.fn(async () => ({ session_id: '', subscribed: false }));
  const ioHandlers: Record<string, Array<(...a: unknown[]) => void>> = {};

  const permissive = (target: Record<string, unknown>) =>
    new Proxy(target, {
      get(t, prop: string) {
        if (prop in t) return t[prop];
        const fn = vi.fn();
        t[prop] = fn;
        return fn;
      },
    });

  const io = permissive({
    connected: false,
    on: vi.fn((event: string, handler: (...a: unknown[]) => void) => {
      const handlers = ioHandlers[event] ?? [];
      handlers.push(handler);
      ioHandlers[event] = handlers;
    }),
    once: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(() => {
      io.connected = true; // wait-for-connection resolves on next check
    }),
  });

  const client = permissive({
    io,
    on: vi.fn(),
    off: vi.fn(),
    hooks: vi.fn(),
    service: vi.fn((name: string) => (name === 'session-streams' ? { create } : permissive({}))),
    authenticate: vi.fn(() => Promise.resolve({})),
  });

  const fireIo = (event: string) => {
    for (const handler of [...(ioHandlers[event] ?? [])]) handler();
  };
  return { client, create, fireIo };
}

describe('useAgorClient session-streams announce seam', () => {
  afterEach(() => {
    vi.clearAllMocks();
    refreshMock.mockReset();
  });

  it('announces session-streams capability only after authenticate() resolves', async () => {
    const { client, create } = makeSeamClient();
    const authDeferred = makeDeferred<Record<string, unknown>>();
    client.authenticate.mockReturnValue(authDeferred.promise);
    vi.mocked(createClient).mockReturnValue(client as never);

    renderHook(() => useAgorClient({ url: 'http://daemon.test', accessToken: 'access-token' }));

    // Drive the flow up to the pending authenticate() call.
    await waitFor(() => expect(client.authenticate).toHaveBeenCalled());

    // Pre-auth: announcing here would 401 — must NOT have fired yet.
    expect(create).not.toHaveBeenCalled();

    authDeferred.resolve({});
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({ capability: true });
  });

  it('re-announces on reconnect direct re-auth', async () => {
    const { client, create, fireIo } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    renderHook(() => useAgorClient({ url: 'http://daemon.test', accessToken: 'access-token' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1)); // initial auth

    // First connect marks hasConnectedOnce; the second runs the reconnect
    // handler (isReconnect=true) → direct authenticate() resolves → announce.
    fireIo('connect');
    fireIo('connect');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenLastCalledWith({ capability: true });
  });

  it('re-announces on reconnect refresh-fallback', async () => {
    const { client, create, fireIo } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    renderHook(() => useAgorClient({ url: 'http://daemon.test', accessToken: 'access-token' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1)); // initial auth

    fireIo('connect'); // marks hasConnectedOnce
    // Reconnect: direct authenticate() rejects, refresh succeeds → announce.
    client.authenticate.mockRejectedValueOnce(new Error('jwt expired'));
    refreshMock.mockResolvedValue({ accessToken: 'fresh', refreshToken: 'r' });
    fireIo('connect');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenLastCalledWith({ capability: true });
  });

  it('re-announces on in-place token-refresh reauth', async () => {
    const { client, create } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    renderHook(() => useAgorClient({ url: 'http://daemon.test', accessToken: 'access-token' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1)); // initial auth

    // Token replacement on the live socket → in-place authenticate() resolves → announce.
    window.dispatchEvent(
      new CustomEvent(TOKENS_REFRESHED_EVENT, {
        detail: { accessToken: 'fresh', refreshToken: 'r' },
      })
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenLastCalledWith({ capability: true });
  });
});
