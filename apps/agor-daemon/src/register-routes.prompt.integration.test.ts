import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createClient } from '@agor/core/api';
import { DEFAULT_STATIC_TENANT_ID } from '@agor/core/config';
import {
  BranchRepository,
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  generateId,
  getCurrentTenantDatabaseScope,
  MessagesRepository,
  RepoRepository,
  runMigrations,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers, feathersExpress, socketio } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  HookContext,
  MessageCreate,
  RuntimeTelemetryInput,
  Session,
  SessionUpdate,
  Task,
  TaskID,
} from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReactiveSessionHandle } from '../../../packages/client/src/reactive-session';
import { startExecutorHeartbeat } from '../../../packages/executor/src/executor-heartbeat';
import { NOOP_METRICS } from './metrics/noop';
import { type RegisterRoutesContext, registerRoutes } from './register-routes.js';
import { TasksService } from './services/tasks.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});

async function fixture(throughQueue = false) {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  cleanup.push(() => (rawDb as unknown as { $client: { close(): void } }).$client.close());
  await runMigrations(rawDb);
  const db = createTenantScopedDatabaseProxy(rawDb);
  const scoped = <T>(work: () => Promise<T>) =>
    runWithTenantDatabaseScope(db, DEFAULT_STATIC_TENANT_ID, work);
  const sessionsRepository = new SessionRepository(db);
  const taskRepo = new TaskRepository(db);
  const messages = new MessagesRepository(db);
  const branchRepository = new BranchRepository(db);
  const usersRepository = new UsersRepository(db);
  const { actor, session } = await scoped(async () => {
    const actor = await usersRepository.create({ email: 'prompt@example.invalid', role: 'member' });
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: generateId(),
      name: 'Fixture',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/repo',
      local_path: '/disposable/not-created',
      default_branch: 'main',
    });
    const branch = await branchRepository.create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: 'fixture',
      ref: 'main',
      branch_unique_id: 1,
      path: '/disposable/not-created/branch',
      created_by: actor.user_id,
    });
    const session = await sessionsRepository.create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'codex',
      created_by: actor.user_id,
      status: SessionStatus.IDLE,
      ready_for_prompt: true,
    });
    return { actor, session };
  });

  // Real Feathers registration/hooks and real repositories. Only transport tests listen.
  // Only the executor and unrelated session configuration/service work are stubbed.
  const app = feathersExpress(feathers()) as unknown as Application;
  app.configure(socketio());
  const events: string[] = [];
  const launchObservations: Array<{ scope: unknown; task: Task | null; session: Session | null }> =
    [];
  const executeTask = vi.fn(async (_sessionId: string, input: { taskId: TaskID }) => {
    const scope = getCurrentTenantDatabaseScope();
    const persisted = await scoped(async () => ({
      task: await taskRepo.findById(input.taskId),
      session: await sessionsRepository.findById(session.session_id),
    }));
    launchObservations.push({ scope, ...persisted });
    events.push('launch');
  });
  const triggerQueueProcessing = vi.fn();
  const sessionsService = {
    get: (id: string) => sessionsRepository.findById(id),
    patch: (id: string, data: SessionUpdate) => sessionsRepository.update(id, data),
    materializeAgenticToolPreset: async (value: Session) => value,
    executeTask,
    triggerQueueProcessing,
    setQueueProcessor: () => {
      if (throughQueue) throw stopRegistration;
    },
  };
  app.use('sessions', sessionsService);
  app.use('messages', {
    create: (data: MessageCreate) => scoped(() => messages.create(data)),
  });
  app.use('users', { get: (id: string) => usersRepository.findById(id) });
  app.use('repos', { get: vi.fn() });
  const tasksService = new TasksService(db, app);
  app.use('tasks', tasksService, {
    methods: ['find', 'get', 'create', 'patch', 'remove', 'reportRuntimeTelemetry'],
  });
  vi.spyOn(tasksService, 'autoTitleSession').mockResolvedValue();
  const claim = vi.spyOn(tasksService, 'claimDispatchAndProjectSession');
  app.service('tasks').on('created', (task: Task) => events.push(`created:${task.status}`));
  app.service('tasks').on('patched', (task: Task) => events.push(`patched:${task.status}`));
  app.service('tasks').on('queued', () => events.push('queued'));
  app.service('messages').on('created', () => events.push('message'));

  // Stop registration immediately after the prompt route, avoiding unrelated
  // upload/health infrastructure. The prompt service and its hooks are unmodified.
  const stopRegistration = new Error('prompt route registered');
  const use = app.use.bind(app);
  let queueRegistered = false;
  const useSpy = vi.spyOn(app, 'use').mockImplementation((...args) => {
    if (throughQueue ? queueRegistered : args[0] === '/tasks/:id/run') throw stopRegistration;
    if (args[0] === '/sessions/:id/tasks/queue') queueRegistered = true;
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
  const prompt = (data: { prompt: string; idempotencyTaskId?: TaskID }) =>
    app.service('sessions/:id/prompt').create(data, {
      route: { id: session.session_id },
      user: actor,
      tenant: { tenant_id: DEFAULT_STATIC_TENANT_ID, source: 'explicit' },
    } as AuthenticatedParams) as Promise<Task>;
  return {
    app,
    tasksService,
    scoped,
    session,
    actor,
    taskRepo,
    messages,
    sessionsRepository,
    events,
    executeTask,
    triggerQueueProcessing,
    claim,
    launchObservations,
    prompt,
    settle: nextTurn,
  };
}

describe('registered prompt route launch handoff', () => {
  it('launches a fresh idle admission once after commit, without another claim or queued event', async () => {
    const f = await fixture();
    const task = await f.prompt({ prompt: 'disposable fixture' });
    expect(task.status).toBe(TaskStatus.DISPATCHING);
    await vi.waitFor(() => expect(f.launchObservations).toHaveLength(1));
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.executeTask).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['created:dispatching', 'message', 'launch']);
    expect(f.launchObservations[0]).toMatchObject({
      scope: undefined,
      task: { task_id: task.task_id, status: TaskStatus.DISPATCHING },
      session: { status: SessionStatus.RUNNING, ready_for_prompt: false, tasks: [task.task_id] },
    });
    expect(await f.scoped(() => f.sessionsRepository.countMessages(f.session.session_id))).toBe(1);
  });

  it('keeps a new prompt queued behind unfinished work and never launches it', async () => {
    const f = await fixture();
    // The durable queue head blocks a newer prompt even if the Session appears idle.
    await f.scoped(() =>
      f.taskRepo.createPending({
        session_id: f.session.session_id,
        full_prompt: 'older fixture',
        created_by: f.actor.user_id,
        status: TaskStatus.QUEUED,
      })
    );
    const task = await f.prompt({ prompt: 'newer fixture' });
    expect(task.status).toBe(TaskStatus.QUEUED);
    await f.settle();
    expect(f.claim).toHaveBeenCalledTimes(1);
    expect(f.executeTask).not.toHaveBeenCalled();
    expect(f.triggerQueueProcessing).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['created:queued', 'queued']);
    expect(await f.scoped(() => f.sessionsRepository.countMessages(f.session.session_id))).toBe(0);
  });

  it('uses the ordinary claim for a stable ID and reconciles without relaunch or duplicate events', async () => {
    const f = await fixture();
    const idempotencyTaskId = generateId() as TaskID;
    const data = { prompt: 'stable fixture', idempotencyTaskId };
    const first = await f.prompt(data);
    await vi.waitFor(() => expect(f.launchObservations).toHaveLength(1));
    expect(first.status).toBe(TaskStatus.DISPATCHING);
    expect(f.events).toEqual(['created:queued', 'patched:dispatching', 'message', 'launch']);
    const second = await f.prompt(data);
    await f.settle();
    expect(second.task_id).toBe(first.task_id);
    expect(f.claim).toHaveBeenCalledTimes(1);
    expect(f.executeTask).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['created:queued', 'patched:dispatching', 'message', 'launch']);
    expect(await f.scoped(() => f.messages.findById(idempotencyTaskId))).toMatchObject({
      task_id: first.task_id,
      session_id: f.session.session_id,
    });
  });
});

it('registers the parameterized queue route and resolves params.route.id inside tenant scope', async () => {
  const f = await fixture(true);
  const queued = await f.scoped(() =>
    f.taskRepo.createPending({
      session_id: f.session.session_id,
      created_by: f.actor.user_id,
      full_prompt: 'queued fixture',
      status: TaskStatus.QUEUED,
    })
  );
  const result = await f.app.service('sessions/:id/tasks/queue').find({
    route: { id: f.session.session_id },
    user: f.actor,
    tenant: { tenant_id: DEFAULT_STATIC_TENANT_ID, source: 'explicit' },
  } as AuthenticatedParams);
  expect(result.data.map((task: Task) => task.task_id)).toEqual([queued.task_id]);
});

it('real reader transports parameterized queue through registered route and scoped SQLite, including reconnect', async () => {
  const f = await fixture(true);
  const queued = await f.scoped(() =>
    f.taskRepo.createPending({
      session_id: f.session.session_id,
      created_by: f.actor.user_id,
      full_prompt: 'fixture queue',
      status: TaskStatus.QUEUED,
    })
  );
  f.app.hooks({
    before: {
      all: [
        (ctx: HookContext) => {
          ctx.params.user = f.actor;
          ctx.params.tenant = { tenant_id: DEFAULT_STATIC_TENANT_ID, source: 'explicit' };
          return ctx;
        },
      ],
    },
  });
  for (const name of ['tasks', 'sessions', 'messages'])
    f.app.service(name).hooks({
      around: { all: [(ctx: HookContext, next: () => Promise<void>) => f.scoped(next)] },
    });
  f.app.use('session-streams', {
    create: async (data: unknown) => data,
    remove: async (id: string) => ({ session_id: id }),
  });
  const server = await f.app.listen({ port: 0, host: '127.0.0.1' });
  if (!server.listening) await once(server, 'listening');
  const client = createClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, false, {
    ackTimeout: 3000,
  });
  let handle: ReactiveSessionHandle | undefined;
  try {
    const connected = new Promise<void>((resolve) => client.io.once('connect', () => resolve()));
    client.io.connect();
    await connected;
    handle = new ReactiveSessionHandle(client, f.session.session_id, { taskHydration: 'lean' });
    await handle.ready();
    expect(handle.state.error).toBeNull();
    expect(handle.state.queuedTasks.map((t) => t.task_id)).toEqual([queued.task_id]);
    expect(Object.keys(client.services).filter((k) => k.endsWith('/tasks/queue'))).toEqual([
      'sessions/:id/tasks/queue',
    ]);
    client.io.disconnect();
    const reconnected = new Promise<void>((resolve) => client.io.once('connect', () => resolve()));
    client.io.connect();
    await reconnected;
    await vi.waitFor(() => expect(handle!.state.connected).toBe(true));
    await handle.resync();
    expect(handle.state.error).toBeNull();
    expect(handle.state.queuedTasks.map((t) => t.task_id)).toEqual([queued.task_id]);
  } finally {
    handle?.dispose();
    client.io.disconnect();
    await f.app.teardown();
  }
}, 15000);

it('real sampler reaches custom Feathers heartbeat, SQLite authority and fixed metric sink', async () => {
  const f = await fixture(true);
  const task = await f.prompt({ prompt: 'telemetry fixture' });
  await f.scoped(() => f.taskRepo.bindExecutorLaunchAuthority(task.task_id));
  await f.scoped(() => f.taskRepo.connectExecutor(task.task_id));
  Reflect.set(f.tasksService, 'executorCredentialRevoker', {
    isTaskTokenAuthorityCurrent: async () => true,
  });
  const distribution = vi.fn();
  f.app.set('metrics', { ...NOOP_METRICS, enabled: true, distribution });
  let mismatchedTenant = false;
  f.app.hooks({
    before: {
      all: [
        (ctx: HookContext) => {
          ctx.params.user = f.actor;
          ctx.params.tenant = { tenant_id: DEFAULT_STATIC_TENANT_ID, source: 'explicit' };
          // Deliberately trusted fixture identity, not a production JWT authenticator.
          ctx.params.authentication = {
            strategy: 'jwt',
            accessToken: 'disposable-fixture-token',
            payload: {
              type: 'executor-session',
              purpose: 'executor-task',
              sub: f.actor.user_id,
              tenant_id: mismatchedTenant ? 'foreign-tenant' : DEFAULT_STATIC_TENANT_ID,
              session_id: f.session.session_id,
              task_id: task.task_id,
              branch_id: f.session.branch_id,
            },
          };
          return ctx;
        },
      ],
    },
  });
  f.app
    .service('tasks')
    .hooks({ around: { all: [(ctx: HookContext, next: () => Promise<void>) => f.scoped(next)] } });
  const server = await f.app.listen({ port: 0, host: '127.0.0.1' });
  if (!server.listening) await once(server, 'listening');
  const client = createClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, false, {
    ackTimeout: 3000,
  });
  let heartbeat: ReturnType<typeof startExecutorHeartbeat> | undefined;
  try {
    const connected = new Promise<void>((resolve) => client.io.once('connect', () => resolve()));
    client.io.connect();
    await connected;
    heartbeat = startExecutorHeartbeat({
      client,
      taskId: task.task_id,
      memorySampling: true,
      intervalMs: 10000,
    });
    await vi.waitFor(() => expect(distribution.mock.calls.length).toBe(6), { timeout: 5000 });
    heartbeat.stop();
    expect(distribution.mock.calls).toContainEqual([
      'executor.memory.current.rss_bytes',
      expect.any(Number),
    ]);
    const stored = await f.scoped(() => f.taskRepo.findById(task.task_id));
    expect(stored?.last_executor_heartbeat_at).toBeTruthy();
    expect(stored).not.toHaveProperty('memory');
    const before = distribution.mock.calls.length;
    // Export disabled still accepts the liveness write.
    f.app.set('metrics', NOOP_METRICS);
    await client
      .service('tasks')
      .reportRuntimeTelemetry({ task_id: task.task_id, memory: { current: { rss: 1 } } });
    expect(distribution.mock.calls.length).toBe(before);
    f.app.set('metrics', { ...NOOP_METRICS, enabled: true, distribution });
    await client.service('tasks').reportRuntimeTelemetry({
      task_id: task.task_id,
      memory: { current: { rss: -1, external: 'redacted-fixture' }, sampled_peak: {} },
    } as unknown as RuntimeTelemetryInput);
    expect(distribution.mock.calls.length).toBe(before);
    await expect(
      client
        .service('tasks')
        .reportRuntimeTelemetry({ task_id: generateId(), memory: { current: { rss: 1 } } })
    ).rejects.toMatchObject({ code: 403 });
    expect(distribution.mock.calls.length).toBe(before);
    mismatchedTenant = true;
    await expect(
      client.service('tasks').reportRuntimeTelemetry({
        task_id: task.task_id,
        memory: { current: { rss: 1 } },
      })
    ).rejects.toMatchObject({ code: 403 });
    expect(distribution.mock.calls.length).toBe(before);
  } finally {
    heartbeat?.stop();
    client.io.disconnect();
    await f.app.teardown();
  }
}, 15000);
