import type { AgorClient } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { announceSessionStreamsCapability } from './sessionStreamsCapability';

function makeAnnounceClient(create = vi.fn(async () => ({ session_id: '', subscribed: false }))) {
  const client = {
    service: vi.fn((name: string) => {
      if (name === 'session-streams') return { create };
      throw new Error(`Unexpected service: ${name}`);
    }),
  } as unknown as AgorClient;
  return { client, create };
}

describe('announceSessionStreamsCapability', () => {
  it('creates the session-streams capability marker', async () => {
    const { client, create } = makeAnnounceClient();
    announceSessionStreamsCapability(client);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({ capability: true });
  });

  it('swallows a create rejection (stale daemon / mid-connect auth refresh)', async () => {
    const create = vi.fn(async () => {
      throw new Error('NotAuthenticated');
    });
    const { client } = makeAnnounceClient(create);
    expect(() => announceSessionStreamsCapability(client)).not.toThrow();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });
});
