/**
 * Active-active refresh proofs. Run against a PostgreSQL role that is
 * NOSUPERUSER and NOBYPASSRLS; two independent pools model two daemons.
 */
import http from 'node:http';
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  initializeDatabase,
  MCPOAuthPendingFlowRepository,
  MCPServerRepository,
  type RawDatabase,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { refreshAndPersistToken } from '@agor/core/tools/mcp/oauth-refresh';
import type { MCPServerID, UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyMCPAuthRecovery } from './mcp-auth-recovery';
import { acquireMCPOAuthGrant, MCPOAuthRefreshBusyError } from './mcp-oauth-use';

// Hold only A's return boundary after the real provider exchange + CAS commit.
// B uses a separate pool and the real refresher; no timing sleeps or fake rows.
const race = vi.hoisted(() => ({
  afterRefresh: undefined as undefined | ((db: unknown) => Promise<void>),
}));
vi.mock('@agor/core/tools/mcp/oauth-refresh', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agor/core/tools/mcp/oauth-refresh')>();
  return {
    ...original,
    refreshAndPersistToken: async (deps: Parameters<typeof original.refreshAndPersistToken>[0]) => {
      const token = await original.refreshAndPersistToken(deps);
      await race.afterRefresh?.(deps.db);
      return token;
    },
  };
});

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const masterSecret = 'mcp-oauth-refresh-postgres-test-master-secret';

interface Seed {
  tenantId: string;
  userId: UserID;
  serverId: MCPServerID;
  generation: number;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'MCP OAuth use committed re-read across replicas (PostgreSQL)',
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

    it.each(['completed', 'refreshing'] as const)(
      'handles a newer %s rotation without reauthentication',
      async (state) => {
        let ordinal = 0;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let started!: () => void;
        const secondStarted = new Promise<void>((resolve) => {
          started = resolve;
        });
        const tokenProvider = await provider(async (body, response) => {
          const current = ++ordinal;
          expect(body.get('refresh_token')).toBe(
            current === 1 ? `refresh-${state}-0` : 'rotated-refresh-1'
          );
          if (current === 2) {
            started();
            if (state === 'refreshing') await held;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              access_token: `rotated-access-${current}`,
              refresh_token: `rotated-refresh-${current}`,
              token_type: 'Bearer',
              expires_in: 7200,
            })
          );
        });
        const bound = await seed(state, tokenProvider.url);
        const deps = {
          db: dbA,
          tenantId: bound.tenantId,
          userId: bound.userId,
          mcpServerId: bound.serverId,
          validateGrant: async () => true,
          allowLocalhostHttpDevelopment: true,
        };
        let second: Promise<string> | undefined;
        race.afterRefresh = async (db) => {
          if (db !== dbA) return;
          race.afterRefresh = undefined;
          second = refreshAndPersistToken({
            ...deps,
            db: dbB,
            observedRefreshVersion: {
              grantGeneration: bound.generation,
              grantBindingFingerprint: 'a'.repeat(64),
              refreshGeneration: 1,
            },
          });
          if (state === 'completed') await second;
          else await secondStarted;
        };
        try {
          if (state === 'completed') {
            const acquired = await acquireMCPOAuthGrant(deps);
            expect(acquired).toMatchObject({
              refresh_generation: 2,
              refresh_success_generation: 2,
              refresh_status: 'idle',
              oauth_access_token: 'rotated-access-2',
            });
          } else {
            const error = await acquireMCPOAuthGrant(deps).catch((error) => error);
            expect(error).toBeInstanceOf(MCPOAuthRefreshBusyError);
            expect(classifyMCPAuthRecovery(error).action).toBe('retry');
          }
        } finally {
          release();
          race.afterRefresh = undefined;
          await second;
        }
        const acquired = await acquireMCPOAuthGrant({ ...deps, db: dbB });
        expect(acquired).toMatchObject({
          refresh_generation: 2,
          refresh_success_generation: 2,
          refresh_status: 'idle',
          oauth_access_token: 'rotated-access-2',
        });
        // Re-read never exchanges the previous rotating credential again.
        expect(tokenProvider.calls()).toBe(2);
        expect(
          await acquireMCPOAuthGrant({ ...deps, tenantId: `${bound.tenantId}-foreign` })
        ).toBeNull();
        expect(tokenProvider.calls()).toBe(2);
      }
    );
  }
);
