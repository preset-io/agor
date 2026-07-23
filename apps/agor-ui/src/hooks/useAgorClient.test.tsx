import { createClient } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAgorClient } from './useAgorClient';

// Keep every real export; only stub the client factory so the hook wires a
// controllable mock instead of opening a real socket.
vi.mock('@agor-live/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor-live/client')>()),
  createClient: vi.fn(),
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
// marks the socket connected so connect()'s wait-promise resolves, then
// authenticate() returns a deferred we control to observe pre/post-auth timing.
// Unknown property access resolves to a no-op fn so the rest of connect()
// can't throw.
function makeSeamClient() {
  const create = vi.fn(async () => ({ session_id: '', subscribed: false }));
  const authDeferred = makeDeferred<Record<string, unknown>>();

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
    on: vi.fn(),
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
    authenticate: vi.fn(() => authDeferred.promise),
  });

  return { client, create, authDeferred };
}

describe('useAgorClient session-streams announce seam', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('announces session-streams capability only after authenticate() resolves', async () => {
    const { client, create, authDeferred } = makeSeamClient();
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
});
