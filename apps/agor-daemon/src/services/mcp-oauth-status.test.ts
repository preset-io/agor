/**
 * What the OAuth status endpoint is willing to say a caller is authenticated
 * to — and, as much to the point, which servers it will not name to them.
 */

import type { UserMCPOAuthToken } from '@agor/core/db';
import type { MCPServer, MCPServerID, UserID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { type OAuthStatusDeps, resolveAuthenticatedServerIds } from './mcp-oauth-status.js';

const ALICE = '00000000-0000-7000-8000-00000000a11c' as UserID;
const BOB = '00000000-0000-7000-8000-00000000b0b0' as UserID;

const grantFor = (serverId: string, overrides: Partial<UserMCPOAuthToken> = {}) =>
  ({ mcp_server_id: serverId as MCPServerID, ...overrides }) as UserMCPOAuthToken;

const serverOwnedBy = (serverId: string, owner?: UserID) =>
  ({ mcp_server_id: serverId as MCPServerID, owner_user_id: owner }) as MCPServer;

function buildDeps(overrides: Partial<OAuthStatusDeps> = {}): OAuthStatusDeps {
  return {
    viewer: { user_id: BOB, role: 'member' },
    listForUser: async () => [],
    listShared: async () => [],
    findServers: async () => [],
    requireGrantBinding: false,
    isGrantBoundToServer: () => true,
    ...overrides,
  };
}

describe('resolveAuthenticatedServerIds', () => {
  it('batch reads distinct servers and retains private-server visibility checks', async () => {
    const findServers = vi.fn(async () => [
      serverOwnedBy('visible'),
      serverOwnedBy('private', ALICE),
    ]);
    const result = await resolveAuthenticatedServerIds(
      buildDeps({
        listForUser: async () => [grantFor('visible')],
        listShared: async () => [grantFor('visible'), grantFor('private')],
        findServers,
      })
    );
    expect(result).toEqual(['visible']);
    expect(findServers).toHaveBeenCalledExactlyOnceWith(['visible', 'private']);
  });

  it.each(['listForUser', 'listShared'] as const)(
    'propagates %s envelope failures without returning partial status',
    async (failedList) => {
      const error = new Error('Unsupported bound secret envelope');
      const findServers = vi.fn(async () => [serverOwnedBy('server-valid')]);
      const deps = buildDeps({
        listForUser: async () => [grantFor('server-valid')],
        listShared: async () => [grantFor('server-valid')],
        findServers,
        [failedList]: async () => {
          throw error;
        },
      });

      // The endpoint catches this and returns an empty authenticated set. A
      // projection must not silently turn a failed list into partial success.
      await expect(resolveAuthenticatedServerIds(deps)).rejects.toBe(error);
      expect(findServers).not.toHaveBeenCalled();
    }
  );

  it("does not name another user's private server through its shared grant", async () => {
    // A shared grant belongs to the server, so it is returned to everybody who
    // asks. The server behind it may still be private, and a private server is
    // invisible to non-owners on every other read path — this must not be the
    // one place its id is handed out.
    const deps = buildDeps({
      listShared: async () => [grantFor('server-alices-private')],
      findServers: async () => [serverOwnedBy('server-alices-private', ALICE)],
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual([]);
  });

  it('names a shared server to any member', async () => {
    const deps = buildDeps({
      listShared: async () => [grantFor('server-shared')],
      findServers: async () => [serverOwnedBy('server-shared')],
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual(['server-shared']);
  });

  it('names a private server to its own owner', async () => {
    const deps = buildDeps({
      viewer: { user_id: ALICE, role: 'member' },
      listForUser: async () => [grantFor('server-alices-private')],
      findServers: async () => [serverOwnedBy('server-alices-private', ALICE)],
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual(['server-alices-private']);
  });

  it('keeps an admin’s view of the tenant whole', async () => {
    // Admins are not narrowed anywhere else they read servers, so narrowing
    // here would leave the badge missing on a row their own list still shows.
    const deps = buildDeps({
      viewer: { user_id: BOB, role: 'admin' },
      listShared: async () => [grantFor('server-alices-private')],
      findServers: async () => [serverOwnedBy('server-alices-private', ALICE)],
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual(['server-alices-private']);
  });

  it.each(['ambiguous', 'refreshing'] as const)(
    'never advertises a %s grant as authenticated',
    async (refresh_status) => {
      const deps = buildDeps({
        listShared: async () => [grantFor('server-shared', { refresh_status })],
        findServers: async () => [serverOwnedBy('server-shared')],
      });

      await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual([]);
    }
  );

  it('never advertises an expired grant', async () => {
    const deps = buildDeps({
      now: new Date('2026-01-02T00:00:00.000Z'),
      listShared: async () => [
        grantFor('server-shared', { oauth_token_expires_at: new Date('2026-01-01T00:00:00.000Z') }),
      ],
      findServers: async () => [serverOwnedBy('server-shared')],
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual([]);
  });

  it('revalidates a grant against its server before advertising it', async () => {
    const isGrantBoundToServer = vi.fn(() => false);
    const deps = buildDeps({
      requireGrantBinding: true,
      isGrantBoundToServer,
      listShared: async () => [grantFor('server-shared')],
      findServers: async () => [serverOwnedBy('server-shared')],
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual([]);
    expect(isGrantBoundToServer).toHaveBeenCalled();
  });

  it('says nothing about a grant whose server is gone', async () => {
    const deps = buildDeps({
      listShared: async () => [grantFor('server-deleted')],
      findServers: async () => [],
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual([]);
  });
});
