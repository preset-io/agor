import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  MCPServerRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  setMcpMemberPolicy,
  UsersRepository,
} from '@agor/core/db';
import { AuthenticationService, authenticate, feathers, JWTStrategy } from '@agor/core/feathers';
import type { AuthenticatedParams, BranchID, HookContext, SessionID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { createRequireAuthHook } from '../auth/require-auth';
import { type RegisterHooksContext, registerHooks } from '../register-hooks';
import { type RegisterServicesContext, registerMCPServices } from '../register-services';

dbTest(
  'marketplace deletion traverses real authenticated MCP removal hooks and commits before effects',
  async ({ db: rawDb }) => {
    const db = createTenantScopedDatabaseProxy(rawDb, { requireScope: true });
    const users = new UsersRepository(rawDb);
    const alice = await users.create({ email: 'delete-alice@example.test', role: 'member' });
    const bob = await users.create({ email: 'delete-bob@example.test', role: 'member' });
    await setMcpMemberPolicy(rawDb, 'allow_private_only', undefined);
    const servers = new MCPServerRepository(rawDb);
    const server = await servers.create({
      name: 'delete-wired',
      transport: 'http',
      url: 'https://example.test/mcp',
      scope: 'session',
      source: 'catalog',
      catalog_entry_name: 'test/delete-wired',
      owner_user_id: alice.user_id,
      auth: { type: 'bearer', token: 'private-fixture-token' },
    });
    const repo = await new RepoRepository(rawDb).create({
      slug: 'test/delete-wired',
      name: 'Delete wiring',
      repo_type: 'remote',
      remote_url: 'https://example.test/repo.git',
      local_path: '/tmp/delete-wired',
      default_branch: 'main',
    });
    const branch = await new BranchRepository(rawDb).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: 'fixture',
      ref: 'main',
      branch_unique_id: 1,
      path: '/tmp/delete-wired',
      created_by: alice.user_id,
    });
    const session = await new SessionRepository(rawDb).create({
      session_id: generateId() as SessionID,
      branch_id: branch.branch_id,
      created_by: alice.user_id,
      status: SessionStatus.IDLE,
      agentic_tool: 'claude-code',
    });
    const links = new SessionMCPServerRepository(rawDb);
    await links.addServer(session.session_id, server.mcp_server_id);

    const app = feathers();
    app.set('authentication', {
      secret: 'marketplace-wiring-test-secret',
      entity: 'user',
      entityId: 'user_id',
      service: 'auth-users',
      authStrategies: ['jwt'],
    });
    // A real JWT strategy loads the fixture principal; no authenticated:true or
    // no-op auth hook shortcuts the production guard.
    app.use('auth-users', { get: (id: string) => users.findById(id) });
    const auth = new AuthenticationService(app);
    auth.register('jwt', new JWTStrategy());
    app.use('authentication', auth);
    const config = {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'default' },
    } as RegisterHooksContext['config'];
    const requireAuth = createRequireAuthHook(
      authenticate('jwt'),
      resolveMultiTenancyConfig(config)
    );
    await registerMCPServices({
      db,
      app,
      config,
      requireAuth,
      jwtSecret: 'marketplace-wiring-test-secret',
      daemonUrl: 'http://localhost:3030',
      bundledUiAvailable: false,
      DAEMON_PORT: 3030,
      UI_PORT: 5173,
      allowSuperadmin: false,
      deployment: { mode: 'standalone' },
      mcpOAuthCallbackUrl: 'http://localhost:3030/mcp-servers/oauth-callback',
    } as RegisterServicesContext);

    const abortServer = vi.fn();
    const signal = vi.fn(async () => undefined);
    Object.assign(app, {
      mcpEgressGateway: { abortServer },
      signalMcpServerAuthorityChange: signal,
    });
    // Only unrelated product services are inert. Every MCP hook is installed by
    // the production registrar on the real Feathers service registered above.
    const unrelated = { hooks() {}, on() {}, emit() {} };
    const registrationApp = new Proxy(app, {
      get(target, property) {
        if (property === 'service')
          return (path: string) => {
            try {
              return target.service(path);
            } catch {
              return unrelated;
            }
          };
        if (property === 'publish') return () => undefined;
        return Reflect.get(target, property);
      },
    });
    registerHooks({
      db,
      app: registrationApp,
      config,
      requireAuth,
      jwtSecret: 'marketplace-wiring-test-secret',
      deployment: { mode: 'standalone' },
      superadminOpts: { allowSuperadmin: false },
      sessionsService: unrelated as unknown as RegisterHooksContext['sessionsService'],
      messagesService: unrelated as unknown as RegisterHooksContext['messagesService'],
      boardsService: undefined,
      branchRepository: new BranchRepository(db),
      usersRepository: new UsersRepository(db),
      sessionsRepository: new SessionRepository(db),
    } as RegisterHooksContext);
    const params = async (id: string): Promise<AuthenticatedParams> => ({
      provider: 'rest',
      authentication: {
        strategy: 'jwt',
        accessToken: await auth.createAccessToken({}, { subject: id }),
      },
    });
    const action = app.service('mcp-marketplace/remove-unattached');
    const removal = app.service('mcp-servers');
    const removed = vi.fn();
    removal.on('removed', removed);
    const confirmed = {
      mcp_server_id: server.mcp_server_id,
      detach: true,
      expected_session_count: 1,
    };
    await expect(action.create(confirmed, { provider: 'rest' })).rejects.toMatchObject({
      code: 401,
    });
    await expect(action.create(confirmed, await params(bob.user_id))).rejects.toMatchObject({
      code: 403,
    });
    await expect(
      action.create({ ...confirmed, expected_session_count: 0 }, await params(alice.user_id))
    ).rejects.toMatchObject({ code: 409 });
    // Query validation on the nested service must not be bypassed either.
    await expect(
      action.create(confirmed, {
        ...(await params(alice.user_id)),
        query: { transport: 'invalid' },
      })
    ).rejects.toMatchObject({ code: 400 });
    expect(await servers.findById(server.mcp_server_id)).not.toBeNull();
    expect(await links.getRelationship(session.session_id, server.mcp_server_id)).not.toBeNull();
    expect(removed).not.toHaveBeenCalled();
    expect(abortServer).not.toHaveBeenCalled();

    let failAfterRemoval = true;
    const captured = vi.fn();
    removal.hooks({
      after: {
        remove: [
          async (context: HookContext) => {
            captured(context.params);
            // The real capture and after hooks have run, but the enclosing marketplace
            // transaction has not committed. Neither event nor cancellation may escape.
            expect(context.params).toHaveProperty('_mcpRemovalTargets');
            expect(removed).not.toHaveBeenCalled();
            expect(abortServer).not.toHaveBeenCalled();
            expect(signal).not.toHaveBeenCalled();
            if (failAfterRemoval) throw new Error('rollback after real removal');
            return context;
          },
        ],
      },
    });
    await expect(action.create(confirmed, await params(alice.user_id))).rejects.toThrow(
      'rollback after real removal'
    );
    expect(await servers.findById(server.mcp_server_id)).not.toBeNull();
    expect(await links.getRelationship(session.session_id, server.mcp_server_id)).not.toBeNull();
    expect(removed).not.toHaveBeenCalled();
    expect(abortServer).not.toHaveBeenCalled();
    failAfterRemoval = false;
    await expect(action.create(confirmed, await params(alice.user_id))).resolves.toMatchObject({
      removed: true,
    });
    expect(captured).toHaveBeenCalledTimes(2);
    expect(await servers.findById(server.mcp_server_id)).toBeNull();
    expect(await links.getRelationship(session.session_id, server.mcp_server_id)).toBeNull();
    expect(removed).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith(
      { mcp_server_id: server.mcp_server_id, owner_user_id: alice.user_id },
      expect.objectContaining({
        path: 'mcp-servers',
        method: 'remove',
        params: expect.objectContaining({
          tenant: expect.objectContaining({ tenant_id: 'default' }),
        }),
      })
    );
    expect(abortServer).toHaveBeenCalledExactlyOnceWith(
      'default',
      server.mcp_server_id,
      'stale_capability'
    );
    await vi.waitFor(() => expect(signal).toHaveBeenCalledOnce());
  }
);
