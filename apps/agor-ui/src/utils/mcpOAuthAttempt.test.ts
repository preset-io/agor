import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '@/store/agorStore';
import {
  oauthAttemptFailureMessage,
  refetchMCPOAuthDurableState,
  refreshAndRefetchMCPOAuthGrant,
  runLatestMCPOAuthStatusRequest,
  waitForMCPOAuthAttempt,
} from './mcpOAuthAttempt';

beforeEach(() => {
  agorStore.getState().reset();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runLatestMCPOAuthStatusRequest', () => {
  it('discards an older response that completes after a newer request', async () => {
    const generation = { current: 0 };
    const older = deferred<string[]>();
    let applied: string[] = [];
    const apply = (ids: string[]) => {
      applied = ids;
    };

    const olderRequest = runLatestMCPOAuthStatusRequest(
      generation,
      () => older.promise,
      () => true,
      apply
    );
    await expect(
      runLatestMCPOAuthStatusRequest(
        generation,
        async () => [],
        () => true,
        apply
      )
    ).resolves.toBe(true);
    older.resolve(['stale-server']);

    await expect(olderRequest).resolves.toBe(false);
    expect(applied).toEqual([]);
  });
});

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

    await refetchMCPOAuthDurableState(client, 'server-1', () => true);

    expect(agorStore.getState().userAuthenticatedMcpServerIds).toEqual(new Set(['server-1']));
    expect(agorStore.getState().mcpServerById.get('server-1')).toMatchObject({
      name: 'durable',
      auth: { oauth_access_token: 'hydrated' },
    });
  });

  it('refetches deleted durable grant state before returning needs_reauth', async () => {
    const create = vi.fn().mockResolvedValue({ success: false, error: 'needs_reauth' });
    const find = vi.fn().mockResolvedValue({ authenticated_server_ids: [] });
    const get = vi.fn().mockResolvedValue({
      mcp_server_id: 'server-1',
      name: 'disconnected',
      transport: 'http',
      auth: { type: 'oauth' },
    });
    const services = {
      'mcp-servers/oauth-refresh': { create },
      'mcp-servers/oauth-status': { find },
      'mcp-servers': { get },
    };
    const client = {
      service: vi.fn((path: keyof typeof services) => services[path]),
    } as never;

    await expect(refreshAndRefetchMCPOAuthGrant(client, 'server-1', () => true)).resolves.toEqual({
      success: false,
      error: 'needs_reauth',
    });
    expect(create).toHaveBeenCalledWith({ mcp_server_id: 'server-1' });
    expect(find).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('server-1');
    expect(agorStore.getState().userAuthenticatedMcpServerIds).toEqual(new Set());
    expect(agorStore.getState().mcpServerById.get('server-1')).toMatchObject({
      auth: { type: 'oauth' },
    });
  });

  it('still refetches durable state when the refresh request outcome is unknown', async () => {
    const createError = new Error('connection closed');
    const create = vi.fn().mockRejectedValue(createError);
    const find = vi.fn().mockResolvedValue({ authenticated_server_ids: [] });
    const get = vi.fn().mockResolvedValue({
      mcp_server_id: 'server-1',
      name: 'durable-after-error',
      transport: 'http',
      auth: { type: 'oauth' },
    });
    const services = {
      'mcp-servers/oauth-refresh': { create },
      'mcp-servers/oauth-status': { find },
      'mcp-servers': { get },
    };
    const client = {
      service: vi.fn((path: keyof typeof services) => services[path]),
    } as never;

    await expect(refreshAndRefetchMCPOAuthGrant(client, 'server-1', () => true)).rejects.toBe(
      createError
    );
    expect(find).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each(['status-first', 'server-first'] as const)(
    'does not apply caller-private durable rows when authority is lost after the %s read',
    async (firstRead) => {
      agorStore.getState().applyMaps((prev) => ({
        ...prev,
        userAuthenticatedMcpServerIds: new Set(['current-server']),
        mcpServerById: new Map(prev.mcpServerById).set('current-server', {
          mcp_server_id: 'current-server',
          name: 'current',
          transport: 'http',
        } as never),
      }));
      const status = deferred<{ authenticated_server_ids: string[] }>();
      const server = deferred<{
        mcp_server_id: string;
        name: string;
        transport: string;
        auth: { type: string; oauth_access_token: string };
      }>();
      const services = {
        'mcp-servers/oauth-status': { find: vi.fn(() => status.promise) },
        'mcp-servers': { get: vi.fn(() => server.promise) },
      };
      const client = {
        service: vi.fn((path: keyof typeof services) => services[path]),
      } as never;
      let currentAuthority = true;

      const refetch = refetchMCPOAuthDurableState(
        client,
        'previous-private-server',
        () => currentAuthority
      );
      if (firstRead === 'status-first') {
        status.resolve({ authenticated_server_ids: ['previous-private-server'] });
        await status.promise;
        currentAuthority = false;
        server.resolve({
          mcp_server_id: 'previous-private-server',
          name: 'private-to-previous-user',
          transport: 'http',
          auth: { type: 'oauth', oauth_access_token: 'redacted-shape' },
        });
      } else {
        server.resolve({
          mcp_server_id: 'previous-private-server',
          name: 'private-to-previous-user',
          transport: 'http',
          auth: { type: 'oauth', oauth_access_token: 'redacted-shape' },
        });
        await server.promise;
        currentAuthority = false;
        status.resolve({ authenticated_server_ids: ['previous-private-server'] });
      }
      await refetch;

      expect(agorStore.getState().userAuthenticatedMcpServerIds).toEqual(
        new Set(['current-server'])
      );
      expect(agorStore.getState().mcpServerById.has('previous-private-server')).toBe(false);
      expect(agorStore.getState().mcpServerById.get('current-server')).toMatchObject({
        name: 'current',
      });
    }
  );

  it('threads authority loss through refresh into the durable refetch application', async () => {
    const status = deferred<{ authenticated_server_ids: string[] }>();
    const get = vi.fn().mockResolvedValue({
      mcp_server_id: 'server-1',
      name: 'previous-private-server',
      transport: 'http',
      auth: { type: 'oauth' },
    });
    const services = {
      'mcp-servers/oauth-refresh': {
        create: vi.fn().mockResolvedValue({ success: true, expires_at: 123 }),
      },
      'mcp-servers/oauth-status': { find: vi.fn(() => status.promise) },
      'mcp-servers': { get },
    };
    const client = {
      service: vi.fn((path: keyof typeof services) => services[path]),
    } as never;
    let currentAuthority = true;

    const refresh = refreshAndRefetchMCPOAuthGrant(client, 'server-1', () => currentAuthority);
    await vi.waitFor(() =>
      expect(services['mcp-servers/oauth-status'].find).toHaveBeenCalledOnce()
    );
    currentAuthority = false;
    status.resolve({ authenticated_server_ids: ['server-1'] });

    await expect(refresh).resolves.toEqual({ success: true, expires_at: 123 });
    expect(agorStore.getState().userAuthenticatedMcpServerIds).toEqual(new Set());
    expect(agorStore.getState().mcpServerById.has('server-1')).toBe(false);
  });
});
