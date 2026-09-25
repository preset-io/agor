/** Standalone PG production registration + identity-only REST hooks, not a coordinator mock. */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgorConfig, resolveMultiTenancyConfig } from '@agor/core/config';
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  initializeDatabase,
  type RawDatabase,
  rawRows,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { EXECUTOR_RESPONSE_PROTOCOL } from '@agor/core/executor-protocol';
import {
  AuthenticationService,
  authenticate,
  errorHandler,
  feathers,
  feathersExpress,
  rest,
  socketio,
} from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext, User } from '@agor/core/types';
import express from 'express';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RuntimeJWTStrategy } from './auth/runtime-jwt-strategy.js';
import { registerHooks } from './register-hooks.js';
import { registerServices } from './register-services.js';
import { ClaudeOAuthAttemptAuthority } from './services/claude-oauth-attempt-authority.js';
import { codexDeviceAuthProvider, requestUserCode } from './services/codex-device-auth-provider.js';

// External provider/launcher only: registration, both stores, hooks, user service,
// tenant transactions and RLS are real. No provider token exchange or user credentials.
const transport = vi.hoisted(() => ({
  root: '',
  writes: [] as Array<{ tenantId: string; userId: string; home: string; operation: string }>,
}));
vi.mock('./utils/spawn-executor.js', async (original) => {
  const actual = await original<typeof import('./utils/spawn-executor.js')>();
  return {
    ...actual,
    requestExecutor: vi.fn<typeof actual.requestExecutor>(async (payload, options = {}) => {
      const { getCurrentTenantId } = await import('@agor/core/db');
      const { mutateCredentialFile, writeVerifiedCodexAuthFile } = await import(
        '@agor/core/codex/credential-file'
      );
      const { join } = await import('node:path');
      const tenantId = getCurrentTenantId();
      const userId = options.templateVariables?.user_id;
      const home = options.delegatedHomeKey;
      if (!tenantId || !userId || !home) {
        throw new Error('Unexpected synthetic launcher route');
      }
      const params = payload.params as { operation: string; content?: string; generation?: number };
      if (payload.command === 'claude.auth-file' && params.operation === 'delete') {
        await mutateCredentialFile({
          target: join(transport.root, tenantId, userId, home, '.claude', '.credentials.json'),
          generation: params.generation,
        });
        return { success: true, data: { status: 'deleted' } };
      }
      if (payload.command !== 'codex.auth-file')
        throw new Error('Unexpected synthetic launcher command');
      transport.writes.push({ tenantId, userId, home, operation: params.operation });
      // A synthetic delegated substrate selects an isolated tenant/user/home.
      // Exercise the real credential-file writer, without any real provider.
      const target = join(transport.root, tenantId, userId, home, '.codex', 'auth.json');
      if (params.operation === 'delete') {
        await mutateCredentialFile({ target, generation: params.generation });
        return { success: true, data: { status: 'deleted' } };
      }
      if (params.operation !== 'write' || !params.content)
        throw new Error('Unexpected auth operation');
      const written = await writeVerifiedCodexAuthFile({
        target,
        content: params.content,
        generation: params.generation,
      });
      if (written.outcome === 'stale') throw new Error('Synthetic write was stale');
      return { success: true, data: { status: 'written', authMode: written.authMode } };
    }),
  };
});
vi.mock('./services/codex-device-auth-provider.js', async (original) => {
  const actual = await original<typeof import('./services/codex-device-auth-provider.js')>();
  const requestUserCode = vi.fn<typeof actual.requestUserCode>();
  return {
    ...actual,
    requestUserCode,
    codexDeviceAuthProvider: {
      requestUserCode,
      pollDeviceToken: vi.fn<typeof actual.pollDeviceToken>(),
      exchangeCodeForTokens: vi.fn<typeof actual.exchangeCodeForTokens>(),
    },
  };
});
const unexpectedMcpTransport = vi.hoisted(() => () => {
  throw new Error('Unexpected MCP transport');
});
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: unexpectedMcpTransport }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: unexpectedMcpTransport,
}));

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const secret = 'synthetic-codex-registration-jwt';
const authJson = JSON.stringify({
  tokens: {
    id_token: 'synthetic-id',
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
  },
});
function transactionActive() {
  const scope = getCurrentTenantDatabaseScope();
  return scope?.kind === 'tenant' && scope.transactionActive;
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'registered standalone PostgreSQL Codex credentials',
  () => {
    let raw: RawDatabase;
    let db: TenantScopeAwareDatabase;
    let root: string;
    beforeAll(async () => {
      vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-registration-master-secret');
      root = await mkdtemp(join(tmpdir(), 'codex-registration-'));
      transport.root = root;
      raw = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(raw);
      expect(
        rawRows(
          await executeRaw(
            raw,
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          )
        )[0]
      ).toMatchObject({ rolsuper: false, rolbypassrls: false });
      db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
    }, 60000);
    afterAll(async () => {
      vi.unstubAllEnvs();
      await (raw as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end();
      await rm(root, { recursive: true, force: true });
    });

    async function waitForLockWaiters(minimum: number) {
      await vi.waitFor(async () => {
        const waiting = rawRows(
          await executeRaw(
            raw,
            sql`SELECT count(*)::int AS count
          FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
          )
        );
        expect(waiting[0]?.count).toBeGreaterThanOrEqual(minimum);
      });
    }

    for (const claudeEnabled of [false, true]) {
      it(`start/import/logout and route serialization with Claude OAuth ${claudeEnabled ? 'enabled' : 'disabled'}`, async () => {
        const tenantId = `codex-registration-${crypto.randomUUID()}`;
        const foreignTenant = `${tenantId}-foreign`;
        const seed = (tenant: string) =>
          runWithTenantDatabaseScope(db, tenant, (scoped) =>
            new UsersRepository(scoped).create({
              email: `${crypto.randomUUID()}@example.test`,
              name: 'Codex fixture',
              role: 'admin',
              unix_username: `u_${randomBytes(8).toString('hex')}`,
            })
          );
        const user = await seed(tenantId);
        const foreign = await seed(foreignTenant);
        const config = {
          database: { dialect: 'postgresql' },
          deployment: { mode: 'standalone' },
          agentic_tools: { claude_subscription_oauth: claudeEnabled },
          multi_tenancy: {
            mode: 'required_from_auth',
            auth_claim: 'tenant_id',
            filesystem_isolation_enabled: true,
          },
          execution: {
            unix_user_mode: 'delegated',
            executor_command_template: 'synthetic-launcher {tenant_id} {user_id} {unix_user}',
            executor_response: {
              external_protocol: EXECUTOR_RESPONSE_PROTOCOL,
              origin_url: 'http://127.0.0.1',
            },
            executor_storage: { user_home: 'persistent-per-user' },
          },
        } as AgorConfig;
        const app = feathersExpress(feathers());
        app.use(express.json());
        app.configure(rest());
        app.configure(socketio());
        app.set('config', config);
        app.set('db', db);
        app.set('authentication', {
          secret,
          entity: 'user',
          entityId: 'user_id',
          service: 'users',
          authStrategies: ['jwt'],
          jwtOptions: {
            header: { typ: 'access' },
            audience: 'https://agor.dev',
            issuer: 'agor',
            algorithm: 'HS256',
            expiresIn: '15m',
          },
        });
        const auth = new AuthenticationService(app);
        auth.register(
          'jwt',
          new RuntimeJWTStrategy({ multiTenancy: resolveMultiTenancyConfig(config) })
        );
        app.use('authentication', auth);
        const requireAuth = authenticate({ strategies: ['jwt'] }) as (
          context: HookContext
        ) => Promise<HookContext>;
        const ctx = {
          app,
          db,
          config,
          requireAuth,
          deployment: { mode: 'standalone' as const },
          jwtSecret: secret,
          daemonUrl: 'http://127.0.0.1',
          bundledUiAvailable: false,
          DAEMON_PORT: 3030,
          UI_PORT: 5173,
          allowSuperadmin: false,
        };
        const services = await registerServices(ctx);
        registerHooks({ ...ctx, ...services, superadminOpts: { allowSuperadmin: false } });
        const userEvents: boolean[] = [];
        app.service('users').on('patched', () => userEvents.push(transactionActive()));
        const scopes: boolean[] = [];
        for (const path of ['codex-auth/device', 'codex-auth/import', 'codex-auth/logout']) {
          app.service(path).hooks({
            before: {
              all: [
                async () => {
                  scopes.push(transactionActive());
                  expect(getCurrentTenantId()).toBeDefined();
                },
              ],
            },
          });
        }
        app.use(errorHandler());
        const server = (await app.listen(0)) as Server;
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
        const url = `http://127.0.0.1:${address.port}`;
        const request = async (
          path: string,
          data: unknown = {},
          caller: User = user,
          tenant = tenantId,
          method = 'POST'
        ) => {
          const token = jwt.sign(
            { sub: caller.user_id, type: 'access', tenant_id: tenant },
            secret,
            { issuer: 'agor', audience: 'https://agor.dev', expiresIn: '15m' }
          );
          const result = await fetch(`${url}/${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(method === 'GET' ? {} : { body: JSON.stringify(data) }),
          });
          return { status: result.status, body: (await result.json()) as Record<string, unknown> };
        };
        const providerEntered = deferred();
        const providerRelease = deferred();
        const provider = vi
          .mocked(requestUserCode)
          .mockReset()
          .mockImplementation(async () => {
            expect(transactionActive()).toBe(false);
            providerEntered.resolve();
            await providerRelease.promise;
            return {
              deviceAuthId: 'synthetic-device',
              userCode: 'SYNTHETIC-CODE',
              intervalMs: 60_000,
            };
          });
        transport.writes.length = 0;
        try {
          const start = request('codex-auth/device');
          await Promise.race([
            providerEntered.promise,
            start.then((result) => {
              throw new Error(
                `Device reservation failed before provider: ${JSON.stringify(result)}`
              );
            }),
          ]);
          // Provider is blocked, yet import/logout can acquire the same real DB
          // route lock. No request-long/provider-long transaction is retained.
          expect(await request('codex-auth/import', { authJson })).toMatchObject({
            status: 201,
            body: { status: 'authenticated' },
          });
          expect(await request('codex-auth/logout')).toMatchObject({ status: 201 });
          providerRelease.resolve();
          expect(await start).toMatchObject({ status: 201, body: { phase: 'error' } });
          expect(transport.writes).toHaveLength(2);
          expect(userEvents.length).toBeGreaterThanOrEqual(2);
          expect(userEvents.every((active) => !active)).toBe(true);
          expect(
            transport.writes.every(
              (write) => write.tenantId === tenantId && write.userId === user.user_id
            )
          ).toBe(true);
          expect(
            (await request('codex-auth/device', {}, foreign, foreignTenant, 'GET')).body
          ).toEqual({ phase: 'idle' });
          const beforeForeign = transport.writes.length;
          expect(
            (await request('codex-auth/import', { authJson }, user, foreignTenant)).status
          ).toBeGreaterThanOrEqual(400);
          expect(
            (await request('codex-auth/logout', {}, user, foreignTenant)).status
          ).toBeGreaterThanOrEqual(400);
          expect(transport.writes).toHaveLength(beforeForeign);
          expect(provider).toHaveBeenCalledTimes(1);
          expect(scopes.length).toBeGreaterThan(0);
          expect(scopes.every((active) => !active)).toBe(true);

          // A real concurrent users route mutation owns the same PG lock. The
          // reservation must wait, then capture the new route rather than old.
          const authority = new ClaudeOAuthAttemptAuthority(db);
          const locked = deferred();
          const release = deferred();
          const mutation = authority.runCredentialResolution(tenantId, user.user_id, async () => {
            locked.resolve();
            await release.promise;
            await app.service('users').patch(user.user_id, { unix_username: 'replacement_home' }, {
              user,
              authenticated: true,
            } as AuthenticatedParams);
          });
          await locked.promise;
          try {
            const staleImport = request('codex-auth/import', { authJson });
            const staleLogout = request('codex-auth/logout');
            const next = request('codex-auth/device');
            await waitForLockWaiters(3);
            expect(provider).toHaveBeenCalledTimes(1);
            release.resolve();
            await mutation;
            expect(await staleImport).toMatchObject({
              status: 400,
              body: { message: expect.stringContaining('execution home changed') },
            });
            expect(await staleLogout).toMatchObject({
              status: 400,
              body: { message: expect.stringContaining('execution home changed') },
            });
            const started = await next;
            expect(started).toMatchObject({ status: 201, body: { phase: 'pending' } });
            // A real foreign caller cannot read or cancel the same attempt ID.
            expect(
              await request(
                `codex-auth/device/${started.body.attemptId}`,
                {},
                foreign,
                foreignTenant,
                'DELETE'
              )
            ).toMatchObject({ status: 200, body: { phase: 'idle' } });
            expect(await request('codex-auth/device', {}, user, tenantId, 'GET')).toMatchObject({
              body: { attemptId: started.body.attemptId, phase: 'pending' },
            });
            expect(
              await request(
                `codex-auth/device/${started.body.attemptId}`,
                {},
                user,
                tenantId,
                'DELETE'
              )
            ).toMatchObject({ status: 200, body: { phase: 'idle' } });
          } finally {
            release.resolve();
            await mutation;
          }
          userEvents.length = 0;
          vi.mocked(requestUserCode).mockResolvedValue({
            deviceAuthId: 'synthetic-finalize',
            userCode: 'SYNTHETIC-CODE',
            intervalMs: 10,
          });
          vi.mocked(codexDeviceAuthProvider.pollDeviceToken).mockImplementation(async () => {
            expect(transactionActive()).toBe(false);
            return {
              outcome: 'approved',
              approved: {
                authorizationCode: 'synthetic-code',
                codeVerifier: 'synthetic-verifier',
              },
            };
          });
          vi.mocked(codexDeviceAuthProvider.exchangeCodeForTokens).mockImplementation(async () => {
            expect(transactionActive()).toBe(false);
            return {
              idToken: 'synthetic-id',
              accessToken: 'synthetic-access',
              refreshToken: 'synthetic-refresh',
            };
          });
          expect(await request('codex-auth/device')).toMatchObject({ status: 201 });
          await vi.waitFor(async () => {
            expect(await request('codex-auth/device', {}, user, tenantId, 'GET')).toMatchObject({
              status: 200,
              body: { phase: 'success' },
            });
          });
          expect(transport.writes.at(-1)).toMatchObject({
            tenantId,
            userId: user.user_id,
            home: 'replacement_home',
            operation: 'write',
          });
          expect(userEvents.every((active) => !active)).toBe(true);
          // An already-started attempt must never finalize through a retired route.
          const exchangeEntered = deferred();
          const exchangeRelease = deferred();
          vi.mocked(codexDeviceAuthProvider.exchangeCodeForTokens).mockImplementation(async () => {
            expect(transactionActive()).toBe(false);
            exchangeEntered.resolve();
            await exchangeRelease.promise;
            return {
              idToken: 'synthetic-id',
              accessToken: 'synthetic-access',
              refreshToken: 'synthetic-refresh',
            };
          });
          expect(await request('codex-auth/device')).toMatchObject({ status: 201 });
          await exchangeEntered.promise;
          try {
            expect(
              await request(
                `users/${user.user_id}`,
                { unix_username: 'retired_replacement' },
                user,
                tenantId,
                'PATCH'
              )
            ).toMatchObject({ status: 200 });
            const before = transport.writes.length;
            await authority.runCredentialResolution(tenantId, user.user_id, async () => {
              exchangeRelease.resolve();
              await waitForLockWaiters(1);
            });
            // The finalizer was queued first on the real advisory lock. This
            // round trip waits for its critical section, not merely its status.
            await authority.runCredentialResolution(tenantId, user.user_id, async () => undefined);
            expect((await request('codex-auth/device', {}, user, tenantId, 'GET')).body.phase).toBe(
              'error'
            );
            expect(transport.writes).toHaveLength(before);
          } finally {
            exchangeRelease.resolve();
          }
        } finally {
          providerRelease.resolve();
          provider.mockRestore();
          await app.teardown();
        }
      }, 30000);
    }
  }
);
