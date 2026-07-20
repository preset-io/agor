import type { AgorClient } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { ensureSessionStreamsCapabilityAnnounce } from './sessionStreamsCapability';

function makeAnnounceClient() {
  const ioHandlers: Record<string, Array<() => void>> = {};
  const appHandlers: Record<string, Array<() => void>> = {};
  const create = vi.fn(async () => ({ session_id: '', subscribed: false }));
  const client = {
    io: {
      connected: false,
      on: vi.fn((event: string, handler: () => void) => {
        const handlers = ioHandlers[event] ?? [];
        handlers.push(handler);
        ioHandlers[event] = handlers;
      }),
      off: vi.fn(),
    },
    on: vi.fn((event: string, handler: () => void) => {
      const handlers = appHandlers[event] ?? [];
      handlers.push(handler);
      appHandlers[event] = handlers;
    }),
    off: vi.fn(),
    service: vi.fn((name: string) => {
      if (name === 'session-streams') return { create };
      throw new Error(`Unexpected service: ${name}`);
    }),
  } as unknown as AgorClient;
  const fireIo = (event: string) => {
    for (const handler of [...(ioHandlers[event] ?? [])]) handler();
  };
  // Feathers emits 'authenticated' on the app after every authenticate().
  const fireAuth = () => {
    for (const handler of [...(appHandlers.authenticated ?? [])]) handler();
  };
  return { client, create, fireIo, fireAuth };
}

describe('ensureSessionStreamsCapabilityAnnounce', () => {
  it('announces capability after authentication and again on re-auth', async () => {
    const { client, create, fireAuth } = makeAnnounceClient();
    ensureSessionStreamsCapabilityAnnounce(client);

    // Not authenticated yet → no announce.
    expect(create).not.toHaveBeenCalled();

    fireAuth();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // Reconnect re-auth is a fresh authenticate() → re-announce.
    fireAuth();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    for (const call of create.mock.calls) {
      expect(call[0]).toEqual({ capability: true });
    }
  });

  it('does not announce on a pre-auth raw connect', () => {
    const { client, create, fireIo } = makeAnnounceClient();
    ensureSessionStreamsCapabilityAnnounce(client);

    // A raw socket connect precedes auth; announcing here would 401.
    fireIo('connect');
    expect(create).not.toHaveBeenCalled();
  });

  it('wires the authenticated listener at most once per client', () => {
    const { client } = makeAnnounceClient();
    ensureSessionStreamsCapabilityAnnounce(client);
    ensureSessionStreamsCapabilityAnnounce(client);

    const authRegistrations = (
      client.on as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((call) => call[0] === 'authenticated');
    expect(authRegistrations).toHaveLength(1);
  });

  it('swallows a create rejection (stale daemon / mid-connect auth refresh)', async () => {
    const { client, create, fireAuth } = makeAnnounceClient();
    create.mockRejectedValue(new Error('NotAuthenticated'));
    ensureSessionStreamsCapabilityAnnounce(client);

    expect(() => fireAuth()).not.toThrow();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });
});
