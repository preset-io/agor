/** Real service registration, tenant hooks, startup gates and authorized admission. */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgorConfig } from '@agor/core/config';
import {
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
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { TaskStatus } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerHooks } from './register-hooks.js';
import { registerServices } from './register-services.js';
import type { SessionTokenService } from './services/session-token-service.js';
import { assertRealtimePublishPolicyCoverage } from './utils/realtime-publish-policy.js';
import { assertTenantServiceClassification } from './utils/tenant-service-classification.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'registered managed OpenCode admission',
  () => {
    let raw: RawDatabase;
    let db: TenantScopeAwareDatabase;
    let root: string;

    beforeAll(async () => {
      vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-opencode-registration-master-secret');
      root = await mkdtemp(join(tmpdir(), 'opencode-registration-'));
      raw = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(raw);
      db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
    }, 60_000);

    afterAll(async () => {
      vi.unstubAllEnvs();
      await (raw as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end();
      await rm(root, { recursive: true, force: true });
    });

    it('boots the registered service and admits one verified owner Task through its hooks', async () => {
      const tenantId = `opencode-registration-${generateId()}`;
      const { userId, branchId, sessionId, taskId } = await runWithTenantDatabaseScope(
        db,
        tenantId,
        async (scoped) => {
          const user = await new UsersRepository(scoped).create({
            email: `${generateId()}@example.test`,
            name: 'OpenCode owner',
            role: 'admin',
            unix_username: `u_${randomBytes(8).toString('hex')}`,
          });
          const repo = await new RepoRepository(scoped).create({
            repo_id: generateId(),
            slug: `checkpoint-${generateId()}`,
            name: 'Checkpoint registration',
            repo_type: 'remote',
            remote_url: 'https://example.test/repo.git',
            local_path: '/tmp/checkpoint-registration',
            default_branch: 'main',
          });
          const branch = await new BranchRepository(scoped).create({
            branch_id: generateId(),
            repo_id: repo.repo_id,
            name: 'checkpoint',
            ref: 'main',
            branch_unique_id: 810_001,
            path: '/tmp/checkpoint-registration',
            created_by: user.user_id,
          });
          const session = await new SessionRepository(scoped).create({
            session_id: generateId(),
            branch_id: branch.branch_id,
            agentic_tool: 'opencode',
            created_by: user.user_id,
          });
          const tasks = new TaskRepository(scoped);
          const task = await tasks.create({
            task_id: generateId(),
            session_id: session.session_id,
            created_by: user.user_id,
            full_prompt: 'continue',
            status: TaskStatus.DISPATCHING,
            message_range: {
              start_index: 0,
              end_index: 0,
              start_timestamp: new Date().toISOString(),
            },
            git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
          });
          await tasks.bindExecutorLaunchAuthority(task.task_id);
          await tasks.connectExecutor(task.task_id);
          await tasks.stampManagedOpenCodeProtocol(task.task_id);
          return {
            userId: user.user_id,
            branchId: branch.branch_id,
            sessionId: session.session_id,
            taskId: task.task_id,
          };
        }
      );

      const helper = join(root, 'observer.mjs');
      await writeFile(
        helper,
        `let data='';process.stdin.on('data',x=>data+=x).on('end',()=>{const r=JSON.parse(data);const e=r.expected;const l=r.locator;process.stdout.write(JSON.stringify({version:1,action:'resolve',locator:{...l,tenantId:e.tenantId,ownerRuntimeUserId:e.ownerUserId,sessionId:e.sessionId,taskId:e.taskId,storeId:e.storeId,holderInstanceId:e.holderInstanceId,jobName:'job',jobUid:'job-uid',containerId:'containerd://test-container',restartCount:0,imageIdentity:'sha256:${'a'.repeat(64)}'}}))});`
      );
      const config = {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        execution: {
          unix_user_mode: 'delegated',
          executor_command_template: 'synthetic-launcher {tenant_id} {user_id} {unix_user}',
          executor_storage: { user_home: 'persistent-per-user' },
          opencode_native_state_observer: {
            command_template: `${process.execPath} ${JSON.stringify(helper)}`,
            timeout_ms: 3_000,
          },
        },
        agentic_tools: { opencode_hosted_native_state: 'checkpointed' },
      } as AgorConfig;
      const app = feathersExpress(feathers());
      app.configure(socketio());
      app.set('config', config);
      app.set('db', db);
      const secret = 'synthetic-opencode-registration-jwt';
      const registration = {
        app,
        db,
        config,
        jwtSecret: secret,
        daemonUrl: 'http://127.0.0.1',
        bundledUiAvailable: false,
        DAEMON_PORT: 3030,
        UI_PORT: 5173,
        allowSuperadmin: false,
        requireAuth: async (context: never) => context,
        deployment: { mode: 'standalone' as const },
      };
      const services = await registerServices(registration as never);
      registerHooks({
        ...registration,
        ...services,
        superadminOpts: { allowSuperadmin: false },
      } as never);
      expect(() => assertRealtimePublishPolicyCoverage(app)).not.toThrow();
      expect(() => assertTenantServiceClassification(app)).not.toThrow();

      const tokens = (app as unknown as { sessionTokenService: SessionTokenService })
        .sessionTokenService;
      tokens.setJwtSecret(secret);
      try {
        const token = await runWithTenantDatabaseScope(db, tenantId, () =>
          tokens.generateToken(sessionId, userId, { taskId, branchId })
        );
        const params = {
          provider: 'rest',
          authentication: {
            strategy: 'jwt',
            accessToken: token,
            payload: jwt.verify(token, secret),
          },
          tenant: { tenant_id: tenantId },
          user: { user_id: userId, role: 'admin' },
        };
        const input = {
          task_id: taskId,
          holder_instance_id: generateId(),
          locator: {
            runId: 'run-1',
            cellId: 'cell-1',
            namespace: 'tenant-ns',
            podName: 'executor-pod',
            podUid: 'pod-uid',
            containerName: 'executor',
          },
        };
        const nativeState = app.service('opencode-native-state') as never as {
          begin(input: unknown, params: unknown): Promise<{ outcome: string }>;
        };
        await expect(
          nativeState.begin(input, { ...params, tenant: { tenant_id: `${tenantId}-foreign` } })
        ).rejects.toThrow('Conflicting tenant identities');
        const grant = await nativeState.begin(input, params);
        expect(grant.outcome).toBe('admitted');
      } finally {
        tokens.close();
      }
    }, 30_000);
  }
);
