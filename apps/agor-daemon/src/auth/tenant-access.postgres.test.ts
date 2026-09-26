/** Real PostgreSQL/RLS behind the candidate authenticated-admission composition.
 * The first task-safety test uses real signed Socket.IO authentication; later
 * service-composition cases use fixture authentication. No process-exit claim.
 */
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import {
  applyTenantRestrictionIntent,
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  generateId,
  initializeDatabase,
  type RawDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import {
  AuthenticationService,
  authenticate,
  errorHandler,
  feathers,
  feathersExpress,
  rest,
  socketio,
} from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import {
  BRANCH_CLEANUP_REPORT_SERVICE,
  BRANCH_DELETION_REPORT_SERVICE,
  branchCleanupCommandId,
  branchDeletionCommandId,
  ENVIRONMENT_COMMAND_REPORT_SERVICE,
  environmentCommandTokenId,
  TaskStatus,
} from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionTokenService } from '../services/session-token-service.js';
import { TASKS_SERVICE_TRANSPORT_METHODS, TasksService } from '../services/tasks.js';
import { TenantRestrictionReconciler } from '../services/tenant-restriction-reconciler.js';
import { configureChannels, createSocketIOConfig } from '../setup/socketio.js';
import {
  beginExecutorTermination,
  requestExecutorTermination,
} from '../termination-coordinator.js';
import { withFreshTenantWrite } from '../utils/tenant-db-scope.js';
import { getOrCreateExecutorConnectionRevocationFence } from './executor-connection-admission.js';
import { createIssueBrowserTokensHook } from './issue-browser-tokens-hook.js';
import { createRefreshTokenService } from './refresh-token-service.js';
import { createTenantRestrictedAuthHook } from './require-auth.js';
import { RuntimeJWTStrategy } from './runtime-jwt-strategy.js';
import {
  issueRuntimeTokenPair,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
} from './runtime-tokens.js';
import { assertRuntimeTenantAccess, assertRuntimeTenantRequestAccess } from './tenant-access.js';
import {
  assertTenantCredentialEpoch,
  readTenantCredentialEpoch,
  tenantCredentialEpochClaims,
} from './tenant-credential-epoch.js';
import { authCredentialGenerationClaim, authTokenIssuedAtClaim } from './token-invalidation.js';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'tenant API access admission (PostgreSQL)',
  () => {
    let raw: RawDatabase;
    let db: TenantScopeAwareDatabase;
    beforeAll(async () => {
      raw = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(raw);
      db = createTenantScopedDatabaseProxy(raw, {
        requireScope: true,
        label: 'tenant-access-test',
      });
    });
    afterAll(async () => {
      await (raw as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end();
    });

    const seedTenant = (tenantId: string) =>
      runWithTenantDatabaseScope(raw, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${tenantId}@example.test`,
          name: 'Safety test',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId(),
          slug: tenantId,
          name: tenantId,
          repo_type: 'remote',
          remote_url: 'https://example.invalid/test.git',
          local_path: `/tmp/${tenantId}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: tenantId,
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1_000_000),
          path: `/tmp/${tenantId}`,
          created_by: user.user_id,
        });
        const session = await new SessionRepository(scoped).create({
          session_id: generateId(),
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'codex',
          status: 'running',
          ready_for_prompt: false,
        });
        const task = await new TaskRepository(scoped).create({
          task_id: generateId(),
          session_id: session.session_id,
          created_by: user.user_id,
          full_prompt: 'must not appear in termination projection',
          status: TaskStatus.RUNNING,
          executor_connected_at: new Date().toISOString(),
          sdk_watchdog_mode: 'observe',
          executor_mode: 'templated',
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'test' },
          tool_use_count: 0,
        });
        const queued = await new TaskRepository(scoped).createPending({
          session_id: session.session_id,
          created_by: user.user_id,
          full_prompt: 'preserve this queued prompt',
          status: TaskStatus.QUEUED,
        });
        return { user, branch, session, task, queued };
      });

    it('keeps signed executor Socket.IO safety RPCs and reconnect while denying ordinary/foreign RPCs', async () => {
      const tenantId = `socket-safety-${generateId()}`;
      const seeded = await seedTenant(tenantId);
      const jwtSecret = 'disposable-restricted-executor-socket-secret';
      const app = feathersExpress(feathers());
      app.set('config', {});
      app.set('distributedWorkIdentity', {
        instanceId: 'socket-safety',
        bootId: 'socket-safety-boot',
      });
      const multiTenancy = {
        mode: 'required_from_auth',
        static_tenant_id: 'unused' as never,
        auth_claim: 'tenant_id',
      } as const;
      const tokenService = new SessionTokenService(
        { expiration_ms: 60_000, max_uses: -1 },
        { db, startCleanupTimer: false }
      );
      tokenService.setJwtSecret(jwtSecret);
      const token = await runWithTenantDatabaseScope(raw, tenantId, () =>
        tokenService.generateToken(seeded.session.session_id, seeded.user.user_id, {
          taskId: seeded.task.task_id,
          branchId: seeded.branch.branch_id,
        })
      );
      // Authentication adapter uses real tenant-scoped user persistence. The
      // claimed boundary here is task safety RPC transport, not all user routes.
      app.use('users', {
        async get(id: string, params: { tenant?: { tenant_id: string } }) {
          if (!params.tenant?.tenant_id) throw new Error('Missing authenticated tenant');
          return runWithTenantDatabaseScope(db, params.tenant.tenant_id, (scoped) =>
            new UsersRepository(scoped).findById(id as never)
          );
        },
      });
      app.set('authentication', {
        secret: jwtSecret,
        entity: 'user',
        entityId: 'user_id',
        service: 'users',
        authStrategies: ['jwt'],
        jwtOptions: {
          audience: RUNTIME_JWT_AUDIENCE,
          issuer: RUNTIME_JWT_ISSUER,
          algorithm: 'HS256',
        },
      });
      const authentication = new AuthenticationService(app);
      authentication.register(
        'jwt',
        new RuntimeJWTStrategy({
          db,
          multiTenancy,
          sessionTokenService: tokenService,
          executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(app),
        })
      );
      app.use('authentication', authentication);
      app.use('tasks', new TasksService(db, app), {
        methods: [...TASKS_SERVICE_TRANSPORT_METHODS],
      });
      app.use('sessions', { get: (id: string) => new SessionRepository(db).findById(id) });
      const requireAccess = createTenantRestrictedAuthHook(
        authenticate('jwt') as never,
        multiTenancy,
        (id, context) => assertRuntimeTenantRequestAccess(db, id, context)
      );
      for (const path of ['tasks', 'sessions'])
        app.service(path).hooks({
          around: {
            all: [
              async (context: HookContext, next: () => Promise<void>) => {
                await requireAccess(context);
                await runWithTenantDatabaseScope(db, context.params.tenant!.tenant_id, next);
              },
            ],
          },
        });
      const socketConfig = createSocketIOConfig(app as never, {
        corsOrigin: '*',
        credentialsAllowed: false,
        workIdentity: { instanceId: 'socket-safety', bootId: 'socket-safety-boot' },
        multiTenancy,
        assertTenantAccess: (id) => assertRuntimeTenantAccess(db, id),
        assertTenantCredential: (id, payload) => assertTenantCredentialEpoch(db, id, payload),
      });
      app.configure(socketio(socketConfig.serverOptions, socketConfig.callback));
      configureChannels(app as never);
      let server: HttpServer | undefined;
      let client: AgorClient | undefined;
      try {
        server = await new Promise<HttpServer>((resolve) => {
          const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture address');
        client = createClient(`http://127.0.0.1:${address.port}`, false, {
          reconnectionAttempts: 0,
          ackTimeout: 2_000,
        });
        client.io.auth = { token };
        const connect = async () => {
          const connected = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('Executor socket connect timed out')),
              3_000
            );
            client!.io.once('connect', () => {
              clearTimeout(timeout);
              resolve();
            });
            client!.io.once('connect_error', (error) => {
              clearTimeout(timeout);
              reject(error);
            });
          });
          client!.io.connect();
          await connected;
        };
        await connect();
        await applyTenantRestrictionIntent(raw, tenantId, {
          version: 1,
          controllerId: 'controller',
          placementId: 'placement',
          operationId: 'suspend',
          revision: 1,
          action: 'restrict',
        });
        const params = {
          user: seeded.user,
          tenant: { tenant_id: tenantId, source: 'explicit' },
        } as never;
        const input = {
          app,
          taskId: seeded.task.task_id,
          cause: 'authorization_revoked' as const,
          errorMessage: 'Tenant restricted',
          params,
          runInFreshTenantWriteDatabase: <T>(work: () => Promise<T>) =>
            withFreshTenantWrite(db, tenantId, work),
        };
        await beginExecutorTermination(input);
        await expect(client.service('tasks').get(seeded.task.task_id)).rejects.toMatchObject({
          code: 403,
        });
        const control = await client
          .service('tasks')
          .getTerminationState({ task_id: seeded.task.task_id });
        expect(control.status).toBe(TaskStatus.STOPPING);
        expect(JSON.stringify(control)).not.toContain('must not appear');
        await expect(
          client.service('tasks').getTerminationState({ task_id: seeded.queued.task_id })
        ).rejects.toMatchObject({ code: 403 });
        expect(client.io.connected).toBe(true);
        await applyTenantRestrictionIntent(raw, tenantId, {
          version: 1,
          controllerId: 'controller',
          placementId: 'placement',
          operationId: 'reactivate',
          revision: 2,
          action: 'prepare_release',
        });
        await applyTenantRestrictionIntent(raw, tenantId, {
          version: 1,
          controllerId: 'controller',
          placementId: 'placement',
          operationId: 'reactivate',
          revision: 2,
          action: 'activate',
        });
        // Even if the socket survives the whole cycle, old ordinary authority
        // cannot revive; exact Stop recovery must still work after reconnect.
        await expect(client.service('tasks').get(seeded.task.task_id)).rejects.toMatchObject({
          code: 403,
        });
        client.io.disconnect();
        await connect();
        await expect(
          client.service('tasks').reportTerminationComplete({
            task_id: seeded.queued.task_id,
            requested_at: control.termination_request!.requested_at,
          })
        ).rejects.toMatchObject({ code: 403 });
        await expect(
          client.service('tasks').reportTerminationComplete({
            task_id: seeded.task.task_id,
            requested_at: '2000-01-01T00:00:00.000Z',
          })
        ).rejects.toThrow();
        expect(
          await runWithTenantDatabaseScope(
            raw,
            tenantId,
            async (scoped) =>
              (await new TaskRepository(scoped).findById(seeded.task.task_id))?.termination_request
                ?.executor_quiesced_at
          )
        ).toBeUndefined();
        // This is a real signed/durable executor reconnect and acknowledgement;
        // SDK/process exit itself remains simulated, not containment certification.
        await client.service('tasks').reportTerminationComplete({
          task_id: seeded.task.task_id,
          requested_at: control.termination_request!.requested_at,
        });
        await expect
          .poll(() =>
            runWithTenantDatabaseScope(
              raw,
              tenantId,
              async (scoped) =>
                !!(await new TaskRepository(scoped).findById(seeded.task.task_id))
                  ?.termination_request?.executor_quiesced_at
            )
          )
          .toBe(true);
      } finally {
        client?.io.close();
        if (server)
          await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve()))
          );
      }
    });

    it('answers a browser socket and REST call on a closed tenant with the stable code', async () => {
      // Packet 05 gave tenant admission a stable code, but every JWT path
      // checks the credential generation first, so a browser never reached it:
      // a suspended workspace looked exactly like an expired session. This is
      // the real signed handshake and the real REST body for that member.
      const tenantId = `browser-restricted-${generateId()}`;
      const seeded = await seedTenant(tenantId);
      const jwtSecret = 'disposable-restricted-browser-secret';
      const app = feathersExpress(feathers());
      app.set('config', {});
      app.set('distributedWorkIdentity', {
        instanceId: 'browser-restricted',
        bootId: 'browser-restricted-boot',
      });
      const multiTenancy = {
        mode: 'required_from_auth',
        static_tenant_id: 'unused' as never,
        auth_claim: 'tenant_id',
      } as const;
      app.configure(rest());
      app.use('users', {
        async get(id: string, params: { tenant?: { tenant_id: string } }) {
          if (!params.tenant?.tenant_id) throw new Error('Missing authenticated tenant');
          return runWithTenantDatabaseScope(db, params.tenant.tenant_id, (scoped) =>
            new UsersRepository(scoped).findById(id as never)
          );
        },
      });
      app.set('authentication', {
        secret: jwtSecret,
        entity: 'user',
        entityId: 'user_id',
        service: 'users',
        authStrategies: ['jwt'],
        jwtOptions: {
          audience: RUNTIME_JWT_AUDIENCE,
          issuer: RUNTIME_JWT_ISSUER,
          algorithm: 'HS256',
        },
      });
      const authentication = new AuthenticationService(app);
      authentication.register('jwt', new RuntimeJWTStrategy({ db, multiTenancy }));
      app.use('authentication', authentication);
      app.use('sessions', { get: (id: string) => new SessionRepository(db).findById(id) });
      const requireAccess = createTenantRestrictedAuthHook(
        authenticate('jwt') as never,
        multiTenancy,
        (id, context) => assertRuntimeTenantRequestAccess(db, id, context)
      );
      app.service('sessions').hooks({
        around: {
          all: [
            async (context: HookContext, next: () => Promise<void>) => {
              await requireAccess(context);
              await runWithTenantDatabaseScope(db, context.params.tenant!.tenant_id, next);
            },
          ],
        },
      });
      const socketConfig = createSocketIOConfig(app as never, {
        corsOrigin: '*',
        credentialsAllowed: false,
        workIdentity: { instanceId: 'browser-restricted', bootId: 'browser-restricted-boot' },
        multiTenancy,
        assertTenantAccess: (id) => assertRuntimeTenantAccess(db, id),
        assertTenantCredential: (id, payload) => assertTenantCredentialEpoch(db, id, payload),
      });
      app.configure(socketio(socketConfig.serverOptions, socketConfig.callback));
      configureChannels(app as never);
      // Feathers types app.use as a service path; this is Express middleware.
      (app as unknown as { use: (middleware: unknown) => void }).use(
        errorHandler({ logger: false })
      );

      const mintToken = async () =>
        issueRuntimeTokenPair(seeded.user, jwtSecret, '1h', '1h', {
          tenant_id: tenantId,
          ...authCredentialGenerationClaim(seeded.user),
          ...authTokenIssuedAtClaim(Date.now(), seeded.user),
          ...tenantCredentialEpochClaims(await readTenantCredentialEpoch(db, tenantId)),
        }).accessToken;
      const restore = (revision: number, action: 'restrict' | 'prepare_release' | 'activate') =>
        applyTenantRestrictionIntent(raw, tenantId, {
          version: 1,
          controllerId: 'controller',
          placementId: 'placement',
          operationId: action === 'restrict' ? 'suspend' : 'reactivate',
          revision,
          action,
        });

      let server: HttpServer | undefined;
      let client: AgorClient | undefined;
      try {
        server = await new Promise<HttpServer>((resolve) => {
          const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture address');
        const origin = `http://127.0.0.1:${address.port}`;
        const restSession = async (token: string) => {
          const response = await fetch(`${origin}/sessions/${seeded.session.session_id}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          return { status: response.status, body: await response.json() };
        };
        client = createClient(origin, false, { reconnectionAttempts: 0, ackTimeout: 2_000 });
        const handshake = async (token: string) => {
          client!.io.auth = { token };
          const settled = new Promise<Error | undefined>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Handshake timed out')), 5_000);
            client!.io.once('connect', () => {
              clearTimeout(timeout);
              resolve(undefined);
            });
            client!.io.once('connect_error', (error) => {
              clearTimeout(timeout);
              resolve(error);
            });
          });
          client!.io.connect();
          const outcome = await settled;
          client!.io.disconnect();
          return outcome as (Error & { data?: Record<string, unknown> }) | undefined;
        };

        const open = await mintToken();
        expect(await handshake(open)).toBeUndefined();
        expect((await restSession(open)).status).toBe(200);

        await restore(1, 'restrict');
        // Socket.IO preserves a middleware error's `data` on connect_error, so
        // the browser reads the same code on both transports. No status or
        // class rides along: those are the client's cue to rotate a credential
        // that is perfectly good.
        expect((await handshake(open))?.data).toEqual({ code: 'tenant_restricted' });
        const closedRest = await restSession(open);
        expect(closedRest.status).toBe(401);
        expect(closedRest.body.data).toEqual({ code: 'tenant_restricted' });
        // The code is the entire disclosure.
        expect(JSON.stringify(closedRest.body)).not.toMatch(
          /controller|placement|revision|phase|suspend/i
        );

        await restore(2, 'prepare_release');
        expect((await handshake(open))?.data).toEqual({ code: 'tenant_restricted' });

        await restore(2, 'activate');
        // The workspace is open, but the generation moved: the parked tab's
        // credential is now genuinely stale, so it gets the plain rejection
        // that makes the browser fail over to sign-in.
        const stale = await handshake(open);
        expect(stale?.data).toEqual({ code: 401, className: 'not-authenticated' });
        const staleRest = await restSession(open);
        expect(staleRest.status).toBe(401);
        expect(staleRest.body.data).toBeUndefined();
        // And a fresh sign-in works.
        const reissued = await mintToken();
        expect(await handshake(reissued)).toBeUndefined();
        expect((await restSession(reissued)).status).toBe(200);
      } finally {
        client?.io.close();
        if (server)
          await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve()))
          );
      }
    });

    it('rejects old signed refresh and JWT re-login after reactivation without laundering epochs', async () => {
      const tenantId = `epoch-${generateId()}`;
      const seeded = await seedTenant(tenantId);
      const secret = 'tenant-epoch-test-secret';
      const claims = {
        tenant_id: tenantId,
        ...authCredentialGenerationClaim(seeded.user),
        ...authTokenIssuedAtClaim(Date.now(), seeded.user),
      };
      const old = issueRuntimeTokenPair(seeded.user, secret, '1h', '1h', claims);
      const usersService = { get: vi.fn(async () => seeded.user) };
      const refresh = createRefreshTokenService({
        db,
        jwtSecret: secret,
        accessTokenTtl: '1h',
        refreshTokenTtl: '1h',
        usersService,
      });
      await expect(refresh.create({ refreshToken: old.refreshToken })).resolves.toHaveProperty(
        'accessToken'
      );
      const command = {
        version: 1 as const,
        controllerId: 'controller',
        placementId: 'placement',
        operationId: 'suspend',
        revision: 1,
        action: 'restrict' as const,
      };
      await applyTenantRestrictionIntent(raw, tenantId, command);
      // Refusal, with the closed-workspace code preserved through the
      // service's generic catch: the holder of this signed refresh token is
      // already entitled to that fact, and the browser needs it to tell a
      // suspended workspace from a dead session.
      await expect(refresh.create({ refreshToken: old.refreshToken })).rejects.toMatchObject({
        code: 401,
        data: { code: 'tenant_restricted' },
      });
      await applyTenantRestrictionIntent(raw, tenantId, {
        ...command,
        operationId: 'reactivate',
        revision: 2,
        action: 'prepare_release',
      });
      await applyTenantRestrictionIntent(raw, tenantId, {
        ...command,
        operationId: 'reactivate',
        revision: 2,
        action: 'activate',
      });
      usersService.get.mockClear();
      // Reopened, but this credential's generation is now genuinely stale, so
      // the rejection carries no code and the browser falls over to sign-in.
      const released = await refresh
        .create({ refreshToken: old.refreshToken })
        .catch((error) => error);
      expect(released).toMatchObject({ code: 401 });
      expect(released.data).toBeUndefined();
      expect(usersService.get).not.toHaveBeenCalled();
      const oldPayload = jwt.verify(old.accessToken, secret);
      const staleAccess = await assertTenantCredentialEpoch(db, tenantId, oldPayload).catch(
        (error) => error
      );
      expect(staleAccess).toMatchObject({ code: 401 });
      expect(staleAccess.data).toBeUndefined();
      const hook = createIssueBrowserTokensHook({
        db,
        jwtSecret: secret,
        accessTokenTtl: '1h',
        refreshTokenTtl: '1h',
        tenantClaim: 'tenant_id',
      });
      await expect(
        hook({
          params: { tenant: { tenant_id: tenantId } },
          result: { user: seeded.user, authentication: { strategy: 'jwt', payload: oldPayload } },
        })
      ).rejects.toMatchObject({ code: 401 });
      const commandTokens = new SessionTokenService(
        { expiration_ms: 60_000, max_uses: -1 },
        { db, startCleanupTimer: false }
      );
      commandTokens.setJwtSecret(secret);
      const ordinaryCommand = await runWithTenantDatabaseScope(raw, tenantId, () =>
        commandTokens.generateCommandToken(
          'branch-files-read',
          seeded.user.user_id,
          seeded.branch.branch_id
        )
      );
      await expect(
        assertTenantCredentialEpoch(db, tenantId, jwt.verify(ordinaryCommand, secret))
      ).resolves.toBeDefined();
      for (const [path, commandId, data] of [
        [
          BRANCH_CLEANUP_REPORT_SERVICE,
          branchCleanupCommandId('invocation'),
          { action: 'claim', execution_id: 'invocation' },
        ],
        [
          BRANCH_DELETION_REPORT_SERVICE,
          branchDeletionCommandId('invocation'),
          { action: 'claim', execution_id: 'invocation' },
        ],
        [
          ENVIRONMENT_COMMAND_REPORT_SERVICE,
          environmentCommandTokenId('start', 'attempt'),
          { kind: 'claim', action: 'start', attempt_id: 'attempt' },
        ],
      ] as const) {
        const token = await runWithTenantDatabaseScope(raw, tenantId, () =>
          commandTokens.generateCommandToken(
            commandId,
            seeded.user.user_id,
            seeded.branch.branch_id
          )
        );
        // Real signed issuance + PostgreSQL admission; the lifecycle service's
        // durable command/operation schema checks are covered separately.
        await expect(
          assertRuntimeTenantRequestAccess(db, tenantId, {
            path,
            method: 'create',
            data: { ...data, branch_id: seeded.branch.branch_id },
            params: {
              provider: 'socketio',
              tenant: { tenant_id: tenantId },
              user: seeded.user,
              authentication: { strategy: 'jwt', payload: jwt.verify(token, secret) },
            },
          } as unknown as HookContext)
        ).resolves.toBeUndefined();
      }
      const epoch = await readTenantCredentialEpoch(db, tenantId);
      const fresh = issueRuntimeTokenPair(seeded.user, secret, '1h', '1h', {
        ...claims,
        ...tenantCredentialEpochClaims(epoch),
      });
      const renewed = await refresh.create({ refreshToken: fresh.refreshToken });
      await expect(
        assertTenantCredentialEpoch(db, tenantId, jwt.verify(renewed.accessToken, secret))
      ).resolves.toBe(epoch);
      const freshLogin = await hook({
        params: { tenant: { tenant_id: tenantId } },
        result: { user: seeded.user, authentication: { strategy: 'local' } },
      });
      await expect(
        assertTenantCredentialEpoch(db, tenantId, jwt.verify(freshLogin.result.accessToken, secret))
      ).resolves.toBe(epoch);
      // A transition after refresh validation cannot silently upgrade the
      // issued token to the new generation, even across independent awaits.
      usersService.get.mockImplementationOnce(async () => {
        await applyTenantRestrictionIntent(raw, tenantId, {
          ...command,
          operationId: 'suspend-again',
          revision: 3,
        });
        await expect(
          runWithTenantDatabaseScope(raw, tenantId, () =>
            commandTokens.generateCommandToken(
              'branch-files-read',
              seeded.user.user_id,
              seeded.branch.branch_id
            )
          )
        ).rejects.toMatchObject({ code: 401 });
        const safety = await runWithTenantDatabaseScope(raw, tenantId, () =>
          commandTokens.generateCommandToken(
            'environment.stop:recovery',
            seeded.user.user_id,
            seeded.branch.branch_id,
            undefined,
            undefined,
            'safety-recovery'
          )
        );
        expect(jwt.verify(safety, secret)).toMatchObject({ purpose: 'executor-command' });

        await applyTenantRestrictionIntent(raw, tenantId, {
          ...command,
          operationId: 'reactivate-again',
          revision: 4,
          action: 'prepare_release',
        });
        await applyTenantRestrictionIntent(raw, tenantId, {
          ...command,
          operationId: 'reactivate-again',
          revision: 4,
          action: 'activate',
        });
        return seeded.user;
      });
      const raced = await refresh.create({ refreshToken: fresh.refreshToken });
      await expect(
        assertTenantCredentialEpoch(db, tenantId, jwt.verify(ordinaryCommand, secret))
      ).rejects.toMatchObject({ code: 401 });
      await expect(
        assertTenantCredentialEpoch(db, tenantId, jwt.verify(raced.accessToken, secret))
      ).rejects.toMatchObject({ code: 401 });
      const neighbor = `epoch-neighbor-${generateId()}`;
      await expect(assertTenantCredentialEpoch(db, neighbor, {})).resolves.toBeUndefined();
    });

    it('preserves real coordinator Stop and exact executor acknowledgement while ordinary access is denied', async () => {
      const tenantId = `safety-${generateId()}`;
      const seeded = await seedTenant(tenantId);
      const neighborId = `safety-neighbor-${generateId()}`;
      const neighbor = await seedTenant(neighborId);
      const app = feathers();
      app.set('config', {});
      app.set('distributedWorkIdentity', { instanceId: 'safety-test', bootId: 'boot-test' });
      app.use('tasks', new TasksService(db, app), {
        methods: [...TASKS_SERVICE_TRANSPORT_METHODS],
      });
      app.use('sessions', { get: (id: string) => new SessionRepository(db).findById(id) });
      const hook = createTenantRestrictedAuthHook(
        async (ctx) => ctx,
        { mode: 'static', static_tenant_id: tenantId as never },
        (id, ctx) => assertRuntimeTenantRequestAccess(db, id, ctx)
      );
      for (const path of ['tasks', 'sessions'])
        app.service(path).hooks({
          around: {
            all: [
              async (_ctx: unknown, next: () => Promise<void>) =>
                runWithTenantDatabaseScope(db, tenantId, next),
            ],
          },
          before: { all: [hook as never] },
        });
      const params = {
        user: seeded.user,
        tenant: { tenant_id: tenantId, source: 'explicit' },
      } as never;
      const racingEnqueues = [1, 2, 3].map((n) =>
        runWithTenantDatabaseScope(raw, tenantId, async (scoped) => {
          return new TaskRepository(scoped).createPending({
            session_id: seeded.session.session_id,
            created_by: seeded.user.user_id,
            full_prompt: `racing prompt ${n}`,
            status: TaskStatus.QUEUED,
          });
        })
      );
      const restrict = applyTenantRestrictionIntent(raw, tenantId, {
        version: 1,
        controllerId: 'controller',
        placementId: 'placement',
        operationId: 'suspend',
        revision: 1,
        action: 'restrict',
      });
      const outcomes = await Promise.allSettled(racingEnqueues);
      await restrict;
      await runWithTenantDatabaseScope(raw, tenantId, async (scoped) => {
        const tasks = new TaskRepository(scoped);
        for (const outcome of outcomes) {
          if (outcome.status === 'fulfilled') {
            expect(
              (await tasks.findById(outcome.value.task_id))?.tenant_restriction_hold?.reason
            ).toBe('tenant_restricted');
          }
        }
        expect(await tasks.getNextQueued(seeded.session.session_id)).toBeNull();
      });
      await expect(app.service('tasks').get(seeded.task.task_id, params)).rejects.toMatchObject({
        code: 403,
      });
      const executorParams = {
        ...params,
        provider: 'rest',
        authentication: {
          strategy: 'jwt',
          payload: {
            type: 'executor-session',
            purpose: 'executor-task',
            tenant_id: tenantId,
            session_id: seeded.session.session_id,
            task_id: seeded.task.task_id,
            branch_id: seeded.branch.branch_id,
          },
        },
      };
      const observed = await app.service('tasks').reportSdkHealthFailure(
        {
          task_id: seeded.task.task_id,
          reason: 'unknown_activity',
          watchdog_action: 'would_fire',
        },
        executorParams
      );
      expect(observed.sdk_failure?.watchdog_action).toBe('would_fire');
      await runWithTenantDatabaseScope(raw, tenantId, async (scoped) => {
        const tasks = new TaskRepository(scoped);
        expect((await tasks.findById(seeded.queued.task_id))?.tenant_restriction_hold?.reason).toBe(
          'tenant_restricted'
        );
        expect(await tasks.getNextQueued(seeded.session.session_id)).toBeNull();
        await expect(
          tasks.createPending({
            session_id: seeded.session.session_id,
            created_by: seeded.user.user_id,
            full_prompt: 'must not enqueue',
            status: TaskStatus.QUEUED,
          })
        ).rejects.toThrow();
      });
      const input = {
        app,
        taskId: seeded.task.task_id,
        cause: 'tenant_suspension' as const,
        errorMessage: 'Tenant restricted',
        params,
        runInFreshTenantWriteDatabase: <T>(work: () => Promise<T>) =>
          withFreshTenantWrite(db, tenantId, work),
      };
      const observer = new TenantRestrictionReconciler(db, app as never);
      expect((await observer.checkOnce()).stopping).toBe(1);
      expect(
        await runWithTenantDatabaseScope(
          raw,
          tenantId,
          async (scoped) =>
            (await new TaskRepository(scoped).findById(seeded.task.task_id))?.termination_request
              ?.cause
        )
      ).toBe('tenant_suspension');
      expect(
        await runWithTenantDatabaseScope(
          raw,
          neighborId,
          async (scoped) =>
            (await new TaskRepository(scoped).findById(neighbor.task.task_id))?.status
        )
      ).toBe(TaskStatus.RUNNING);
      const stopping = await runWithTenantDatabaseScope(raw, tenantId, (scoped) =>
        new TaskRepository(scoped).findById(seeded.task.task_id)
      );
      expect(stopping?.status).toBe(TaskStatus.STOPPING);
      const control = await app
        .service('tasks')
        .getTerminationState({ task_id: seeded.task.task_id }, executorParams);
      expect(Object.keys(control).sort()).toEqual(['status', 'task_id', 'termination_request']);
      expect(Object.keys(control.termination_request).sort()).toEqual(['cause', 'requested_at']);
      await expect(
        app.service('tasks').getTerminationState({ task_id: generateId() }, executorParams)
      ).rejects.toMatchObject({ code: 403 });
      // The executor's SDK stop is simulated; durable acknowledgement and the
      // actual runtime coordinator/Feathers/database path are real.
      await app
        .service('tasks')
        .reportTerminationComplete(
          { task_id: seeded.task.task_id, requested_at: control.termination_request.requested_at },
          executorParams
        );
      await requestExecutorTermination(input);
      // Acknowledgement schedules post-commit recovery. It can win the
      // coordination lease before our explicit retry, which then returns
      // pending; observe durable settlement rather than assuming ownership.
      await expect
        .poll(async () =>
          runWithTenantDatabaseScope(raw, tenantId, async (scoped) => {
            const task = await new TaskRepository(scoped).findById(seeded.task.task_id);
            return {
              status: task?.status,
              quiesced: !!task?.termination_request?.executor_quiesced_at,
            };
          })
        )
        .toEqual({ status: TaskStatus.STOPPED, quiesced: true });
      await expect(app.service('tasks').get(seeded.task.task_id, params)).rejects.toMatchObject({
        code: 403,
      });
      const release = {
        version: 1 as const,
        controllerId: 'controller',
        placementId: 'placement',
        operationId: 'release',
        revision: 2,
      };
      await applyTenantRestrictionIntent(raw, tenantId, { ...release, action: 'prepare_release' });
      await applyTenantRestrictionIntent(raw, tenantId, { ...release, action: 'activate' });
      await runWithTenantDatabaseScope(raw, tenantId, async (scoped) => {
        const tasks = new TaskRepository(scoped);
        await tasks.update(seeded.queued.task_id, {
          metadata: { source: 'test' },
          tenant_restriction_hold: undefined,
        });
        const held = await tasks.findById(seeded.queued.task_id);
        expect(held?.full_prompt).toBe('preserve this queued prompt');
        expect(
          (await tasks.findQueued(seeded.session.session_id)).some(
            (task) => task.task_id === seeded.queued.task_id
          )
        ).toBe(true);
        expect(held?.tenant_restriction_hold?.reason).toBe('tenant_restricted');
        expect(await tasks.getNextQueued(seeded.session.session_id)).toBeNull();
        expect(
          (
            await tasks.claimDispatchAndProjectSession(seeded.queued.task_id, TaskStatus.QUEUED, {
              status: TaskStatus.DISPATCHING,
            })
          ).outcome
        ).toBe('condition_changed');
        await expect(
          tasks.update(seeded.queued.task_id, { status: TaskStatus.RUNNING })
        ).rejects.toThrow('Held prompt');
        const fresh = await tasks.createPending({
          session_id: seeded.session.session_id,
          created_by: seeded.user.user_id,
          full_prompt: 'explicit new prompt',
          status: TaskStatus.QUEUED,
        });
        expect((await tasks.getNextQueued(seeded.session.session_id))?.task_id).toBe(fresh.task_id);
        // prepare_release itself is a legal closing transition from active.
        await applyTenantRestrictionIntent(scoped, tenantId, {
          ...release,
          operationId: 'prepare-again',
          revision: 3,
          action: 'prepare_release',
        });
        await applyTenantRestrictionIntent(scoped, tenantId, {
          ...release,
          operationId: 'prepare-again',
          revision: 3,
          action: 'activate',
        });
        expect((await tasks.findById(fresh.task_id))?.tenant_restriction_hold?.reason).toBe(
          'tenant_restricted'
        );
        expect(await tasks.getNextQueued(seeded.session.session_id)).toBeNull();
        const legacyId = generateId();
        await new SessionRepository(scoped).create({
          session_id: legacyId,
          branch_id: seeded.branch.branch_id,
          created_by: seeded.user.user_id,
          agentic_tool: 'codex',
          status: 'idle',
          scheduled_from_branch: true,
          scheduled_run_at: 1,
          custom_context: { scheduled_run: { rendered_prompt: 'old occurrence', run_index: 1 } },
        });
        await expect(
          tasks.createPending({
            task_id: legacyId,
            session_id: legacyId,
            created_by: seeded.user.user_id,
            full_prompt: 'old legacy occurrence',
            status: TaskStatus.QUEUED,
          })
        ).rejects.toThrow('predates tenant reactivation');
      });
    });

    it('blocks reads and writes until exact activation while a neighboring tenant remains usable', async () => {
      const tenantA = `access-a-${randomUUID()}`;
      const tenantB = `access-b-${randomUUID()}`;
      const base = {
        version: 1 as const,
        controllerId: 'controller',
        placementId: 'placement',
        operationId: 'suspend',
        revision: 1,
      };
      const authenticate = vi.fn(async (context: HookContext) => context);
      const hook = (tenantId: string) =>
        createTenantRestrictedAuthHook(
          authenticate,
          { mode: 'static', static_tenant_id: tenantId as never },
          (id) => assertRuntimeTenantAccess(db, id)
        );
      const context = (method: string) =>
        ({
          method,
          params: {
            provider: 'rest',
            user: { user_id: 'user', role: 'admin' },
            bypassRestriction: true,
          },
        }) as unknown as HookContext;
      await expect(hook(tenantA)(context('find'))).resolves.toBeDefined();
      await applyTenantRestrictionIntent(raw, tenantA, { ...base, action: 'restrict' });
      for (const method of ['find', 'get', 'create', 'patch', 'remove']) {
        await expect(hook(tenantA)(context(method))).rejects.toMatchObject({
          code: 403,
          message: 'Tenant access is restricted',
        });
        await expect(hook(tenantB)(context(method))).resolves.toBeDefined();
      }
      const release = { ...base, revision: 2, operationId: 'release' };
      await applyTenantRestrictionIntent(raw, tenantA, { ...release, action: 'prepare_release' });
      await expect(hook(tenantA)(context('get'))).rejects.toMatchObject({ code: 403 });
      await applyTenantRestrictionIntent(raw, tenantA, { ...release, action: 'activate' });
      await expect(hook(tenantA)(context('get'))).resolves.toBeDefined();
      await expect(
        applyTenantRestrictionIntent(raw, tenantA, { ...base, action: 'restrict' })
      ).rejects.toThrow();
      await expect(hook(tenantA)(context('get'))).resolves.toBeDefined();
    });
  }
);
