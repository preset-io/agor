import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  BranchRepository,
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  generateId,
  MCPServerRepository,
  RepoRepository,
  runMigrations,
  runWithTenantDatabaseScope,
  SessionMCPServerRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import {
  type Application,
  errorHandler,
  feathers,
  feathersExpress,
  NotAuthenticated,
  rest,
  socketio,
} from '@agor/core/feathers';
import type { AuthenticatedParams, User } from '@agor/core/types';
import { expect, it, vi } from 'vitest';
import { type RegisterRoutesContext, registerRoutes } from './register-routes';
import { SessionMCPServersService } from './services/session-mcp-servers';

it('registered HTTP attachment returns 403 for foreign private rows, including admins', async () => {
  const raw = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(raw);
  const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
  const scoped = <T>(work: () => Promise<T>) => runWithTenantDatabaseScope(db, 'default', work);
  const usersRepository = new UsersRepository(db);
  const sessionsRepository = new SessionRepository(db);
  const branchRepository = new BranchRepository(db);
  const serverRepo = new MCPServerRepository(db);
  const f = await scoped(async () => {
    const alice = await usersRepository.create({ email: 'alice@example.invalid', role: 'member' });
    const bob = await usersRepository.create({ email: 'bob@example.invalid', role: 'member' });
    const admin = await usersRepository.create({ email: 'admin@example.invalid', role: 'admin' });
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: generateId(),
      name: 'Test',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/test',
      local_path: '/disposable/test',
      default_branch: 'main',
    });
    const branch = await branchRepository.create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: 'test',
      ref: 'main',
      path: '/disposable/test/branch',
      branch_unique_id: 1,
      created_by: alice.user_id,
    });
    const sessions = await Promise.all(
      [alice, admin].map((user) =>
        sessionsRepository.create({
          session_id: generateId(),
          branch_id: branch.branch_id,
          agentic_tool: 'codex',
          created_by: user.user_id,
          status: 'idle',
        })
      )
    );
    const own = await serverRepo.create({
      name: 'own',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      scope: 'session',
      owner_user_id: alice.user_id,
    });
    const foreign = await serverRepo.create({
      name: 'foreign',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      scope: 'session',
      owner_user_id: bob.user_id,
    });
    const shared = await serverRepo.create({
      name: 'shared',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      scope: 'session',
    });
    return { alice, admin, sessions, own, foreign, shared };
  });
  const app = feathersExpress(feathers());
  app.use(feathersExpress.json());
  app.configure(rest());
  app.configure(socketio());
  // The standalone deployment's trusted tenant boundary; the DB refuses any
  // repository access outside this unit, including nested service methods.
  app.hooks({ around: { all: [(_context, next) => scoped(next)] } });
  for (const path of ['users', 'tasks', 'repos', 'branches', 'session-mcp-servers'])
    app.use(path, {
      async get() {
        return {};
      },
    });
  app.use('sessions', {
    get: (id: string) => sessionsRepository.findById(id),
    setQueueProcessor: () => {},
  });
  const stop = new Error('MCP routes registered');
  const use = app.use.bind(app);
  const spy = vi.spyOn(app, 'use').mockImplementation((...args) => {
    if (args[0] === '/tasks/:id/mcp-reprojection') throw stop;
    return use(...args);
  });
  try {
    await expect(
      registerRoutes({
        app: app as unknown as Application,
        db,
        config: {},
        superadminOpts: { allowSuperadmin: false },
        externalLaunchProvider: { enabled: false },
        jwtSecret: 'disposable-test-secret-not-production',
        sessionsRepository,
        branchRepository,
        usersRepository,
        sessionMCPServersService: new SessionMCPServersService(db),
        sessionsService: app.service('sessions'),
        requireAuth: (ctx: { params: AuthenticatedParams }) => {
          expect(ctx.params.provider).toBe('rest');
          const name = ctx.params.headers?.authorization;
          const user: User | undefined =
            name === 'Bearer test-alice'
              ? f.alice
              : name === 'Bearer test-admin'
                ? f.admin
                : undefined;
          if (!user) throw new NotAuthenticated();
          ctx.params.user = user;
          ctx.params.authenticated = true;
          return ctx;
        },
        enforcePasswordChange: (ctx: unknown) => ctx,
      } as unknown as RegisterRoutesContext)
    ).rejects.toBe(stop);
  } finally {
    spy.mockRestore();
  }
  app.use(errorHandler({ logger: false }));
  const listener = await app.listen(0, '127.0.0.1');
  if (!listener.listening) await once(listener, 'listening');
  try {
    const port = (listener.address() as AddressInfo).port;
    const attach = (index: number, id: string, user: string) =>
      fetch(`http://127.0.0.1:${port}/sessions/${f.sessions[index].session_id}/mcp-servers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer test-${user}` },
        body: JSON.stringify({ mcpServerId: id }),
      });
    for (const [index, user] of [
      [0, 'alice'],
      [1, 'admin'],
    ] as const) {
      const denied = await attach(index, f.foreign.mcp_server_id, user);
      const body = await denied.json();
      expect(denied.status, JSON.stringify(body)).toBe(403);
      expect(body).toMatchObject({ name: 'Forbidden', code: 403 });
      const allowed = await attach(index, f.shared.mcp_server_id, user);
      expect(allowed.status, JSON.stringify(await allowed.json())).toBe(201);
    }
    expect((await attach(0, f.own.mcp_server_id, 'alice')).status).toBe(201);
    await scoped(async () => {
      const links = await new SessionMCPServerRepository(db).listServers(f.sessions[0].session_id);
      expect(links.map((s) => s.mcp_server_id)).not.toContain(f.foreign.mcp_server_id);
    });
  } finally {
    // Socket.io and Express can both close the same HTTP listener.
    await app.teardown().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    });
    (raw as unknown as { $client: { close(): void } }).$client.close();
  }
}, 30_000);
