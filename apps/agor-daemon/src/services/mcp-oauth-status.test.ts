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
    findServer: async () => null,
    requireGrantBinding: false,
    isGrantBoundToServer: () => true,
    ...overrides,
  };
}

describe('resolveAuthenticatedServerIds', () => {
  it("does not name another user's private server through its shared grant", async () => {
    // A shared grant belongs to the server, so it is returned to everybody who
    // asks. The server behind it may still be private, and a private server is
    // invisible to non-owners on every other read path — this must not be the
    // one place its id is handed out.
    const deps = buildDeps({
      listShared: async () => [grantFor('server-alices-private')],
      findServer: async () => serverOwnedBy('server-alices-private', ALICE),
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual([]);
  });

  it('names a shared server to any member', async () => {
    const deps = buildDeps({
      listShared: async () => [grantFor('server-shared')],
      findServer: async () => serverOwnedBy('server-shared'),
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual(['server-shared']);
  });

  it('names a private server to its own owner', async () => {
    const deps = buildDeps({
      viewer: { user_id: ALICE, role: 'member' },
      listForUser: async () => [grantFor('server-alices-private')],
      findServer: async () => serverOwnedBy('server-alices-private', ALICE),
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual(['server-alices-private']);
  });

  it('keeps an admin’s view of the tenant whole', async () => {
    // Admins are not narrowed anywhere else they read servers, so narrowing
    // here would leave the badge missing on a row their own list still shows.
    const deps = buildDeps({
      viewer: { user_id: BOB, role: 'admin' },
      listShared: async () => [grantFor('server-alices-private')],
      findServer: async () => serverOwnedBy('server-alices-private', ALICE),
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual(['server-alices-private']);
  });

  it('never advertises a refresh-ambiguous grant as authenticated', async () => {
    const deps = buildDeps({
      listShared: async () => [grantFor('server-shared', { refresh_status: 'ambiguous' })],
      findServer: async () => serverOwnedBy('server-shared'),
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual([]);
  });

  it('never advertises an expired grant', async () => {
    const deps = buildDeps({
      now: new Date('2026-01-02T00:00:00.000Z'),
      listShared: async () => [
        grantFor('server-shared', { oauth_token_expires_at: new Date('2026-01-01T00:00:00.000Z') }),
      ],
      findServer: async () => serverOwnedBy('server-shared'),
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual([]);
  });

  it('keeps an expired access token authenticated while its refresh grant is durable', async () => {
    const deps = buildDeps({
      now: new Date('2026-01-02T00:00:00.000Z'),
      listShared: async () => [
        grantFor('server-shared', {
          oauth_token_expires_at: new Date('2026-01-01T00:00:00.000Z'),
          oauth_refresh_token: 'stored-refresh-token',
          refresh_status: 'idle',
        }),
      ],
      findServer: async () => serverOwnedBy('server-shared'),
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual(['server-shared']);
  });

  it('keeps a concurrently refreshing grant authenticated', async () => {
    const deps = buildDeps({
      now: new Date('2026-01-02T00:00:00.000Z'),
      listShared: async () => [
        grantFor('server-shared', {
          oauth_token_expires_at: new Date('2026-01-01T00:00:00.000Z'),
          oauth_refresh_token: 'stored-refresh-token',
          refresh_status: 'refreshing',
        }),
      ],
      findServer: async () => serverOwnedBy('server-shared'),
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual(['server-shared']);
  });

  it('revalidates a grant against its server before advertising it', async () => {
    const isGrantBoundToServer = vi.fn(() => false);
    const deps = buildDeps({
      requireGrantBinding: true,
      isGrantBoundToServer,
      listShared: async () => [grantFor('server-shared')],
      findServer: async () => serverOwnedBy('server-shared'),
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual([]);
    expect(isGrantBoundToServer).toHaveBeenCalled();
  });

  it('says nothing about a grant whose server is gone', async () => {
    const deps = buildDeps({
      listShared: async () => [grantFor('server-deleted')],
      findServer: async () => null,
    });

    await expect(resolveAuthenticatedServerIds(deps)).resolves.toEqual([]);
  });
});
