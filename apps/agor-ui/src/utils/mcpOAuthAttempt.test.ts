import { describe, expect, it, vi } from 'vitest';
import { agorStore } from '@/store/agorStore';
import {
  oauthAttemptFailureMessage,
  refetchMCPOAuthDurableState,
  waitForMCPOAuthAttempt,
} from './mcpOAuthAttempt';

describe('waitForMCPOAuthAttempt', () => {
  it('uses repeated durable gets rather than a realtime event as completion proof', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'exchanging' })
      .mockResolvedValueOnce({ status: 'succeeded', mcp_server_id: 'server-1' });
    const client = { service: vi.fn(() => ({ get })) } as never;

    await expect(waitForMCPOAuthAttempt(client, 'attempt-1', { pollMs: 0 })).resolves.toMatchObject(
      { status: 'succeeded', mcp_server_id: 'server-1' }
    );
    expect(get).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledWith('attempt-1');
  });

  it('surfaces ambiguity as a fresh-sign-in path without suggesting replay', () => {
    const message = oauthAttemptFailureMessage('ambiguous');
    expect(message).toMatch(/uncertain/i);
    expect(message).toMatch(/new sign-in/i);
    expect(message).toMatch(/will not be replayed/i);
  });

  it('replaces optimistic UI auth state with durable status and server reads', async () => {
    const services = {
      'mcp-servers/oauth-status': {
        find: vi.fn().mockResolvedValue({ authenticated_server_ids: ['server-1'] }),
      },
      'mcp-servers': {
        get: vi.fn().mockResolvedValue({
          mcp_server_id: 'server-1',
          name: 'durable',
          transport: 'http',
          auth: { type: 'oauth', oauth_access_token: 'hydrated' },
        }),
      },
    };
    const client = {
      service: vi.fn((path: keyof typeof services) => services[path]),
    } as never;

    await refetchMCPOAuthDurableState(client, 'server-1');

    expect(agorStore.getState().userAuthenticatedMcpServerIds).toEqual(new Set(['server-1']));
    expect(agorStore.getState().mcpServerById.get('server-1')).toMatchObject({
      name: 'durable',
      auth: { oauth_access_token: 'hydrated' },
    });
  });
});
