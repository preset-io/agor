/**
 * Active-active refresh proofs. Run against a PostgreSQL role that is
 * NOSUPERUSER and NOBYPASSRLS; two independent pools model two daemons.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  initializeDatabase,
  MCPOAuthPendingFlowRepository,
  MCPServerRepository,
  type RawDatabase,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
  userMcpOauthTokens,
} from '../../db';
import type { MCPServerID, UserID } from '../../types';
import {
  AmbiguousRefreshError,
  FailedRefreshError,
  GrantConfigurationChangedError,
  OAuthRefreshAuthorityCancelledError,
  OAuthRefreshExchangeError,
  refreshAndPersistToken,
} from './oauth-refresh';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const masterSecret = 'mcp-oauth-refresh-postgres-test-master-secret';

interface Seed {
  tenantId: string;
  userId: UserID;
  serverId: MCPServerID;
  generation: number;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'MCP OAuth refresh authority (PostgreSQL)',
  () => {
    let rawA: RawDatabase;
    let rawB: RawDatabase;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;
    const originalMasterSecret = process.env.AGOR_MASTER_SECRET;
    const servers: http.Server[] = [];

    beforeAll(async () => {
      process.env.AGOR_MASTER_SECRET = masterSecret;
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'OAuth refresh daemon A',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'OAuth refresh daemon B',
      });
    });

    afterAll(async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            })
        )
      );
      await Promise.all([
        (rawA as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end(),
        (rawB as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
      if (originalMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = originalMasterSecret;
    });

    async function provider(
      handler: (body: URLSearchParams, response: http.ServerResponse) => void | Promise<void>
    ): Promise<{ url: string; calls: () => number }> {
      let callCount = 0;
      const server = http.createServer(async (request, response) => {
        callCount += 1;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        await handler(new URLSearchParams(Buffer.concat(chunks).toString('utf8')), response);
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      return {
        url: `http://127.0.0.1:${address.port}/token`,
        calls: () => callCount,
      };
    }

    async function nextGeneration(db: TenantScopeAwareDatabase, seed: Seed) {
      return runWithTenantDatabaseScope(db, seed.tenantId, (scoped) => {
        const repository = new MCPOAuthPendingFlowRepository(scoped);
        return repository.allocateGrantGeneration({
          tenantId: seed.tenantId,
          mcpServerId: seed.serverId,
          oauthMode: 'per_user',
          subjectUserId: seed.userId,
        });
      });
    }

    async function seed(label: string, tokenEndpoint: string): Promise<Seed> {
      const tenantId = `oauth-refresh-${label}-${crypto.randomUUID()}`;
      return runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: `Refresh ${label}`,
        });
        const server = await new MCPServerRepository(scoped).create({
          name: `refresh-${label}-${crypto.randomUUID()}`,
          display_name: `Refresh ${label}`,
          transport: 'http',
          url: `https://mcp.example.test/${label}`,
          scope: 'global',
          enabled: true,
          source: 'user',
          owner_user_id: user.user_id,
          auth: {
            type: 'oauth',
            oauth_mode: 'per_user',
            oauth_client_id: 'configured-client',
            oauth_token_url: tokenEndpoint,
          },
        });
        const generation = await new MCPOAuthPendingFlowRepository(scoped).allocateGrantGeneration({
          tenantId,
          mcpServerId: server.mcp_server_id as MCPServerID,
          oauthMode: 'per_user',
          subjectUserId: user.user_id as UserID,
        });
        await new UserMCPOAuthTokenRepository(scoped, masterSecret).saveToken(
          user.user_id as UserID,
          server.mcp_server_id as MCPServerID,
          {
            accessToken: `expired-access-${label}`,
            refreshToken: `refresh-${label}-0`,
            clientId: 'configured-client',
            expiresAt: new Date(Date.now() - 60_000),
            grantBinding: {
              generation,
              version: 1,
              fingerprint: 'a'.repeat(64),
              metadataUri: `https://mcp.example.test/${label}/.well-known/oauth-protected-resource`,
              resourceUri: `https://mcp.example.test/${label}`,
              issuer: 'https://provider.example.test',
              authorizationEndpoint: 'https://provider.example.test/authorize',
              tokenEndpoint,
              redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
            },
          }
        );
        return {
          tenantId,
          userId: user.user_id as UserID,
          serverId: server.mcp_server_id as MCPServerID,
          generation,
        };
      });
    }

    async function replaceGrant(
      db: TenantScopeAwareDatabase,
      seed: Seed,
      tokenEndpoint: string,
      accessToken: string,
      refreshToken: string
    ): Promise<number> {
      const generation = await nextGeneration(db, seed);
      await runWithTenantDatabaseScope(db, seed.tenantId, (scoped) =>
        new UserMCPOAuthTokenRepository(scoped, masterSecret).saveToken(
          seed.userId,
          seed.serverId,
          {
            accessToken,
            refreshToken,
            clientId: 'configured-client',
            expiresAt: new Date(Date.now() + 3_600_000),
            grantBinding: {
              generation,
              version: 1,
              fingerprint: 'b'.repeat(64),
              metadataUri: 'https://mcp.example.test/.well-known/oauth-protected-resource',
              resourceUri: 'https://mcp.example.test/resource',
              issuer: 'https://provider.example.test',
              authorizationEndpoint: 'https://provider.example.test/authorize',
              tokenEndpoint,
              redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
            },
          }
        )
      );
      return generation;
    }

    function initialRefreshVersion(seed: Seed) {
      return {
        grantGeneration: seed.generation,
        grantBindingFingerprint: 'a'.repeat(64),
        refreshGeneration: 0,
      };
    }

    it('allows one daemon to rotate while a peer observes the committed result', async () => {
      const tokenProvider = await provider(async (body, response) => {
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe('refresh-concurrent-0');
        expect(body.get('resource')).toBe('https://mcp.example.test/concurrent');
        await new Promise((resolve) => setTimeout(resolve, 150));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: 'rotated-access-1',
            refresh_token: 'rotated-refresh-1',
            expires_in: 3600,
          })
        );
      });
      const bound = await seed('concurrent', tokenProvider.url);

      const [fromA, fromB] = await Promise.all([
        refreshAndPersistToken({
          db: dbA,
          tenantId: bound.tenantId,
          userId: bound.userId,
          mcpServerId: bound.serverId,
          validateGrant: async () => true,
          observedRefreshVersion: initialRefreshVersion(bound),
          allowLocalhostHttpDevelopment: true,
        }),
        refreshAndPersistToken({
          db: dbB,
          tenantId: bound.tenantId,
          userId: bound.userId,
          mcpServerId: bound.serverId,
          validateGrant: async () => true,
          observedRefreshVersion: initialRefreshVersion(bound),
          allowLocalhostHttpDevelopment: true,
        }),
      ]);

      expect([fromA, fromB]).toEqual(['rotated-access-1', 'rotated-access-1']);
      expect(tokenProvider.calls()).toBe(1);
      const committed = await runWithTenantDatabaseScope(dbB, bound.tenantId, (scoped) =>
        new UserMCPOAuthTokenRepository(scoped, masterSecret).getToken(bound.userId, bound.serverId)
      );
      expect(committed).toMatchObject({
        oauth_access_token: 'rotated-access-1',
        oauth_refresh_token: 'rotated-refresh-1',
        refresh_status: 'idle',
        refresh_generation: 1,
        refresh_success_generation: 1,
      });

      const rawStored = await runWithTenantDatabaseScope(dbA, bound.tenantId, async (scoped) => {
        const result = await executeRaw(
          scoped,
          sql`SELECT oauth_access_token, oauth_refresh_token, oauth_client_id
              FROM ${userMcpOauthTokens}
              WHERE mcp_server_id = ${bound.serverId}`
        );
        return rowsOf(result)[0];
      });
      expect(JSON.stringify(rawStored)).not.toContain('rotated-access-1');
      expect(JSON.stringify(rawStored)).not.toContain('rotated-refresh-1');
      expect(
        Object.values(rawStored ?? {}).every((value) =>
          String(value).startsWith('agor-mcp-oauth:v1:')
        )
      ).toBe(true);
    });

    it('refuses completion when authoritative server configuration changes during exchange', async () => {
      let configurationStillValid = true;
      const tokenProvider = await provider((_body, response) => {
        // The refresh owner already validated the saved row before sending
        // the request. Model a Settings mutation landing while the provider
        // owns the rotating refresh token.
        configurationStillValid = false;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: 'must-not-commit-after-settings-change',
            refresh_token: 'must-not-rotate-after-settings-change',
            expires_in: 3600,
          })
        );
      });
      const bound = await seed('settings-mutation', tokenProvider.url);
      const validateGrant = vi.fn(async () => configurationStillValid);

      await expect(
        refreshAndPersistToken({
          db: dbA,
          tenantId: bound.tenantId,
          userId: bound.userId,
          mcpServerId: bound.serverId,
          validateGrant,
          observedRefreshVersion: initialRefreshVersion(bound),
          allowLocalhostHttpDevelopment: true,
        })
      ).rejects.toBeInstanceOf(GrantConfigurationChangedError);

      expect(validateGrant).toHaveBeenCalledTimes(2);
      const current = await runWithTenantDatabaseScope(dbB, bound.tenantId, (scoped) =>
        new UserMCPOAuthTokenRepository(scoped, masterSecret).getToken(bound.userId, bound.serverId)
      );
      expect(current).toMatchObject({
        oauth_access_token: 'expired-access-settings-mutation',
        oauth_refresh_token: 'refresh-settings-mutation-0',
        refresh_status: 'ambiguous',
        refresh_generation: 1,
        refresh_success_generation: 0,
      });
    });

    it('makes a delayed stale caller observe the committed rotation instead of refreshing twice', async () => {
      const tokenProvider = await provider((_body, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: 'delayed-rotation-access',
            refresh_token: 'delayed-rotation-refresh',
            expires_in: 3600,
          })
        );
      });
      const bound = await seed('delayed-claim', tokenProvider.url);
      const staleVersion = initialRefreshVersion(bound);

      await expect(
        refreshAndPersistToken({
          db: dbA,
          tenantId: bound.tenantId,
          userId: bound.userId,
          mcpServerId: bound.serverId,
          validateGrant: async () => true,
          observedRefreshVersion: staleVersion,
          allowLocalhostHttpDevelopment: true,
        })
      ).resolves.toBe('delayed-rotation-access');

      // Daemon B made its decision from the old row but did not reach the CAS
      // until after daemon A committed. It must not consume the rotated token.
      await expect(
        refreshAndPersistToken({
          db: dbB,
          tenantId: bound.tenantId,
          userId: bound.userId,
          mcpServerId: bound.serverId,
          validateGrant: async () => true,
          observedRefreshVersion: staleVersion,
          allowLocalhostHttpDevelopment: true,
        })
      ).resolves.toBe('delayed-rotation-access');
      expect(tokenProvider.calls()).toBe(1);
    });

    it('does not let an observer mistake a rejected owner exchange for success', async () => {
      let requestArrived!: () => void;
      const arrived = new Promise<void>((resolve) => {
        requestArrived = resolve;
      });
      let releaseResponse!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const tokenProvider = await provider(async (_body, response) => {
        requestArrived();
        await release;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'temporarily_unavailable' }));
      });
      const bound = await seed('rejected-observer', tokenProvider.url);
      const observed = initialRefreshVersion(bound);
      const owner = refreshAndPersistToken({
        db: dbA,
        tenantId: bound.tenantId,
        userId: bound.userId,
        mcpServerId: bound.serverId,
        validateGrant: async () => true,
        observedRefreshVersion: observed,
        allowLocalhostHttpDevelopment: true,
      });
      await arrived;
      const observer = refreshAndPersistToken({
        db: dbB,
        tenantId: bound.tenantId,
        userId: bound.userId,
        mcpServerId: bound.serverId,
        validateGrant: async () => true,
        observedRefreshVersion: observed,
        allowLocalhostHttpDevelopment: true,
      });
      releaseResponse();

      const [ownerResult, observerResult] = await Promise.allSettled([owner, observer]);
      expect(ownerResult.status).toBe('rejected');
      expect((ownerResult as PromiseRejectedResult).reason).toBeInstanceOf(
        OAuthRefreshExchangeError
      );
      expect(observerResult.status).toBe('rejected');
      expect((observerResult as PromiseRejectedResult).reason).toBeInstanceOf(FailedRefreshError);
      expect(tokenProvider.calls()).toBe(1);

      const current = await runWithTenantDatabaseScope(dbA, bound.tenantId, (scoped) =>
        new UserMCPOAuthTokenRepository(scoped, masterSecret).getToken(bound.userId, bound.serverId)
      );
      expect(current).toMatchObject({
        refresh_status: 'idle',
        refresh_generation: 1,
        refresh_success_generation: 0,
      });
    });

    it('releases an authority-cancelled pre-dispatch claim without quarantining the grant', async () => {
      const tokenProvider = await provider((_body, response) => {
        response.writeHead(500);
        response.end();
      });
      const bound = await seed(
        'authority-cancel',
        tokenProvider.url.replace('127.0.0.1', 'localhost')
      );
      let dnsStarted!: () => void;
      let releaseDns!: () => void;
      const dnsObserved = new Promise<void>((resolve) => (dnsStarted = resolve));
      const dnsGate = new Promise<void>((resolve) => (releaseDns = resolve));
      let current = true;
      const refresh = refreshAndPersistToken({
        db: dbA,
        tenantId: bound.tenantId,
        userId: bound.userId,
        mcpServerId: bound.serverId,
        validateGrant: async () => true,
        observedRefreshVersion: initialRefreshVersion(bound),
        allowLocalhostHttpDevelopment: true,
        resolveDns: async () => {
          dnsStarted();
          await dnsGate;
          return [{ address: '127.0.0.1', family: 4 }];
        },
        assertCurrent: () => {
          if (!current) throw new Error('gateway task authority changed');
        },
      });
      await dnsObserved;
      current = false;
      releaseDns();

      const error = await refresh.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(OAuthRefreshAuthorityCancelledError);
      expect(error).toMatchObject({
        code: 'oauth_refresh_authority_cancelled',
        authorityCause: { message: 'gateway task authority changed' },
      });
      expect(tokenProvider.calls()).toBe(0);
      const retained = await runWithTenantDatabaseScope(dbA, bound.tenantId, (scoped) =>
        new UserMCPOAuthTokenRepository(scoped, masterSecret).getToken(bound.userId, bound.serverId)
      );
      expect(retained).toMatchObject({
        oauth_access_token: 'expired-access-authority-cancel',
        oauth_refresh_token: 'refresh-authority-cancel-0',
        refresh_status: 'idle',
        refresh_generation: 1,
        refresh_success_generation: 0,
      });
      expect(retained?.refresh_claim_id).toBeUndefined();
      expect(retained?.refresh_claimed_at).toBeUndefined();
    });

    it('marks a stale refresh owner ambiguous and never replays its rotating token', async () => {
      const tokenProvider = await provider((_body, response) => {
        response.writeHead(500);
        response.end();
      });
      const bound = await seed('owner-crash', tokenProvider.url);
      const claimed = await runWithTenantDatabaseScope(dbA, bound.tenantId, (scoped) =>
        new UserMCPOAuthTokenRepository(scoped, masterSecret).claimRefresh(
          bound.userId,
          bound.serverId,
          initialRefreshVersion(bound)
        )
      );
      expect(claimed.outcome).toBe('claimed');
      await runWithTenantDatabaseScope(dbA, bound.tenantId, async (scoped) => {
        await executeRaw(
          scoped,
          sql`UPDATE ${userMcpOauthTokens}
              SET refresh_claimed_at = CURRENT_TIMESTAMP - INTERVAL '3 minutes'
              WHERE mcp_server_id = ${bound.serverId}`
        );
      });

      await expect(
        refreshAndPersistToken({
          db: dbB,
          tenantId: bound.tenantId,
          userId: bound.userId,
          mcpServerId: bound.serverId,
          validateGrant: async () => true,
          observedRefreshVersion: initialRefreshVersion(bound),
          allowLocalhostHttpDevelopment: true,
        })
      ).rejects.toBeInstanceOf(AmbiguousRefreshError);
      expect(tokenProvider.calls()).toBe(0);
    });

    it('does not let a losing invalid_grant delete a newer replacement generation', async () => {
      let requestArrived!: () => void;
      const arrived = new Promise<void>((resolve) => {
        requestArrived = resolve;
      });
      let releaseResponse!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const tokenProvider = await provider(async (_body, response) => {
        requestArrived();
        await release;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_grant' }));
      });
      const bound = await seed('losing-invalid-grant', tokenProvider.url);
      const invalidGrantNotice = vi.fn();
      const oldRefresh = refreshAndPersistToken({
        db: dbA,
        tenantId: bound.tenantId,
        userId: bound.userId,
        mcpServerId: bound.serverId,
        validateGrant: async () => true,
        observedRefreshVersion: initialRefreshVersion(bound),
        onInvalidGrant: invalidGrantNotice,
        allowLocalhostHttpDevelopment: true,
      });
      await arrived;
      const newerGeneration = await replaceGrant(
        dbB,
        bound,
        tokenProvider.url,
        'new-account-access',
        'new-account-refresh'
      );
      releaseResponse();

      await expect(oldRefresh).rejects.toBeInstanceOf(GrantConfigurationChangedError);
      expect(invalidGrantNotice).not.toHaveBeenCalled();
      const current = await runWithTenantDatabaseScope(dbA, bound.tenantId, (scoped) =>
        new UserMCPOAuthTokenRepository(scoped, masterSecret).getToken(bound.userId, bound.serverId)
      );
      expect(current).toMatchObject({
        grant_generation: newerGeneration,
        oauth_access_token: 'new-account-access',
        oauth_refresh_token: 'new-account-refresh',
        refresh_status: 'idle',
      });
    });

    it('does not return or overwrite a newer authorization after an old refresh succeeds', async () => {
      let requestArrived!: () => void;
      const arrived = new Promise<void>((resolve) => {
        requestArrived = resolve;
      });
      let releaseResponse!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const tokenProvider = await provider(async (_body, response) => {
        requestArrived();
        await release;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: 'stale-refresh-access',
            refresh_token: 'stale-refresh-rotation',
            expires_in: 3600,
          })
        );
      });
      const bound = await seed('losing-successful-refresh', tokenProvider.url);
      const oldRefresh = refreshAndPersistToken({
        db: dbA,
        tenantId: bound.tenantId,
        userId: bound.userId,
        mcpServerId: bound.serverId,
        validateGrant: async () => true,
        observedRefreshVersion: initialRefreshVersion(bound),
        allowLocalhostHttpDevelopment: true,
      });
      await arrived;
      const newerGeneration = await replaceGrant(
        dbB,
        bound,
        tokenProvider.url,
        'new-authorization-access',
        'new-authorization-refresh'
      );
      releaseResponse();

      await expect(oldRefresh).rejects.toBeInstanceOf(GrantConfigurationChangedError);
      const current = await runWithTenantDatabaseScope(dbA, bound.tenantId, (scoped) =>
        new UserMCPOAuthTokenRepository(scoped, masterSecret).getToken(bound.userId, bound.serverId)
      );
      expect(current).toMatchObject({
        grant_generation: newerGeneration,
        oauth_access_token: 'new-authorization-access',
        oauth_refresh_token: 'new-authorization-refresh',
      });
    });

    it('does not expose another tenant grant through an independent pool', async () => {
      const tokenProvider = await provider((_body, response) => {
        response.writeHead(500);
        response.end();
      });
      const owner = await seed('tenant-owner', tokenProvider.url);
      const attackerTenant = `oauth-refresh-attacker-${crypto.randomUUID()}`;
      await expect(
        runWithTenantDatabaseScope(dbB, attackerTenant, (scoped) =>
          new UserMCPOAuthTokenRepository(scoped, masterSecret).getToken(
            owner.userId,
            owner.serverId
          )
        )
      ).resolves.toBeNull();
    });
  }
);
