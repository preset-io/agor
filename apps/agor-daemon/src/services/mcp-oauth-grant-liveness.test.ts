/**
 * `resolveMCPOAuthGrantLiveness`, against real rows.
 *
 * This function is documented in its own module as "the only thing standing
 * between a POST and a widget resolving". Both suites that reach it —
 * `widgets/oauth/index.test.ts` and `mcp/tools/widgets.oauth.test.ts` — mock
 * the whole module away, so their strongest assertion
 * (`toHaveBeenCalledWith(..., 'srv-notion', 'user-actor')`) pins the argument
 * handed to a stub and says nothing about which row gets read or what the rule
 * decides. Everything that makes this a boundary was therefore uncovered:
 *
 *   - the shared→`null` / per_user→user lookup split, whose own doc comment
 *     warns that "getting this backwards silently reads the wrong grant"
 *   - the `refresh_status !== 'idle'` rule
 *   - the expiry comparison
 *   - the `isMCPOAuthGrantAuthorizedForServer` re-binding check
 *   - the server re-read (disabled / converted away from OAuth / gone)
 *
 * So this suite uses a real migrated database, real `mcp_servers` and
 * `user_mcp_oauth_tokens` rows, and the real binding fingerprint. The two bugs
 * this lane shipped and then fixed (D5, and the tenant-scope bug) were both
 * found by running the real stack rather than by a unit test; this is the
 * cheapest place to stop repeating that.
 */

import {
  createDatabaseAsync,
  MCPServerRepository,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import type { MCPServer, MCPServerID, User, UserID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  fingerprintMCPOAuthGrantConfiguration,
  MCP_OAUTH_GRANT_BINDING_VERSION,
} from './mcp-oauth-grant-binding.js';
import {
  mcpOAuthGrantLookupUserId,
  resolveMCPOAuthGrantLiveness,
} from './mcp-oauth-grant-liveness.js';

const HOUR = 60 * 60 * 1000;

/** The OAuth configuration a bound grant is issued against. */
const RESOLVED_BINDING = {
  resourceUri: 'https://mcp.example.test/mcp',
  metadataUrl: 'https://mcp.example.test/.well-known/oauth-authorization-server',
  issuer: 'https://auth.example.test',
  authorizationEndpoint: 'https://auth.example.test/authorize',
  tokenEndpoint: 'https://auth.example.test/token',
  redirectUri: 'https://agor.example.test/oauth/callback',
  clientId: 'client-abc',
  compatibilityMode: 'strict' as const,
};

async function harness() {
  const { runMigrations } = await import('@agor/core/db');
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  const db = rawDb as unknown as TenantScopeAwareDatabase;

  const users = new UsersRepository(rawDb);
  const owner = (await users.create({
    email: 'owner@agor.live',
    name: 'Owner',
    role: 'member',
  })) as User;
  const other = (await users.create({
    email: 'other@agor.live',
    name: 'Other',
    role: 'member',
  })) as User;

  const servers = new MCPServerRepository(db);
  const tokens = new UserMCPOAuthTokenRepository(db);

  const createServer = (overrides: Partial<Parameters<MCPServerRepository['create']>[0]> = {}) =>
    servers.create({
      name: 'example',
      display_name: 'Example',
      transport: 'http',
      url: 'https://mcp.example.test/mcp',
      scope: 'global',
      source: 'user',
      enabled: true,
      auth: { type: 'oauth', oauth_mode: 'per_user' },
      ...overrides,
    } as Parameters<MCPServerRepository['create']>[0]);

  /**
   * Save a grant the way the callback does: bound to the server's CURRENT
   * configuration, so the binding check is genuinely exercised rather than
   * grandfathered past.
   */
  const saveBoundGrant = async (
    server: MCPServer,
    userId: UserID | null,
    input: { expiresAt?: Date | null; refreshToken?: string } = {},
    grantedByUserId?: UserID
  ) => {
    const fingerprint = fingerprintMCPOAuthGrantConfiguration(
      process.env.AGOR_MASTER_SECRET!,
      server,
      RESOLVED_BINDING,
      MCP_OAUTH_GRANT_BINDING_VERSION
    );
    await tokens.saveToken(
      userId,
      server.mcp_server_id,
      {
        accessToken: 'at-1',
        expiresAt: input.expiresAt ?? null,
        refreshToken: input.refreshToken,
        clientId: RESOLVED_BINDING.clientId,
        grantBinding: {
          generation: 1,
          version: MCP_OAUTH_GRANT_BINDING_VERSION,
          fingerprint,
          metadataUri: RESOLVED_BINDING.metadataUrl,
          resourceUri: RESOLVED_BINDING.resourceUri,
          issuer: RESOLVED_BINDING.issuer,
          authorizationEndpoint: RESOLVED_BINDING.authorizationEndpoint,
          tokenEndpoint: RESOLVED_BINDING.tokenEndpoint,
          redirectUri: RESOLVED_BINDING.redirectUri,
        },
      },
      grantedByUserId ?? userId ?? owner.user_id
    );
  };

  const liveness = (serverId: MCPServerID, userId: UserID = owner.user_id) =>
    resolveMCPOAuthGrantLiveness(db, serverId, userId);

  return { db, rawDb, owner, other, servers, tokens, createServer, saveBoundGrant, liveness };
}

describe('resolveMCPOAuthGrantLiveness — the lookup-key split', () => {
  it('reads the caller’s own row for a per_user server', async () => {
    const h = await harness();
    const server = await h.createServer();
    await h.saveBoundGrant(server, h.owner.user_id);

    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({
      live: true,
      reason: 'live',
    });
    // Nobody else's. The credential belongs to the prompt actor.
    await expect(h.liveness(server.mcp_server_id, h.other.user_id)).resolves.toMatchObject({
      live: false,
      reason: 'no_grant',
    });
  });

  it('reads the user_id=NULL row for a shared server, not the caller’s', async () => {
    const h = await harness();
    const server = await h.createServer({ auth: { type: 'oauth', oauth_mode: 'shared' } });
    // A per-user row for the caller exists and must NOT satisfy a shared server.
    await h.saveBoundGrant(server, h.owner.user_id);

    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({
      live: false,
      reason: 'no_grant',
    });

    await h.saveBoundGrant(server, null, {}, h.owner.user_id);
    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({ live: true });
    // ...and it is live for EVERY member, which is what makes it admin-only.
    await expect(h.liveness(server.mcp_server_id, h.other.user_id)).resolves.toMatchObject({
      live: true,
    });
  });

  it('derives the same key the lookup uses', () => {
    const shared = { auth: { type: 'oauth', oauth_mode: 'shared' } } as Pick<MCPServer, 'auth'>;
    const perUser = { auth: { type: 'oauth', oauth_mode: 'per_user' } } as Pick<MCPServer, 'auth'>;
    const unset = { auth: { type: 'oauth' } } as Pick<MCPServer, 'auth'>;
    expect(mcpOAuthGrantLookupUserId(shared, 'u1' as UserID)).toBeNull();
    expect(mcpOAuthGrantLookupUserId(perUser, 'u1' as UserID)).toBe('u1');
    // An absent mode is per_user, never the shared row.
    expect(mcpOAuthGrantLookupUserId(unset, 'u1' as UserID)).toBe('u1');
  });
});

describe('resolveMCPOAuthGrantLiveness — the refresh_status rule', () => {
  it('refuses a grant whose refresh is in flight, and says why', async () => {
    const h = await harness();
    const server = await h.createServer();
    await h.saveBoundGrant(server, h.owner.user_id, {
      expiresAt: new Date(Date.now() + HOUR),
      refreshToken: 'rt-1',
    });
    const saved = await h.tokens.getToken(h.owner.user_id, server.mcp_server_id);

    const moved = await h.tokens.setStandaloneRefreshState(
      h.owner.user_id,
      server.mcp_server_id,
      {
        grantGeneration: saved!.grant_generation,
        refreshGeneration: saved!.refresh_generation,
        grantBindingFingerprint: saved!.grant_binding_fingerprint,
      },
      'idle',
      'refreshing'
    );
    expect(moved).toBe(true);

    // Unexpired and bound, but the outcome is not known yet: not spendable.
    // The reason is what lets the widget stop telling the user who just
    // finished signing in to go and finish signing in.
    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({
      live: false,
      reason: 'refreshing',
      refreshable: true,
    });
  });

  it('refuses an ambiguous grant and does not call it refreshable', async () => {
    const h = await harness();
    const server = await h.createServer();
    await h.saveBoundGrant(server, h.owner.user_id, {
      expiresAt: new Date(Date.now() + HOUR),
      refreshToken: 'rt-1',
    });
    const saved = await h.tokens.getToken(h.owner.user_id, server.mcp_server_id);
    await h.tokens.setStandaloneRefreshState(
      h.owner.user_id,
      server.mcp_server_id,
      {
        grantGeneration: saved!.grant_generation,
        refreshGeneration: saved!.refresh_generation,
        grantBindingFingerprint: saved!.grant_binding_fingerprint,
      },
      'idle',
      'ambiguous'
    );

    // Nobody knows whether that refresh token was already consumed, so even
    // the warning surface's optimism does not extend to it.
    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({
      live: false,
      reason: 'refreshing',
      refreshable: false,
    });
  });
});

describe('resolveMCPOAuthGrantLiveness — expiry', () => {
  it('counts an unexpired grant and reports its expiry', async () => {
    const h = await harness();
    const server = await h.createServer();
    const expiresAt = new Date(Date.now() + HOUR);
    await h.saveBoundGrant(server, h.owner.user_id, { expiresAt });

    const result = await h.liveness(server.mcp_server_id);
    expect(result.live).toBe(true);
    expect(result.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it('counts a grant with no expiry at all', async () => {
    const h = await harness();
    const server = await h.createServer();
    await h.saveBoundGrant(server, h.owner.user_id, { expiresAt: null });

    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({
      live: true,
      expiresAt: undefined,
    });
  });

  it('refuses an expired grant, but marks it refreshable when a refresh token is on file', async () => {
    const h = await harness();
    const server = await h.createServer();
    await h.saveBoundGrant(server, h.owner.user_id, {
      expiresAt: new Date(Date.now() - HOUR),
      refreshToken: 'rt-1',
    });

    // This is precisely the state the gateway's warning is allowed to treat as
    // fine and nothing else is: `live` false, `refreshable` true.
    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({
      live: false,
      reason: 'expired',
      refreshable: true,
    });
  });

  it('refuses an expired grant with nothing to refresh with', async () => {
    const h = await harness();
    const server = await h.createServer();
    await h.saveBoundGrant(server, h.owner.user_id, { expiresAt: new Date(Date.now() - HOUR) });

    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({
      live: false,
      reason: 'expired',
      refreshable: false,
    });
  });
});

describe('resolveMCPOAuthGrantLiveness — the re-binding check', () => {
  it('refuses a grant after the server’s OAuth configuration changes under it', async () => {
    const h = await harness();
    const server = await h.createServer();
    await h.saveBoundGrant(server, h.owner.user_id);
    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({ live: true });

    // The endpoint moves. The stored fingerprint was taken over the old one,
    // so the grant no longer authorizes this server — the property D3 rests
    // on, since the widget's destination is pinned but the row is not frozen.
    await h.servers.update(server.mcp_server_id, { url: 'https://evil.example.test/mcp' });

    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({
      live: false,
      reason: 'unbound',
      refreshable: false,
    });
  });

  it('refuses a per-user grant after the server flips to shared mode', async () => {
    const h = await harness();
    const server = await h.createServer();
    await h.saveBoundGrant(server, h.owner.user_id);

    await h.servers.update(server.mcp_server_id, {
      auth: { type: 'oauth', oauth_mode: 'shared' },
    });

    // The lookup now reads the shared key, which has no row at all — so this
    // cannot be answered by the caller's own per-user grant, in either the
    // lookup or the binding.
    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({
      live: false,
      reason: 'no_grant',
    });
  });
});

describe('resolveMCPOAuthGrantLiveness — the server re-read', () => {
  it('refuses when the pinned server no longer exists', async () => {
    const h = await harness();
    await expect(
      h.liveness('01900000-0000-7000-8000-00000000dead' as MCPServerID)
    ).resolves.toMatchObject({ live: false, reason: 'server_unusable' });
  });

  it('refuses a disabled server even with a grant on file', async () => {
    const h = await harness();
    const server = await h.createServer();
    await h.saveBoundGrant(server, h.owner.user_id);
    await h.servers.update(server.mcp_server_id, { enabled: false });

    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({
      live: false,
      reason: 'server_unusable',
    });
  });

  it('refuses a server that was converted away from OAuth', async () => {
    const h = await harness();
    const server = await h.createServer();
    await h.saveBoundGrant(server, h.owner.user_id);
    await h.servers.update(server.mcp_server_id, { auth: { type: 'bearer', token: 'k' } });

    await expect(h.liveness(server.mcp_server_id)).resolves.toMatchObject({
      live: false,
      reason: 'server_unusable',
    });
  });
});
