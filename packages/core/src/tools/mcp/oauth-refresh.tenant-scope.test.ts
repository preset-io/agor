/**
 * The standalone (SQLite) refresh path against the guard a daemon runs with.
 *
 * `refreshAndPersistToken` branches on dialect. The PostgreSQL branch opens a
 * tenant database scope around every repository operation; the standalone
 * branch used to build its repositories straight off `deps.db` and read through
 * them with no scope at all. Its one caller — `acquireMCPOAuthGrant` — closes
 * its own short units before calling, and `mcp-servers/oauth-auth-headers` is
 * an `identity-only` service, so nothing upstream arms one either. Against the
 * production guard the very first read therefore threw, and the route's
 * catch-all reported it as `needs_reauth`: a live grant with a good refresh
 * token, told to reconnect.
 *
 * Every test here uses a real migrated SQLite database behind
 * `requireScope: true`, which is what `setup/database.ts` gives the daemon in
 * every mode. A stubbed repository has no guard to trip, which is why this file
 * exists beside the mocked orchestration suite rather than inside it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the network is replaced. Repositories, migrations, the guarded handle
// and the scope machinery are all real — the guard is the point of this file.
const { tokenResponses } = vi.hoisted(() => ({ tokenResponses: { count: 0 } }));
vi.mock('../../utils/safe-outbound-fetch', () => ({
  OutboundPreDispatchAuthorityError: class extends Error {},
  safeOutboundFetch: async () => {
    tokenResponses.count += 1;
    return new Response(
      JSON.stringify({
        access_token: `fresh-access-token-${tokenResponses.count}`,
        refresh_token: `rotated-refresh-token-${tokenResponses.count}`,
        token_type: 'bearer',
        expires_in: 3600,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  },
}));

import {
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  MCPServerRepository,
  runMigrations,
  runWithTenantContext,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '../../db';
import type { MCPServerID, UserID } from '../../types';
import { __resetRefreshMutexForTests, refreshAndPersistToken } from './oauth-refresh';

const TENANT = 'default';

let raw: Awaited<ReturnType<typeof createDatabaseAsync>>;
let guarded: TenantScopeAwareDatabase;
let userId: UserID;
let serverId: MCPServerID;
beforeEach(async () => {
  __resetRefreshMutexForTests();
  tokenResponses.count = 0;
  raw = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(raw);
  guarded = createTenantScopedDatabaseProxy(raw, {
    requireScope: true,
    label: 'standalone refresh scope test',
  });

  // Seed through the RAW handle: this is fixture setup, not the code under test.
  const user = await new UsersRepository(raw).create({
    email: `standalone-refresh-${Math.random()}@example.test`,
    role: 'admin',
  });
  userId = user.user_id as UserID;
  const server = await new MCPServerRepository(raw).create({
    name: 'standalone-refresh-authority',
    transport: 'http',
    url: 'https://mcp.example.test/mcp',
    scope: 'global',
    owner_user_id: userId,
    auth: {
      type: 'oauth',
      oauth_mode: 'per_user',
      oauth_client_id: 'client-id',
      oauth_token_url: 'https://auth.example.test/token',
    },
  });
  serverId = server.mcp_server_id;
  await new UserMCPOAuthTokenRepository(raw).saveToken(userId, serverId, {
    accessToken: 'lapsed-access-token',
    expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    refreshToken: 'good-refresh-token',
    clientId: 'client-id',
    tokenEndpoint: 'https://auth.example.test/token',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  (raw as unknown as { $client?: { close(): void } }).$client?.close();
});

/** The exact shape `acquireMCPOAuthGrant` hands the refresh: tenant identity, no DB scope. */
function refreshAsDaemonCallerWould() {
  return runWithTenantContext(TENANT, () =>
    refreshAndPersistToken({
      db: guarded,
      tenantId: TENANT,
      userId,
      mcpServerId: serverId,
      observedRefreshVersion: {
        grantGeneration: 0,
        grantBindingFingerprint: undefined,
        refreshGeneration: 0,
      },
      validateGrant: async () => true,
      allowLocalhostHttpDevelopment: false,
    })
  );
}

describe('standalone MCP OAuth refresh against the production scope guard', () => {
  it('refreshes a lapsed grant when the caller holds tenant identity and no database scope', async () => {
    await expect(refreshAsDaemonCallerWould()).resolves.toBe('fresh-access-token-1');
    expect(tokenResponses.count).toBe(1);
  });

  it('persists the rotated pair and advances the refresh generation', async () => {
    await refreshAsDaemonCallerWould();

    const saved = await runWithTenantContext(TENANT, () =>
      new UserMCPOAuthTokenRepository(raw).getToken(userId, serverId)
    );
    expect(saved).toMatchObject({
      oauth_access_token: 'fresh-access-token-1',
      oauth_refresh_token: 'rotated-refresh-token-1',
      refresh_status: 'idle',
      refresh_generation: 1,
      refresh_success_generation: 1,
    });
    expect(saved?.oauth_token_expires_at?.getTime()).toBeGreaterThan(Date.now());
  });

  it('still works when the caller already holds a database scope', async () => {
    // The request path may already own one. Entering a scope that is open is a
    // no-op, so the same call has to succeed from either side.
    const { runWithTenantDatabaseScope } = await import('../../db');
    await expect(
      runWithTenantDatabaseScope(guarded, TENANT, () =>
        refreshAndPersistToken({
          db: guarded,
          tenantId: TENANT,
          userId,
          mcpServerId: serverId,
          observedRefreshVersion: {
            grantGeneration: 0,
            grantBindingFingerprint: undefined,
            refreshGeneration: 0,
          },
          validateGrant: async () => true,
        })
      )
    ).resolves.toBe('fresh-access-token-1');
  });

  it('leaves the provider alone and releases the claim when the grant is validated away', async () => {
    await expect(
      runWithTenantContext(TENANT, () =>
        refreshAndPersistToken({
          db: guarded,
          tenantId: TENANT,
          userId,
          mcpServerId: serverId,
          observedRefreshVersion: {
            grantGeneration: 0,
            grantBindingFingerprint: undefined,
            refreshGeneration: 0,
          },
          validateGrant: async () => false,
        })
      )
    ).rejects.toThrow(/grant or server configuration changed/i);
    expect(tokenResponses.count).toBe(0);

    const saved = await runWithTenantContext(TENANT, () =>
      new UserMCPOAuthTokenRepository(raw).getToken(userId, serverId)
    );
    expect(saved).toMatchObject({
      oauth_access_token: 'lapsed-access-token',
      refresh_status: 'idle',
      refresh_generation: 0,
    });
  });
});
