import { setImmediate as nextTurn } from 'node:timers/promises';
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
  MessageCreate,
  Session,
  SessionUpdate,
  Task,
  TaskID,
} from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RegisterRoutesContext, registerRoutes } from './register-routes.js';
import { TasksService } from './services/tasks.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});

async function fixture() {
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

  // Real Feathers registration/hooks and real repositories; no listener is started.
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
  };
  app.use('sessions', sessionsService);
  app.use('messages', {
    create: (data: MessageCreate) => scoped(() => messages.create(data)),
  });
  app.use('users', { get: (id: string) => usersRepository.findById(id) });
  app.use('repos', { get: vi.fn() });
  const tasksService = new TasksService(db, app);
  app.use('tasks', tasksService);
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
  const useSpy = vi.spyOn(app, 'use').mockImplementation((...args) => {
    if (args[0] === '/tasks/:id/run') throw stopRegistration;
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
