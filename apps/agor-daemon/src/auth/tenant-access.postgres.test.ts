/** Real PostgreSQL/RLS behind authenticated admission; SDK/process exit stays simulated, never containment proof. */
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
  readTenantRestrictionState,
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
  type TerminationInput,
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
import {
  assertRuntimeTenantAccess,
  assertRuntimeTenantRequestAccess,
  readRequestTenantRestriction,
} from './tenant-access.js';
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

    type IntentAction = 'restrict' | 'prepare_release' | 'activate';
    const intent = (
      tenantId: string,
      revision: number,
      action: IntentAction,
      database: Parameters<typeof applyTenantRestrictionIntent>[0] = raw
    ) =>
      applyTenantRestrictionIntent(database, tenantId, {
        version: 1,
        controllerId: 'controller',
        placementId: 'placement',
        operationId: `operation-${revision}`,
        revision,
        action,
      });
    const release = async (
      tenantId: string,
      revision: number,
      database: Parameters<typeof applyTenantRestrictionIntent>[0] = raw
    ) => {
      await intent(tenantId, revision, 'prepare_release', database);
      await intent(tenantId, revision, 'activate', database);
    };
    const findTask = (tenantId: string, taskId: string) =>
      runWithTenantDatabaseScope(raw, tenantId, (scoped) =>
        new TaskRepository(scoped).findById(taskId)
      );
    const terminationInput = (
      app: unknown,
      tenantId: string,
      taskId: string,
      cause: TerminationInput['cause'],
      params: unknown
    ): TerminationInput => ({
      app: app as TerminationInput['app'],
      taskId,
      cause,
      errorMessage: 'Tenant restricted',
      params: params as TerminationInput['params'],
      runInFreshTenantWriteDatabase: <T>(work: () => Promise<T>) =>
        withFreshTenantWrite(db, tenantId, work),
    });
    // Settles one handshake: undefined when accepted, otherwise the connect_error.
    const handshake = (client: AgorClient, token: string) => {
      client.io.auth = { token };
      const settled = new Promise<(Error & { data?: Record<string, unknown> }) | undefined>(
        (resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Handshake timed out')), 5_000);
          client.io.once('connect', () => {
            clearTimeout(timeout);
            resolve(undefined);
          });
          client.io.once('connect_error', (error) => {
            clearTimeout(timeout);
            resolve(error);
          });
        }
      );
      client.io.connect();
      return settled;
    };
    const socketClient = (origin: string) =>
      createClient(origin, false, { reconnectionAttempts: 0, ackTimeout: 2_000 });

    const multiTenancy = {
      mode: 'required_from_auth',
      static_tenant_id: 'unused' as never,
      auth_claim: 'tenant_id',
    } as const;
    type FixtureApp = ReturnType<typeof feathersExpress>;
    // Production admission wiring: signed JWT strategy, restricted hook, socket admission and monitor.
    const startAdmissionApp = async (input: {
      name: string;
      jwtSecret: string;
      rest?: boolean;
      strategy?: (app: FixtureApp) => ConstructorParameters<typeof RuntimeJWTStrategy>[0];
      services: (app: FixtureApp) => string[];
    }) => {
      const app = feathersExpress(feathers());
      const workIdentity = { instanceId: input.name, bootId: `${input.name}-boot` };
      app.set('config', {});
      app.set('distributedWorkIdentity', workIdentity);
      if (input.rest) app.configure(rest());
      app.use('users', {
        async get(id: string, params: { tenant?: { tenant_id: string } }) {
          if (!params.tenant?.tenant_id) throw new Error('Missing authenticated tenant');
          return runWithTenantDatabaseScope(db, params.tenant.tenant_id, (scoped) =>
            new UsersRepository(scoped).findById(id as never)
          );
        },
      });
      app.set('authentication', {
        secret: input.jwtSecret,
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
        new RuntimeJWTStrategy({ db, multiTenancy, ...input.strategy?.(app) })
      );
      app.use('authentication', authentication);
      const requireAccess = createTenantRestrictedAuthHook(
        authenticate('jwt') as never,
        multiTenancy,
        (id, context) => assertRuntimeTenantRequestAccess(db, id, context)
      );
      for (const path of input.services(app))
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
        workIdentity,
        multiTenancy,
        assertTenantAccess: (id, payload) =>
          assertRuntimeTenantAccess(db, id, { payload }, readRequestTenantRestriction),
        readTenantRestriction: (id) => readTenantRestrictionState(db, id),
      });
      app.configure(socketio(socketConfig.serverOptions, socketConfig.callback));
      configureChannels(app as never);
      // Feathers types app.use as a service path; this is Express middleware.
      if (input.rest)
        (app as unknown as { use: (middleware: unknown) => void }).use(
          errorHandler({ logger: false })
        );
      const server = await new Promise<HttpServer>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      return {
        app,
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          ),
      };
    };

    it('keeps signed executor Socket.IO safety RPCs and reconnect while denying ordinary/foreign RPCs', async () => {
      const tenantId = `socket-safety-${generateId()}`;
      const seeded = await seedTenant(tenantId);
      const jwtSecret = 'disposable-restricted-executor-socket-secret';
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
      const started = await startAdmissionApp({
        name: 'socket-safety',
        jwtSecret,
        strategy: (app) => ({
          sessionTokenService: tokenService,
          executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(app),
        }),
        services: (app) => {
          app.use('tasks', new TasksService(db, app), {
            methods: [...TASKS_SERVICE_TRANSPORT_METHODS],
          });
          app.use('sessions', { get: (id: string) => new SessionRepository(db).findById(id) });
          return ['tasks', 'sessions'];
        },
      });
      const { app } = started;
      let client: AgorClient | undefined;
      try {
        client = socketClient(started.origin);
        expect(await handshake(client, token)).toBeUndefined();
        await intent(tenantId, 1, 'restrict');
        const params = { user: seeded.user, tenant: { tenant_id: tenantId, source: 'explicit' } };
        await beginExecutorTermination(
          terminationInput(app, tenantId, seeded.task.task_id, 'authorization_revoked', params)
        );
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
        await release(tenantId, 2);
        // A socket surviving the cycle cannot revive ordinary authority; exact Stop still works after reconnect.
        await expect(client.service('tasks').get(seeded.task.task_id)).rejects.toMatchObject({
          code: 403,
        });
        client.io.disconnect();
        expect(await handshake(client, token)).toBeUndefined();
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
          (await findTask(tenantId, seeded.task.task_id))?.termination_request?.executor_quiesced_at
        ).toBeUndefined();
        await client.service('tasks').reportTerminationComplete({
          task_id: seeded.task.task_id,
          requested_at: control.termination_request!.requested_at,
        });
        await expect
          .poll(
            async () =>
              !!(await findTask(tenantId, seeded.task.task_id))?.termination_request
                ?.executor_quiesced_at
          )
          .toBe(true);
      } finally {
        client?.io.close();
        await started.close();
      }
    });

    it('answers a browser socket and REST call on a closed tenant with the stable code', async () => {
      // Every JWT path checks the credential generation first, so the code must survive it on both transports.
      const tenantId = `browser-restricted-${generateId()}`;
      const seeded = await seedTenant(tenantId);
      const jwtSecret = 'disposable-restricted-browser-secret';
      const started = await startAdmissionApp({
        name: 'browser-restricted',
        jwtSecret,
        rest: true,
        services: (app) => {
          app.use('sessions', { get: (id: string) => new SessionRepository(db).findById(id) });
          return ['sessions'];
        },
      });

      const mintToken = async () =>
        issueRuntimeTokenPair(seeded.user, jwtSecret, '1h', '1h', {
          tenant_id: tenantId,
          ...authCredentialGenerationClaim(seeded.user),
          ...authTokenIssuedAtClaim(Date.now(), seeded.user),
          ...tenantCredentialEpochClaims(await readTenantCredentialEpoch(db, tenantId)),
        }).accessToken;

      let client: AgorClient | undefined;
      try {
        const { origin } = started;
        const restSession = async (token: string) => {
          const response = await fetch(`${origin}/sessions/${seeded.session.session_id}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          return { status: response.status, body: await response.json() };
        };
        client = socketClient(origin);
        const probe = async (token: string) => {
          const outcome = await handshake(client!, token);
          client!.io.disconnect();
          return outcome;
        };

        const open = await mintToken();
        expect(await probe(open)).toBeUndefined();
        expect((await restSession(open)).status).toBe(200);

        await intent(tenantId, 1, 'restrict');
        // Only the code rides along; a status or class would cue the client to rotate a good credential.
        expect((await probe(open))?.data).toEqual({ code: 'tenant_restricted' });
        const closedRest = await restSession(open);
        expect(closedRest.status).toBe(401);
        expect(closedRest.body.data).toEqual({ code: 'tenant_restricted' });
        // The code is the entire disclosure.
        expect(JSON.stringify(closedRest.body)).not.toMatch(
          /controller|placement|revision|phase|suspend/i
        );

        await intent(tenantId, 2, 'prepare_release');
        expect((await probe(open))?.data).toEqual({ code: 'tenant_restricted' });

        await intent(tenantId, 2, 'activate');
        // Open again, but the generation moved: the parked credential gets the plain rejection.
        const stale = await probe(open);
        expect(stale?.data).toEqual({ code: 401, className: 'not-authenticated' });
        const staleRest = await restSession(open);
        expect(staleRest.status).toBe(401);
        expect(staleRest.body.data).toBeUndefined();
        // And a fresh sign-in works.
        const reissued = await mintToken();
        expect(await probe(reissued)).toBeUndefined();
        expect((await restSession(reissued)).status).toBe(200);
      } finally {
        client?.io.close();
        await started.close();
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
      await intent(tenantId, 1, 'restrict');
      // The closed-workspace code survives the service's generic catch.
      await expect(refresh.create({ refreshToken: old.refreshToken })).rejects.toMatchObject({
        code: 401,
        data: { code: 'tenant_restricted' },
      });
      await release(tenantId, 2);
      usersService.get.mockClear();
      // Reopened with a moved generation: the stale credential's rejection carries no code.
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
      const commandToken = (commandId: string, issuance?: 'safety-recovery') =>
        runWithTenantDatabaseScope(raw, tenantId, () =>
          commandTokens.generateCommandToken(
            commandId,
            seeded.user.user_id,
            seeded.branch.branch_id,
            undefined,
            undefined,
            issuance
          )
        );
      const ordinaryCommand = await commandToken('branch-files-read');
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
        const token = await commandToken(commandId);
        // Real signed issuance and admission; durable command schema checks are covered separately.
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
      // A transition after refresh validation never upgrades the issued token's generation.
      usersService.get.mockImplementationOnce(async () => {
        await intent(tenantId, 3, 'restrict');
        await expect(commandToken('branch-files-read')).rejects.toMatchObject({ code: 401 });
        const safety = await commandToken('environment.stop:recovery', 'safety-recovery');
        expect(jwt.verify(safety, secret)).toMatchObject({ purpose: 'executor-command' });
        await release(tenantId, 4);
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
        runWithTenantDatabaseScope(raw, tenantId, (scoped) =>
          new TaskRepository(scoped).createPending({
            session_id: seeded.session.session_id,
            created_by: seeded.user.user_id,
            full_prompt: `racing prompt ${n}`,
            status: TaskStatus.QUEUED,
          })
        )
      );
      const restrict = intent(tenantId, 1, 'restrict');
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
      const observer = new TenantRestrictionReconciler(db, app as never);
      expect((await observer.checkOnce()).stopping).toBe(1);
      const stopping = await findTask(tenantId, seeded.task.task_id);
      expect(stopping?.termination_request?.cause).toBe('tenant_suspension');
      expect(stopping?.status).toBe(TaskStatus.STOPPING);
      expect((await findTask(neighborId, neighbor.task.task_id))?.status).toBe(TaskStatus.RUNNING);
      const control = await app
        .service('tasks')
        .getTerminationState({ task_id: seeded.task.task_id }, executorParams);
      expect(Object.keys(control).sort()).toEqual(['status', 'task_id', 'termination_request']);
      expect(Object.keys(control.termination_request).sort()).toEqual(['cause', 'requested_at']);
      await expect(
        app.service('tasks').getTerminationState({ task_id: generateId() }, executorParams)
      ).rejects.toMatchObject({ code: 403 });
      await app
        .service('tasks')
        .reportTerminationComplete(
          { task_id: seeded.task.task_id, requested_at: control.termination_request.requested_at },
          executorParams
        );
      await requestExecutorTermination(
        terminationInput(app, tenantId, seeded.task.task_id, 'tenant_suspension', params)
      );
      // Post-commit recovery may win the lease before this retry, so observe durable settlement.
      await expect
        .poll(async () => {
          const task = await findTask(tenantId, seeded.task.task_id);
          return {
            status: task?.status,
            quiesced: !!task?.termination_request?.executor_quiesced_at,
          };
        })
        .toEqual({ status: TaskStatus.STOPPED, quiesced: true });
      await expect(app.service('tasks').get(seeded.task.task_id, params)).rejects.toMatchObject({
        code: 403,
      });
      await release(tenantId, 2);
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
        await release(tenantId, 3, scoped);
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
      await intent(tenantA, 1, 'restrict');
      for (const method of ['find', 'get', 'create', 'patch', 'remove']) {
        await expect(hook(tenantA)(context(method))).rejects.toMatchObject({
          code: 403,
          message: 'Tenant access is restricted',
        });
        await expect(hook(tenantB)(context(method))).resolves.toBeDefined();
      }
      await intent(tenantA, 2, 'prepare_release');
      await expect(hook(tenantA)(context('get'))).rejects.toMatchObject({ code: 403 });
      await intent(tenantA, 2, 'activate');
      await expect(hook(tenantA)(context('get'))).resolves.toBeDefined();
      await expect(intent(tenantA, 1, 'restrict')).rejects.toThrow();
      await expect(hook(tenantA)(context('get'))).resolves.toBeDefined();
    });
  }
);
