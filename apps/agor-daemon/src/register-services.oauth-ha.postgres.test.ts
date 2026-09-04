/** Two-service PostgreSQL proof for the public MCP OAuth start/callback wiring. */

import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  MCPOAuthClientRegistrationRepository,
  MCPServerRepository,
  type RawDatabase,
  rawRows,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  sql,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import type { AuthenticatedParams, MCPServerID, User, UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RegisterServicesContext, registerMCPServices } from './register-services.js';
import { lockMCPOAuthGrantConfiguration } from './services/mcp-oauth-grant-binding.js';

const oauthFixture = vi.hoisted(() => ({
  starts: 0,
  exchanges: 0,
  registrations: 0,
  exchangeFailure: undefined as undefined | 'invalid_client',
  afterDcrResolved: undefined as undefined | ((registrationId: string) => Promise<void>),
  beforeGrantLock: undefined as undefined | (() => Promise<void>),
}));

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
      async (
        _wwwAuthenticate: string,
        clientId: string | undefined,
        redirectUri: string,
        options?: {
          resolveDynamicClientRegistration?: (
            request: {
              registrationEndpoint: string;
              registrationEndpointSource: 'metadata';
              metadataUrl: string;
              resourceUri: string;
              issuer: string;
              authorizationEndpoint: string;
              tokenEndpoint: string;
              redirectUri: string;
              clientName: string;
              compatibilityMode: 'strict';
              dcrMode: 'advertised';
            },
            register: () => Promise<{ client_id: string }>
          ) => Promise<{ registration: { client_id: string }; registrationId?: string }>;
        }
      ) => {
        const ordinal = ++oauthFixture.starts;
        let resolvedClientId = clientId;
        let clientRegistrationId: string | undefined;
        if (!resolvedClientId && options?.resolveDynamicClientRegistration) {
          const resolved = await options.resolveDynamicClientRegistration(
            {
              registrationEndpoint: 'https://provider.example.test/register',
              registrationEndpointSource: 'metadata',
              metadataUrl: 'https://provider.example.test/.well-known/oauth-authorization-server',
              resourceUri: 'https://mcp.provider.example.test/mcp',
              issuer: 'https://provider.example.test',
              authorizationEndpoint: 'https://provider.example.test/authorize',
              tokenEndpoint: 'https://provider.example.test/token',
              redirectUri,
              clientName: 'Agor MCP Client',
              compatibilityMode: 'strict',
              dcrMode: 'advertised',
            },
            async () => ({ client_id: `fixture-dcr-client-${++oauthFixture.registrations}` })
          );
          resolvedClientId = resolved.registration.client_id;
          clientRegistrationId = resolved.registrationId;
          if (clientRegistrationId) {
            await oauthFixture.afterDcrResolved?.(clientRegistrationId);
          }
        }
        if (!resolvedClientId) throw new Error('Fixture OAuth client was not resolved');
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
          clientId: resolvedClientId,
          ...(clientRegistrationId ? { clientRegistrationId } : {}),
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
        if (oauthFixture.exchangeFailure === 'invalid_client') {
          throw new original.OAuthCodeExchangeError(
            'fixture token endpoint rejected client',
            false,
            'client_registration_invalidated',
            true
          );
        }
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

function params(user: User, requestTenantId = tenantId): AuthenticatedParams {
  return {
    provider: 'rest',
    user,
    tenant: { tenant_id: requestTenantId, source: 'authenticated' },
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
        deployment: {
          mode: 'ha',
          capabilities: { mcpOAuth: true },
          mcpOAuthCallbackUrl: 'https://agor.example.test/mcp-servers/oauth-callback',
        } as RegisterServicesContext['deployment'],
        mcpOAuthCallbackUrl: 'https://agor.example.test/mcp-servers/oauth-callback',
        lockMcpOAuthGrantConfiguration: async (scopedDb, tenant, server) => {
          await oauthFixture.beforeGrantLock?.();
          await lockMCPOAuthGrantConfiguration(scopedDb, tenant, server);
        },
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
      oauthFixture.registrations = 0;
      oauthFixture.exchangeFailure = undefined;
      oauthFixture.afterDcrResolved = undefined;
      oauthFixture.beforeGrantLock = undefined;

      replicaA = await createReplica('A');
      await initializeDatabase(replicaA.raw);
      replicaB = await createReplica('B');
      // Runtime must retain the startup injection rather than re-reading an
      // environment/default-config source that can disagree between phases.
      process.env.AGOR_BASE_URL = 'https://mismatching-runtime-source.example.test';
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
      expect(new URL(fromA.authorizationUrl).searchParams.get('redirect_uri')).toBe(
        'https://agor.example.test/mcp-servers/oauth-callback'
      );
      expect(new URL(fromB.authorizationUrl).searchParams.get('redirect_uri')).toBe(
        'https://agor.example.test/mcp-servers/oauth-callback'
      );
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

    it('consumes a member private-server attempt without trusting front-channel invalid_client', async () => {
      const seeded = await runWithTenantDatabaseScope(replicaA.db, tenantId, async (scoped) => {
        const member = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: 'Front-channel rejection member',
          role: 'member',
        });
        const server = await new MCPServerRepository(scoped).create({
          name: `ha-oauth-front-channel-member-${crypto.randomUUID()}`,
          transport: 'http',
          url: 'https://mcp.provider.example.test/mcp',
          scope: 'session',
          enabled: true,
          source: 'user',
          owner_user_id: member.user_id,
          auth: {
            type: 'oauth',
            oauth_mode: 'per_user',
            oauth_dcr_mode: 'advertised',
            oauth_compatibility_mode: 'strict',
          },
        });
        return { member, serverId: server.mcp_server_id as MCPServerID };
      });
      const exchangesBefore = oauthFixture.exchanges;
      const started = (await replicaA.app
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: seeded.serverId }, params(seeded.member))) as {
        success: boolean;
        authorizationUrl: string;
        attempt_id: string;
      };
      const state = new URL(started.authorizationUrl).searchParams.get('state');
      expect(started.success).toBe(true);
      expect(state).toBeTruthy();
      const before = await runWithTenantDatabaseScope(replicaA.db, tenantId, (scoped) =>
        new MCPOAuthClientRegistrationRepository(scoped).getCurrent(tenantId, seeded.serverId)
      );
      expect(before).toMatchObject({ status: 'registered', isCurrent: true });

      await expect(
        replicaB.app.service('mcp-servers/oauth-complete').create(
          {
            callback_url: `https://agor.example.test/mcp-servers/oauth-callback?error=invalid_client&state=${encodeURIComponent(state!)}`,
          },
          params(seeded.member)
        )
      ).resolves.toMatchObject({ success: false, tokenObtained: false });
      expect(oauthFixture.exchanges).toBe(exchangesBefore);

      await runWithTenantDatabaseScope(replicaA.db, tenantId, async (scoped) => {
        await expect(
          new MCPOAuthClientRegistrationRepository(scoped).getCurrent(tenantId, seeded.serverId)
        ).resolves.toMatchObject({ registrationId: before?.registrationId, status: 'registered' });
        const attempts = rawRows(
          await executeRaw(
            scoped,
            sql`SELECT status, failure_code, sealed_material
                FROM mcp_oauth_pending_flows
                WHERE attempt_id = ${started.attempt_id}`
          )
        );
        expect(attempts).toEqual([
          expect.objectContaining({
            status: 'failed',
            failure_code: 'authorization_denied',
            sealed_material: null,
          }),
        ]);
      });
    });

    it('consumes a shared-server rejection after demotion without invalidating DCR', async () => {
      const seeded = await runWithTenantDatabaseScope(replicaA.db, tenantId, async (scoped) => {
        const initiatingAdmin = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: 'Shared OAuth demotion admin',
          role: 'admin',
        });
        const server = await new MCPServerRepository(scoped).create({
          name: `ha-oauth-front-channel-shared-${crypto.randomUUID()}`,
          transport: 'http',
          url: 'https://mcp.provider.example.test/mcp',
          scope: 'global',
          enabled: true,
          source: 'user',
          owner_user_id: initiatingAdmin.user_id,
          auth: {
            type: 'oauth',
            oauth_mode: 'shared',
            oauth_dcr_mode: 'advertised',
            oauth_compatibility_mode: 'strict',
          },
        });
        return { initiatingAdmin, serverId: server.mcp_server_id as MCPServerID };
      });
      const started = (await replicaA.app
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: seeded.serverId }, params(seeded.initiatingAdmin))) as {
        success: boolean;
        authorizationUrl: string;
        attempt_id: string;
      };
      const state = new URL(started.authorizationUrl).searchParams.get('state');
      const before = await runWithTenantDatabaseScope(replicaA.db, tenantId, async (scoped) => {
        await new UsersRepository(scoped).update(seeded.initiatingAdmin.user_id, {
          role: 'member',
        });
        return new MCPOAuthClientRegistrationRepository(scoped).getCurrent(
          tenantId,
          seeded.serverId
        );
      });

      await expect(
        replicaB.callback({
          error: 'unauthorized_client',
          state: state!,
          iss: 'https://attacker.invalid',
        })
      ).resolves.toMatchObject({ status: 400 });
      await runWithTenantDatabaseScope(replicaA.db, tenantId, async (scoped) => {
        await expect(
          new MCPOAuthClientRegistrationRepository(scoped).getCurrent(tenantId, seeded.serverId)
        ).resolves.toMatchObject({ registrationId: before?.registrationId, status: 'registered' });
        const attempts = rawRows(
          await executeRaw(
            scoped,
            sql`SELECT status, failure_code
                FROM mcp_oauth_pending_flows
                WHERE attempt_id = ${started.attempt_id}`
          )
        );
        expect(attempts).toEqual([
          expect.objectContaining({ status: 'failed', failure_code: 'authorization_denied' }),
        ]);
      });
    });

    it('invalidates the exact DCR row only after a pinned token exchange proves invalid_client', async () => {
      const tokenRejectedServerId = await runWithTenantDatabaseScope(
        replicaA.db,
        tenantId,
        async (scoped) => {
          const server = await new MCPServerRepository(scoped).create({
            name: `ha-oauth-token-invalid-client-${crypto.randomUUID()}`,
            transport: 'http',
            url: 'https://mcp.provider.example.test/mcp',
            scope: 'global',
            enabled: true,
            source: 'user',
            owner_user_id: user.user_id,
            auth: {
              type: 'oauth',
              oauth_mode: 'per_user',
              oauth_dcr_mode: 'advertised',
              oauth_compatibility_mode: 'strict',
            },
          });
          return server.mcp_server_id as MCPServerID;
        }
      );
      const started = (await replicaA.app
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: tokenRejectedServerId }, params(user))) as {
        authorizationUrl: string;
      };
      const state = new URL(started.authorizationUrl).searchParams.get('state');
      const before = await runWithTenantDatabaseScope(replicaA.db, tenantId, (scoped) =>
        new MCPOAuthClientRegistrationRepository(scoped).getCurrent(tenantId, tokenRejectedServerId)
      );
      expect(before).toMatchObject({ status: 'registered' });

      oauthFixture.exchangeFailure = 'invalid_client';
      try {
        await expect(
          replicaB.callback({
            code: 'provider-code-for-invalid-client',
            state: state!,
            iss: 'https://provider.example.test',
          })
        ).resolves.toMatchObject({ status: 400 });
      } finally {
        oauthFixture.exchangeFailure = undefined;
      }

      await runWithTenantDatabaseScope(replicaA.db, tenantId, async (scoped) => {
        await expect(
          new MCPOAuthClientRegistrationRepository(scoped).getCurrent(
            tenantId,
            tokenRejectedServerId
          )
        ).resolves.toBeNull();
        const rows = rawRows(
          await executeRaw(
            scoped,
            sql`SELECT status, is_current, failure_code
                FROM mcp_oauth_client_registrations
                WHERE registration_id = ${before?.registrationId}`
          )
        );
        expect(rows).toEqual([
          expect.objectContaining({
            status: 'superseded',
            is_current: false,
            failure_code: 'provider_invalidated_client',
          }),
        ]);
      });
    });

    it('lets only a current-tenant admin reset DCR authority before callback completion', async () => {
      const registrationId = generateId();
      await runWithTenantDatabaseTransaction(replicaA.db, tenantId, (scoped) =>
        new MCPOAuthClientRegistrationRepository(scoped).claimOrObserve({
          tenantId,
          registrationId,
          mcpServerId: serverId,
          bindingFingerprint: 'a'.repeat(64),
          serverConfigVersion: 1,
          envelopeVersion: 1,
          claimId: generateId(),
          leaseMs: 60_000,
        })
      );
      const member = await runWithTenantDatabaseScope(replicaA.db, tenantId, (scoped) =>
        new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: 'OAuth reset member',
          role: 'member',
        })
      );
      const otherTenantId = `mcp-oauth-reset-other-${crypto.randomUUID()}`;
      const otherAdmin = await runWithTenantDatabaseScope(replicaA.db, otherTenantId, (scoped) =>
        new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: 'Other tenant OAuth reset admin',
          role: 'admin',
        })
      );

      await expect(
        replicaB.app
          .service('mcp-servers/oauth-client-registration-reset')
          .create({ mcp_server_id: serverId }, params(member))
      ).rejects.toMatchObject({ code: 403 });
      await expect(
        replicaB.app
          .service('mcp-servers/oauth-client-registration-reset')
          .create({ mcp_server_id: serverId }, params(otherAdmin, otherTenantId))
      ).rejects.toMatchObject({ code: 404 });

      await expect(
        replicaB.app
          .service('mcp-servers/oauth-client-registration-reset')
          .create({ mcp_server_id: serverId }, params(user))
      ).resolves.toEqual({ success: true });

      const rows = await runWithTenantDatabaseScope(replicaA.db, tenantId, async (scoped) =>
        rawRows(
          await executeRaw(
            scoped,
            sql`SELECT status, is_current, failure_code, sealed_material
                FROM mcp_oauth_client_registrations
                WHERE registration_id = ${registrationId}`
          )
        )
      );
      expect(rows).toEqual([
        expect.objectContaining({
          status: 'superseded',
          is_current: false,
          failure_code: 'server_configuration_changed',
          sealed_material: null,
        }),
      ]);
      await expect(
        runWithTenantDatabaseScope(replicaA.db, tenantId, (scoped) =>
          new MCPServerRepository(scoped).findById(serverId)
        )
      ).resolves.toMatchObject({ config_version: 2 });
    });

    it('rechecks administrator authority after grant-lock contention', async () => {
      const seeded = await runWithTenantDatabaseScope(replicaA.db, tenantId, async (scoped) => {
        const waitingAdmin = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: 'OAuth reset waiting admin',
          role: 'admin',
        });
        const server = await new MCPServerRepository(scoped).create({
          name: `ha-oauth-reset-demotion-${crypto.randomUUID()}`,
          transport: 'http',
          url: 'https://mcp.provider.example.test/mcp',
          scope: 'global',
          enabled: true,
          source: 'user',
          owner_user_id: waitingAdmin.user_id,
          auth: {
            type: 'oauth',
            oauth_mode: 'per_user',
            oauth_client_id: 'demotion-fixture-client',
          },
        });
        return { waitingAdmin, serverId: server.mcp_server_id as MCPServerID };
      });
      const holderReady = Promise.withResolvers<void>();
      const releaseHolder = Promise.withResolvers<void>();
      const holder = runWithTenantDatabaseTransaction(replicaA.db, tenantId, async (scoped) => {
        await lockMCPOAuthGrantConfiguration(scoped, tenantId, seeded.serverId);
        holderReady.resolve();
        await releaseHolder.promise;
      });
      await holderReady.promise;

      const resetReachedLock = Promise.withResolvers<void>();
      oauthFixture.beforeGrantLock = async () => resetReachedLock.resolve();
      const reset = replicaB.app
        .service('mcp-servers/oauth-client-registration-reset')
        .create({ mcp_server_id: seeded.serverId }, params(seeded.waitingAdmin));
      try {
        await resetReachedLock.promise;
        await runWithTenantDatabaseScope(replicaA.db, tenantId, (scoped) =>
          new UsersRepository(scoped).update(seeded.waitingAdmin.user_id, { role: 'member' })
        );
        releaseHolder.resolve();
        await expect(reset).rejects.toMatchObject({ code: 403 });
        await expect(
          runWithTenantDatabaseScope(replicaA.db, tenantId, (scoped) =>
            new MCPServerRepository(scoped).findById(seeded.serverId)
          )
        ).resolves.toMatchObject({ config_version: 1 });
      } finally {
        oauthFixture.beforeGrantLock = undefined;
        releaseHolder.resolve();
        await holder;
        await reset.catch(() => undefined);
      }
    });

    it('lets a current admin reset a member-owned private server in the same tenant', async () => {
      const seeded = await runWithTenantDatabaseScope(replicaA.db, tenantId, async (scoped) => {
        const memberOwner = await new UsersRepository(scoped).create({
          email: `${crypto.randomUUID()}@example.test`,
          name: 'Private OAuth server owner',
          role: 'member',
        });
        const server = await new MCPServerRepository(scoped).create({
          name: `ha-oauth-private-reset-${crypto.randomUUID()}`,
          transport: 'http',
          url: 'https://mcp.provider.example.test/mcp',
          scope: 'session',
          enabled: true,
          source: 'user',
          owner_user_id: memberOwner.user_id,
          auth: {
            type: 'oauth',
            oauth_mode: 'per_user',
            oauth_client_id: 'private-fixture-client',
          },
        });
        const registrationId = generateId();
        await new MCPOAuthClientRegistrationRepository(scoped).claimOrObserve({
          tenantId,
          registrationId,
          mcpServerId: server.mcp_server_id as MCPServerID,
          bindingFingerprint: 'b'.repeat(64),
          serverConfigVersion: 1,
          envelopeVersion: 1,
          claimId: generateId(),
          leaseMs: 60_000,
        });
        return {
          registrationId,
          serverId: server.mcp_server_id as MCPServerID,
        };
      });

      await expect(
        replicaB.app
          .service('mcp-servers/oauth-client-registration-reset')
          .create({ mcp_server_id: seeded.serverId }, params(user))
      ).resolves.toEqual({ success: true });

      await runWithTenantDatabaseScope(replicaA.db, tenantId, async (scoped) => {
        await expect(
          new MCPServerRepository(scoped).findById(seeded.serverId)
        ).resolves.toMatchObject({ config_version: 2 });
        const rows = rawRows(
          await executeRaw(
            scoped,
            sql`SELECT status, is_current
                FROM mcp_oauth_client_registrations
                WHERE registration_id = ${seeded.registrationId}`
          )
        );
        expect(rows).toEqual([
          expect.objectContaining({ status: 'superseded', is_current: false }),
        ]);
      });
    });

    it('fences a start that resolved DCR before reset and re-registers on reconnect', async () => {
      const dcrServerId = await runWithTenantDatabaseScope(
        replicaA.db,
        tenantId,
        async (scoped) => {
          const server = await new MCPServerRepository(scoped).create({
            name: `ha-oauth-reset-race-${crypto.randomUUID()}`,
            transport: 'http',
            url: 'https://mcp.provider.example.test/mcp',
            scope: 'global',
            enabled: true,
            source: 'user',
            owner_user_id: user.user_id,
            auth: {
              type: 'oauth',
              oauth_mode: 'per_user',
              oauth_dcr_mode: 'advertised',
              oauth_compatibility_mode: 'strict',
            },
          });
          return server.mcp_server_id as MCPServerID;
        }
      );
      const dcrResolved = Promise.withResolvers<string>();
      const releaseStart = Promise.withResolvers<void>();
      oauthFixture.afterDcrResolved = async (registrationId) => {
        dcrResolved.resolve(registrationId);
        await releaseStart.promise;
      };
      const start = replicaA.app
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: dcrServerId }, params(user)) as Promise<{ success: boolean }>;

      try {
        const retiredRegistrationId = await dcrResolved.promise;
        await expect(
          replicaB.app
            .service('mcp-servers/oauth-client-registration-reset')
            .create({ mcp_server_id: dcrServerId }, params(user))
        ).resolves.toEqual({ success: true });
        releaseStart.resolve();
        await expect(start).resolves.toMatchObject({ success: false });

        const afterRace = await runWithTenantDatabaseScope(
          replicaB.db,
          tenantId,
          async (scoped) => ({
            server: await new MCPServerRepository(scoped).findById(dcrServerId),
            pending: rawRows(
              await executeRaw(
                scoped,
                sql`SELECT attempt_id FROM mcp_oauth_pending_flows
                    WHERE mcp_server_id = ${dcrServerId} AND is_current = true`
              )
            ),
            registration: await new MCPOAuthClientRegistrationRepository(scoped).getCurrent(
              tenantId,
              dcrServerId
            ),
          })
        );
        expect(afterRace.server).toMatchObject({ config_version: 2 });
        expect(afterRace.pending).toEqual([]);
        expect(afterRace.registration).toBeNull();

        oauthFixture.afterDcrResolved = undefined;
        const reconnect = (await replicaB.app
          .service('mcp-servers/oauth-start')
          .create({ mcp_server_id: dcrServerId }, params(user))) as {
          success: boolean;
          attempt_id?: string;
        };
        expect(reconnect).toMatchObject({ success: true, attempt_id: expect.any(String) });
        expect(oauthFixture.registrations).toBeGreaterThanOrEqual(2);
        const currentRegistration = await runWithTenantDatabaseScope(
          replicaA.db,
          tenantId,
          (scoped) =>
            new MCPOAuthClientRegistrationRepository(scoped).getCurrent(tenantId, dcrServerId)
        );
        expect(currentRegistration).toMatchObject({
          status: 'registered',
          isCurrent: true,
          serverConfigVersion: 2,
        });
        expect(currentRegistration?.registrationId).not.toBe(retiredRegistrationId);
      } finally {
        oauthFixture.afterDcrResolved = undefined;
        releaseStart.resolve();
        await start.catch(() => undefined);
      }
    });
  }
);
