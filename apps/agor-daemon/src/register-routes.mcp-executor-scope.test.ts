import type { AgorConfig } from '@agor/core/config';
import { resolveMultiTenancyConfig, resolveSecurity } from '@agor/core/config';
import {
  BranchRepository,
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  generateId,
  initializeDatabase,
  MCPServerRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { authenticate, feathers, feathersExpress, rest, socketio } from '@agor/core/feathers';
import type { MCPServer, MCPServerID, UserID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { scopeExecutorRuntimeAuth } from './auth/executor-runtime-scope.js';
import { createRequireAuthHook } from './auth/require-auth.js';
import { issueRuntimeToken } from './auth/runtime-tokens.js';
import { registerHooks } from './register-hooks.js';
import { registerRoutes } from './register-routes.js';
import { registerServices } from './register-services.js';
import type { SessionTokenService } from './services/session-token-service.js';

describe('session MCP executor scope integration', () => {
  it('uses owner definitions with only the task creator OAuth identity and preserves mutation ownership', async () => {
    const tenantId = 'mcp-executor-scope-test';
    const jwtSecret = 'mcp-executor-scope-test-secret';
    const config = {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: tenantId },
      execution: {
        branch_rbac: false,
        allow_superadmin: false,
        unix_user_mode: 'simple',
        allow_web_terminal: false,
        daemon_writes_user_message: false,
        bootstrap_superadmin_users: [],
      },
    } satisfies AgorConfig;
    const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    const db = createTenantScopedDatabaseProxy(rawDb);
    const app = feathersExpress(feathers());
    const requireAuth = createRequireAuthHook(
      scopeExecutorRuntimeAuth(authenticate({ strategies: ['api-key', 'jwt'] })),
      resolveMultiTenancyConfig(config)
    );

    try {
      await initializeDatabase(rawDb);
      app.configure(rest());
      app.configure(socketio());
      app.set('database', db);
      app.set('config', config);
      app.set('distributedWorkIdentity', { instanceId: 'test-daemon', bootId: 'test-boot' });
      const services = await registerServices({
        db,
        app,
        config,
        jwtSecret,
        daemonUrl: 'http://localhost:3030',
        bundledUiAvailable: false,
        DAEMON_PORT: 3030,
        UI_PORT: 5173,
        branchRbacEnabled: false,
        allowSuperadmin: false,
        requireAuth,
        deployment: { mode: 'standalone' },
      });
      registerHooks({
        db,
        app,
        config,
        jwtSecret,
        branchRbacEnabled: false,
        requireAuth,
        superadminOpts: { allowSuperadmin: false },
        sessionsService: services.sessionsService,
        messagesService: services.messagesService,
        boardsService: services.boardsService,
        branchRepository: services.branchRepository,
        usersRepository: services.usersRepository,
        sessionsRepository: services.sessionsRepository,
        deployment: { mode: 'standalone' },
      });
      await registerRoutes({
        db,
        app,
        config,
        jwtSecret,
        branchRbacEnabled: false,
        requireAuth,
        enforcePasswordChange: async (context) => context,
        superadminOpts: { allowSuperadmin: false },
        DB_PATH: ':memory:',
        DAEMON_PORT: 3030,
        DAEMON_VERSION: 'test',
        AGOR_VERSION: 'test',
        DAEMON_BUILD_INFO: { sha: 'dev', builtAt: null, source: 'fallback' },
        resolvedSecurity: resolveSecurity(config, { daemonUrl: 'http://localhost:3030' }),
        distributedWorkIdentity: { instanceId: 'test-daemon', bootId: 'test-boot' },
        deployment: { mode: 'standalone' },
        sessionsService: services.sessionsService,
        messagesService: services.messagesService,
        boardsService: services.boardsService,
        branchRepository: services.branchRepository,
        usersRepository: services.usersRepository,
        sessionsRepository: services.sessionsRepository,
        sessionMCPServersService: services.sessionMCPServersService,
        sessionEnvSelectionsService: services.sessionEnvSelectionsService,
        terminalsService: services.terminalsService,
      });

      const seeded = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
        const users = new UsersRepository(tenantDb);
        const owner = await users.create({ email: 'owner-a@example.test', role: 'member' });
        const taskCreator = await users.create({
          email: 'task-creator-b@example.test',
          role: 'member',
        });
        const victim = await users.create({ email: 'victim@example.test', role: 'member' });
        const repo = await new RepoRepository(tenantDb).create({
          repo_id: generateId(),
          slug: `mcp-executor-scope-${generateId()}`,
          name: 'MCP executor scope',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/mcp-executor-scope.git',
          local_path: '/tmp/mcp-executor-scope',
          default_branch: 'main',
        });
        const branch = await new BranchRepository(tenantDb).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: 'mcp-executor-scope',
          ref: 'main',
          branch_unique_id: Date.now() % 2_000_000_000,
          path: '/tmp/mcp-executor-scope/branch',
          created_by: owner.user_id,
        });
        const session = await new SessionRepository(tenantDb).create({
          session_id: generateId(),
          branch_id: branch.branch_id,
          agentic_tool: 'codex',
          created_by: owner.user_id,
          status: SessionStatus.RUNNING,
          ready_for_prompt: false,
        });
        const task = await new TaskRepository(tenantDb).create({
          task_id: generateId(),
          session_id: session.session_id,
          created_by: taskCreator.user_id,
          full_prompt: 'resolve scoped MCP configuration',
          status: TaskStatus.RUNNING,
          executor_connected_at: new Date().toISOString(),
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'mcp-executor-scope-test' },
          tool_use_count: 0,
        });
        const mcpServers = new MCPServerRepository(tenantDb);
        const ownerServer = await mcpServers.create({
          mcp_server_id: generateId() as MCPServerID,
          name: 'owner-a-private-server',
          transport: 'http',
          url: 'https://owner-a.example.test/mcp',
          scope: 'global',
          enabled: true,
          source: 'user',
          owner_user_id: owner.user_id as UserID,
          auth: { type: 'oauth', oauth_mode: 'per_user' },
        });
        const victimServer = await mcpServers.create({
          mcp_server_id: generateId() as MCPServerID,
          name: 'victim-private-server',
          transport: 'http',
          url: 'https://victim.example.test/mcp',
          scope: 'global',
          enabled: true,
          source: 'user',
          owner_user_id: victim.user_id as UserID,
          auth: { type: 'oauth', oauth_mode: 'per_user' },
        });
        const grants = new UserMCPOAuthTokenRepository(tenantDb);
        await grants.saveToken(owner.user_id as UserID, ownerServer.mcp_server_id, {
          accessToken: 'OWNER-A-OAUTH-SECRET',
        });
        await grants.saveToken(taskCreator.user_id as UserID, ownerServer.mcp_server_id, {
          accessToken: 'TASK-CREATOR-B-OAUTH-SECRET',
        });
        await grants.saveToken(victim.user_id as UserID, ownerServer.mcp_server_id, {
          accessToken: 'VICTIM-OAUTH-SECRET',
        });
        return { owner, taskCreator, victim, branch, session, task, ownerServer, victimServer };
      });
      const sessionTokenService = (app as unknown as { sessionTokenService: SessionTokenService })
        .sessionTokenService;
      const executorToken = await runWithTenantDatabaseScope(db, tenantId, () =>
        sessionTokenService.generateToken(seeded.session.session_id, seeded.taskCreator.user_id, {
          taskId: seeded.task.task_id,
          branchId: seeded.branch.branch_id,
          maxUses: -1,
        })
      );
      const route = app.service('/sessions/:id/mcp-servers');
      const findAsExecutor = (forUserId: string) =>
        route.find({
          provider: 'rest',
          route: { id: seeded.session.session_id },
          authentication: { strategy: 'jwt', accessToken: executorToken },
          query: { enabledOnly: true, includeGlobal: true, forUserId },
        } as never) as Promise<MCPServer[]>;

      const resolvedForTaskCreator = await findAsExecutor(seeded.taskCreator.user_id);
      expect(resolvedForTaskCreator).toHaveLength(1);
      expect(resolvedForTaskCreator[0]).toMatchObject({
        mcp_server_id: seeded.ownerServer.mcp_server_id,
        owner_user_id: seeded.owner.user_id,
        auth: { oauth_access_token: 'TASK-CREATOR-B-OAUTH-SECRET' },
      });
      expect(resolvedForTaskCreator.map((server) => server.mcp_server_id)).not.toContain(
        seeded.victimServer.mcp_server_id
      );

      const resolvedForVictimRequest = await findAsExecutor(seeded.victim.user_id);
      expect(resolvedForVictimRequest[0]).toMatchObject({
        mcp_server_id: seeded.ownerServer.mcp_server_id,
        auth: { oauth_access_token: 'TASK-CREATOR-B-OAUTH-SECRET' },
      });
      expect(JSON.stringify(resolvedForVictimRequest)).not.toContain('VICTIM-OAUTH-SECRET');
      expect(JSON.stringify(resolvedForVictimRequest)).not.toContain('OWNER-A-OAUTH-SECRET');

      const taskCreatorAccessToken = issueRuntimeToken(
        { sub: seeded.taskCreator.user_id, type: 'access' },
        jwtSecret,
        '5m'
      );
      await expect(
        route.find({
          provider: 'rest',
          route: { id: seeded.session.session_id },
          authentication: { strategy: 'jwt', accessToken: taskCreatorAccessToken },
          query: { enabledOnly: true, includeGlobal: true },
        } as never)
      ).rejects.toThrow(/creator or an admin/i);
      const mutationParams = () =>
        ({
          provider: 'rest',
          route: { id: seeded.session.session_id },
          authentication: { strategy: 'jwt', accessToken: taskCreatorAccessToken },
        }) as never;
      const mutations = [
        () => route.create({ mcpServerId: seeded.ownerServer.mcp_server_id }, mutationParams()),
        () => route.update(null, { mcpServerIds: [] }, mutationParams()),
        () => route.patch(seeded.ownerServer.mcp_server_id, { enabled: false }, mutationParams()),
        () => route.remove(seeded.ownerServer.mcp_server_id, mutationParams()),
      ];
      for (const mutate of mutations) {
        await expect(mutate()).rejects.toThrow(/creator or an admin/i);
      }
    } finally {
      try {
        await app.teardown();
      } finally {
        (rawDb as unknown as { $client: { close(): void } }).$client.close();
      }
    }
  });
});
