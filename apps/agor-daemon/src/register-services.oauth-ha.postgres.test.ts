/** Two-service PostgreSQL proof for the public MCP OAuth start/callback wiring. */

import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  initializeDatabase,
  isPostgresDatabase,
  MCPServerRepository,
  type RawDatabase,
  rawRows,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import type { AuthenticatedParams, MCPServerID, User, UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RegisterServicesContext, registerMCPServices } from './register-services.js';

const oauthFixture = vi.hoisted(() => ({ starts: 0, exchanges: 0 }));

vi.mock('@agor/core/tools/mcp/oauth-mcp-transport', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@agor/core/tools/mcp/oauth-mcp-transport')>();
  return {
    ...original,
    resolveMCPOAuthDiscovery: vi.fn(async () => ({
      kind: 'authorization-server' as const,
      discoveredAt: 'https://provider.example.test/.well-known/oauth-authorization-server',
      authServerMetadata: {
        issuer: 'https://provider.example.test',
        authorization_endpoint: 'https://provider.example.test/authorize',
        token_endpoint: 'https://provider.example.test/token',
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
      },
    })),
    startMCPOAuthFlow: vi.fn(
      async (_wwwAuthenticate: string, clientId: string, redirectUri: string) => {
        const ordinal = ++oauthFixture.starts;
        const state = `fixture-state-${ordinal}`;
        const authorizationUrl = new URL('https://provider.example.test/authorize');
        authorizationUrl.searchParams.set('state', state);
        authorizationUrl.searchParams.set('redirect_uri', redirectUri);
        return {
          metadataUrl: 'https://provider.example.test/.well-known/oauth-authorization-server',
          resourceUri: 'https://mcp.provider.example.test/mcp',
          issuer: 'https://provider.example.test',
          authorizationEndpoint: 'https://provider.example.test/authorize',
          tokenEndpoint: 'https://provider.example.test/token',
          redirectUri,
          pkceVerifier: `fixture-verifier-${ordinal}`,
          clientId,
          state,
          authorizationUrl: authorizationUrl.toString(),
          compatibilityMode: 'strict' as const,
          authorizationResponseIssuerParameterSupported: true,
          allowLocalhostHttp: false,
        };
      }
    ),
    completeMCPOAuthFlow: vi.fn(
      async (context: { state: string }, _code: string, state: string) => {
        if (context.state !== state) throw new Error('fixture state mismatch');
        oauthFixture.exchanges += 1;
        return {
          access_token: `fixture-access-token-${oauthFixture.exchanges}`,
          refresh_token: 'fixture-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
        };
      }
    ),
  };
});

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const tenantId = `mcp-oauth-ha-services-${crypto.randomUUID()}`;
const masterSecret = 'mcp-oauth-ha-services-master-secret';

type Replica = {
  raw: RawDatabase;
  db: TenantScopeAwareDatabase;
  app: Application & { io: unknown };
  callback: (query: Record<string, string>) => Promise<{ status: number; body: string }>;
  emitted: Array<{ room: string; event: string; value: unknown }>;
};

function params(user: User): AuthenticatedParams {
  return {
    provider: 'rest',
    user,
    tenant: { tenant_id: tenantId, source: 'authenticated' },
    authentication: { strategy: 'jwt', accessToken: 'test-authority-token' },
  } as AuthenticatedParams;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'MCP OAuth public services across PostgreSQL replicas',
  () => {
    let replicaA: Replica;
    let replicaB: Replica;
    let user: User;
    let serverId: MCPServerID;
    let originalBaseUrl: string | undefined;
    let originalMasterSecret: string | undefined;

    async function createReplica(label: string): Promise<Replica> {
      const raw = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      if (!isPostgresDatabase(raw)) throw new Error('PostgreSQL test requires PostgreSQL');
      const db = createTenantScopedDatabaseProxy(raw, {
        requireScope: true,
        label: `MCP OAuth service replica ${label}`,
      });
      const emitted: Replica['emitted'] = [];
      const io = {
        local: { to: () => ({ emit() {} }) },
        to: (room: string) => ({
          emit: (event: string, value: unknown) => emitted.push({ room, event, value }),
        }),
        sockets: { sockets: new Map() },
      };
      const app = feathers() as Application & { io: typeof io };
      app.io = io;
      const { oauthCallbackHandler } = await registerMCPServices({
        db,
        app,
        config: {} as RegisterServicesContext['config'],
        jwtSecret: 'test-jwt',
        daemonUrl: 'https://agor.example.test',
        bundledUiAvailable: false,
        DAEMON_PORT: 3030,
        UI_PORT: 5173,
        branchRbacEnabled: false,
        allowSuperadmin: false,
        requireAuth: async (context) => context,
        deployment: { mode: 'ha' } as RegisterServicesContext['deployment'],
        mcpOAuthFetch: async (_input, _init, assertCurrent) => {
          assertCurrent?.();
          return new Response('', {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer resource_metadata="https://mcp.provider.example.test/.well-known/oauth-protected-resource"',
            },
          });
        },
      });
      const callback = async (query: Record<string, string>) => {
        let status = 200;
        let body = '';
        const response = {
          setHeader() {},
          status(code: number) {
            status = code;
            return this;
          },
          send(value: string) {
            body = value;
            return this;
          },
        };
        await (
          oauthCallbackHandler as unknown as (request: unknown, response: unknown) => Promise<void>
        )({ query }, response);
        return { status, body };
      };
      return { raw, db, app, callback, emitted };
    }

    beforeAll(async () => {
      originalBaseUrl = process.env.AGOR_BASE_URL;
      originalMasterSecret = process.env.AGOR_MASTER_SECRET;
      process.env.AGOR_BASE_URL = 'https://agor.example.test';
      process.env.AGOR_MASTER_SECRET = masterSecret;
      oauthFixture.starts = 0;
      oauthFixture.exchanges = 0;

      replicaA = await createReplica('A');
      await initializeDatabase(replicaA.raw);
      replicaB = await createReplica('B');
      const seeded = await runWithTenantDatabaseScope(replicaA.db, tenantId, async (scoped) => {
        const createdUser = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: 'HA OAuth service user',
          role: 'admin',
        });
        const server = await new MCPServerRepository(scoped).create({
          name: `ha-oauth-${crypto.randomUUID()}`,
          display_name: 'HA OAuth service fixture',
          transport: 'http',
          url: 'https://mcp.provider.example.test/mcp',
          scope: 'global',
          enabled: true,
          source: 'user',
          owner_user_id: createdUser.user_id as UserID,
          auth: {
            type: 'oauth',
            oauth_mode: 'per_user',
            oauth_client_id: 'production-shaped-fixture-client',
            oauth_compatibility_mode: 'strict',
          },
        });
        return { createdUser, serverId: server.mcp_server_id as MCPServerID };
      });
      user = seeded.createdUser;
      serverId = seeded.serverId;
    });

    afterAll(async () => {
      if (originalBaseUrl === undefined) delete process.env.AGOR_BASE_URL;
      else process.env.AGOR_BASE_URL = originalBaseUrl;
      if (originalMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = originalMasterSecret;
      await Promise.all(
        [replicaA, replicaB].map((replica) =>
          (replica.raw as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end()
        )
      );
    });

    it('serializes concurrent starts and completes the winner on the other replica', async () => {
      const start = (replica: Replica) =>
        replica.app
          .service('mcp-servers/oauth-start')
          .create({ mcp_server_id: serverId }, params(user)) as Promise<{
          success: boolean;
          authorizationUrl: string;
          attempt_id: string;
          state?: string;
        }>;
      const [fromA, fromB] = await Promise.all([start(replicaA), start(replicaB)]);
      expect(fromA.success).toBe(true);
      expect(fromB.success).toBe(true);
      expect(fromA.state).toBeUndefined();
      expect(fromB.state).toBeUndefined();

      const currentRows = await runWithTenantDatabaseScope(replicaB.db, tenantId, async (scoped) =>
        rawRows(
          await executeRaw(
            scoped,
            sql`SELECT attempt_id, status, sealed_material
                FROM mcp_oauth_pending_flows
                WHERE mcp_server_id = ${serverId} AND is_current = true`
          )
        )
      );
      expect(currentRows).toHaveLength(1);
      expect(currentRows[0]?.status).toBe('pending');
      const winner = currentRows[0]?.attempt_id === fromA.attempt_id ? fromA : fromB;
      const callbackReplica = winner === fromA ? replicaB : replicaA;
      const duplicateReplica = winner === fromA ? replicaA : replicaB;
      const state = new URL(winner.authorizationUrl).searchParams.get('state');
      expect(state).toBeTruthy();
      expect(String(currentRows[0]?.sealed_material)).not.toContain(state!);

      const completed = await callbackReplica.callback({
        code: 'single-use-provider-code',
        state: state!,
        iss: 'https://provider.example.test',
      });
      expect(completed.status).toBe(200);
      expect(completed.body).not.toContain('single-use-provider-code');
      expect(oauthFixture.exchanges).toBe(1);

      const duplicate = await duplicateReplica.callback({
        code: 'single-use-provider-code',
        state: state!,
        iss: 'https://provider.example.test',
      });
      expect(duplicate.status).toBe(200);
      expect(oauthFixture.exchanges).toBe(1);

      const grant = await runWithTenantDatabaseScope(replicaA.db, tenantId, (scoped) =>
        new UserMCPOAuthTokenRepository(scoped, masterSecret).getToken(
          user.user_id as UserID,
          serverId
        )
      );
      expect(grant).toMatchObject({ oauth_access_token: 'fixture-access-token-1' });
      expect(
        callbackReplica.emitted.some(
          ({ event, value }) =>
            event === 'oauth:completed' &&
            JSON.stringify(value).includes(winner.attempt_id) &&
            !JSON.stringify(value).includes('fixture-access-token')
        )
      ).toBe(true);
    });
  }
);
