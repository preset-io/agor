import { createClient } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAgorClient } from './useAgorClient';

// Keep every real export; only stub the client factory so the hook wires a
// controllable mock instead of opening a real socket.
vi.mock('@agor-live/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor-live/client')>()),
  createClient: vi.fn(),
}));

// A mock Feathers client with just enough surface for connect()'s synchronous
// prefix (hooks/io/service) plus a captured `authenticated` listener. Unknown
// property access resolves to a no-op fn so the rest of connect() can't throw.
function makeSeamClient() {
  const authHandlers: Array<() => void> = [];
  const create = vi.fn(async () => ({ session_id: '', subscribed: false }));

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
    connected: true, // wait-for-connection resolves immediately
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  });

  const client = permissive({
    io,
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'authenticated') authHandlers.push(handler);
    }),
    off: vi.fn(),
    hooks: vi.fn(),
    service: vi.fn((name: string) => (name === 'session-streams' ? { create } : permissive({}))),
    authenticate: vi.fn(async () => ({})),
  });

  return {
    client,
    create,
    fireAuth: () => {
      for (const handler of [...authHandlers]) handler();
    },
  };
}

describe('useAgorClient session-streams announce seam', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('announces session-streams capability once the socket authenticates', async () => {
    const { client, create, fireAuth } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    renderHook(() => useAgorClient({ url: 'http://daemon.test', accessToken: 'access-token' }));

    // No announce before authentication.
    expect(create).not.toHaveBeenCalled();

    // Feathers emits `authenticated` after authenticate() resolves.
    fireAuth();
    await Promise.resolve();

    expect(create).toHaveBeenCalledWith({ capability: true });
  });
});
