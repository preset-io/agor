import { DEFAULT_STATIC_TENANT_ID } from '@agor/core/config';
import {
  BranchRepository,
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  generateId,
  RepoRepository,
  runMigrations,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { sessionQueryValidator, typedValidateQuery } from '@agor/core/lib/feathers-validation';
import type { AuthenticatedParams, Session, User } from '@agor/core/types';
import { ROLES, SessionStatus, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RegisterRoutesContext, registerRoutes } from './register-routes.js';
import { SessionsService } from './services/sessions.js';
import {
  ensureCanView,
  loadSessionBranch,
  scopeFindToAccessibleSessionsSql,
} from './utils/branch-authorization.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0)) close();
});

async function fixture() {
  vi.stubEnv('AGOR_BASE_URL', 'http://agor.test');
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  cleanup.push(() => (rawDb as unknown as { $client: { close(): void } }).$client.close());
  await runMigrations(rawDb);
  const db = createTenantScopedDatabaseProxy(rawDb);
  const scoped = <T>(work: () => Promise<T>) =>
    runWithTenantDatabaseScope(db, DEFAULT_STATIC_TENANT_ID, work);
  const sessionsRepository = new SessionRepository(db);
  const branchRepository = new BranchRepository(db);
  const usersRepository = new UsersRepository(db);
  const seeded = await scoped(async () => {
    const admin = await usersRepository.create({
      email: `admin-${generateId()}@example.invalid`,
      role: ROLES.ADMIN,
    });
    const member = await usersRepository.create({
      email: `member-${generateId()}@example.invalid`,
      role: ROLES.MEMBER,
    });
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: `session-read-${generateId()}`,
      name: 'Session read authorization',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/session-read.git',
      local_path: '/disposable/not-created',
      default_branch: 'main',
    });
    const branch = await branchRepository.create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: 'admin-private',
      ref: 'main',
      branch_unique_id: 1,
      path: '/disposable/not-created/admin-private',
      created_by: admin.user_id,
    });
    const session = await sessionsRepository.create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: admin.user_id,
      status: SessionStatus.RUNNING,
      ready_for_prompt: false,
    });
    await new TaskRepository(db).createPending({
      session_id: session.session_id,
      full_prompt: 'private queued prompt',
      created_by: admin.user_id,
      status: TaskStatus.QUEUED,
    });
    return { admin, member, session };
  });

  // Real Sessions service with the production read hooks; the routes must go through them.
  const app = feathersExpress(feathers()) as unknown as Application;
  app.configure(socketio());
  const sessionsService = new SessionsService(db, app);
  app.use('sessions', sessionsService as never);
  // Unrelated services that route registration looks up; never called by these reads.
  for (const path of ['users', 'repos', 'messages', 'tasks', 'branches', 'boards']) {
    app.use(path, { get: vi.fn(), find: vi.fn(), create: vi.fn(), patch: vi.fn() });
  }
  app.service('sessions').hooks({
    before: {
      all: [typedValidateQuery(sessionQueryValidator)],
      get: [loadSessionBranch(sessionsRepository, branchRepository), ensureCanView()],
      find: [scopeFindToAccessibleSessionsSql()],
    },
  });

  // Stop registration right after the queue route; earlier routes register unmodified.
  const stopRegistration = new Error('queue route registered');
  const use = app.use.bind(app);
  const useSpy = vi.spyOn(app, 'use').mockImplementation((...args) => {
    if (args[0] === '/sessions/:id/permission-decision') throw stopRegistration;
    return use(...args);
  });
  try {
    await expect(
      registerRoutes({
        app,
        db,
        config: {},
        externalLaunchProvider: { enabled: false },
        jwtSecret: 'disposable-test-not-a-credential',
        requireAuth: (context: unknown) => context,
        enforcePasswordChange: (context: unknown) => context,
        sessionsService,
        sessionsRepository,
        branchRepository,
        usersRepository,
      } as unknown as RegisterRoutesContext)
    ).rejects.toBe(stopRegistration);
  } finally {
    useSpy.mockRestore();
  }

  const read = <T>(path: string, user: User) =>
    app.service(path).find({
      provider: 'rest',
      route: { id: seeded.session.session_id },
      user,
      tenant: { tenant_id: DEFAULT_STATIC_TENANT_ID, source: 'explicit' },
    } as AuthenticatedParams) as Promise<T>;
  return { ...seeded, read };
}

describe('session read routes require Session view', () => {
  it.each(['sessions/:id/genealogy', 'sessions/:id/tasks/queue'])(
    'denies another member %s on a private Session',
    async (path) => {
      const f = await fixture();
      await expect(f.read(path, f.member)).rejects.toMatchObject({ code: 403 });
    }
  );

  it('still serves both routes to the Session owner', async () => {
    const f = await fixture();
    const genealogy = await f.read<{ session: Session }>('sessions/:id/genealogy', f.admin);
    expect(genealogy.session.session_id).toBe(f.session.session_id);
    const queue = await f.read<{ data: Array<{ full_prompt: string }> }>(
      'sessions/:id/tasks/queue',
      f.admin
    );
    expect(queue.data.map((task) => task.full_prompt)).toEqual(['private queued prompt']);
  });
});
