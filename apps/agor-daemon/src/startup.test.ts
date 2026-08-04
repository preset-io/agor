import {
  createTenantScopedDatabaseProxy,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  MissingTenantDatabaseScopeError,
  RuntimeRecoveryDiscoveryRepository,
  SessionRepository,
} from '@agor/core/db';
import type { Session, Task } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupOrphanStatuses,
  createEnvironmentHealthMonitor,
  initializeEnvironmentHealthMonitor,
  prepareTaskRuntimeStartup,
  resumeRuntimeRecovery,
  type StartupContext,
  shouldContainLocalExecutorsOnShutdown,
  shouldReconnectSocketClientsOnShutdown,
} from './startup.js';
import * as terminationCoordinator from './termination-coordinator.js';
import * as systemMessages from './utils/append-system-message.js';

afterEach(() => vi.restoreAllMocks());

interface StartupFixtures {
  orphanedTasks?: Task[];
  queuedTasks?: Task[];
  /** Returned by the IDLE + ready_for_prompt=false sweep query */
  idleNotReadySessions?: Session[];
  /** Lookup table for tasksService.get / sessionsService.get */
  tasksById?: Record<string, Task>;
  sessionsById?: Record<string, Session>;
}

function makeStartupContextWithGuardedDb(fixtures: StartupFixtures = {}) {
  const baseDb = {
    run: vi.fn(),
    marker: vi.fn(() => 'scoped'),
  };
  const db = createTenantScopedDatabaseProxy(baseDb as never, {
    requireScope: true,
    label: 'startup test db',
  });
  const touchDb = () => (db as unknown as { marker(): string }).marker();

  const tasksService = {
    getOrphaned: vi.fn(async () => {
      touchDb();
      return fixtures.orphanedTasks ?? [];
    }),
    find: vi.fn(async (params: { query?: { status?: string; $skip?: number } }) => {
      touchDb();
      if (params?.query?.status === TaskStatus.QUEUED) {
        const matches = fixtures.queuedTasks ?? [];
        const skip = params.query.$skip ?? 0;
        return { data: matches.slice(skip, skip + 1000), total: matches.length };
      }
      return { data: [], total: 0 };
    }),
    get: vi.fn(async (id: string) => {
      touchDb();
      const task = fixtures.tasksById?.[id];
      if (!task) {
        throw new Error(`Task not found: ${id}`);
      }
      return task;
    }),
    patch: vi.fn(),
    claimTermination: vi.fn(async (input: { taskId: string }) => ({
      outcome: 'claimed',
      task: (fixtures.orphanedTasks ?? []).find((task) => task.task_id === input.taskId),
    })),
    reconcileSessionState: vi.fn(),
    repairTerminalConsequences: vi.fn(),
  };
  const sessionsService = {
    find: vi.fn(
      async (params: {
        query?: { status?: string; ready_for_prompt?: boolean; $skip?: number };
      }) => {
        touchDb();
        if (
          params?.query?.status === SessionStatus.IDLE &&
          params?.query?.ready_for_prompt === false
        ) {
          const matches = fixtures.idleNotReadySessions ?? [];
          const skip = params.query.$skip ?? 0;
          return { data: matches.slice(skip, skip + 1000), total: matches.length };
        }
        return { data: [], total: 0 };
      }
    ),
    get: vi.fn(async (id: string) => {
      touchDb();
      const session = fixtures.sessionsById?.[id];
      if (!session) {
        throw new Error(`Session not found: ${id}`);
      }
      return session;
    }),
    patch: vi.fn(),
  };
  tasksService.reconcileSessionState.mockImplementation(async (id: string, params: unknown) => {
    await sessionsService.patch(id, { ready_for_prompt: true }, params);
    return fixtures.sessionsById?.[id] ?? makeSession({ session_id: id, ready_for_prompt: true });
  });
  const services = new Map<string, unknown>([
    ['tasks', tasksService],
    ['sessions', sessionsService],
  ]);
  const app = {
    service: vi.fn((name: string) => services.get(name)),
  };

  const ctx = {
    app,
    db,
    config: {
      multi_tenancy: {
        mode: 'static',
        static_tenant_id: 'startup-tenant',
        auth_claim: 'tenant_id',
      },
    },
    DAEMON_PORT: 3030,
    DAEMON_HOST: 'localhost',
    safeService: vi.fn(),
    getSocketServer: vi.fn(() => null),
    sessionsService,
    terminalsService: null,
    distributedWorkIdentity: { instanceId: 'startup-test', bootId: 'startup-test-boot' },
    taskRuntimePolicy: 'standalone',
    environmentHealthMonitorPolicy: 'standalone',
  } as unknown as StartupContext;

  return { ctx, baseDb, tasksService, sessionsService };
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    task_id: 'task-1',
    session_id: 'session-1',
    status: TaskStatus.RUNNING,
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function makeSession(overrides: Partial<Session>): Session {
  return {
    session_id: 'session-1',
    agentic_tool: 'codex',
    status: SessionStatus.IDLE,
    ready_for_prompt: false,
    tasks: [],
    ...overrides,
  } as Session;
}

describe('startup tenant database scope', () => {
  it('contains local executors only under the standalone shutdown contract', () => {
    expect(shouldContainLocalExecutorsOnShutdown('standalone')).toBe(true);
    expect(shouldContainLocalExecutorsOnShutdown('shared_postgres')).toBe(false);
  });

  it('preserves terminal socket disconnects in standalone and reconnects only in HA', () => {
    expect(shouldReconnectSocketClientsOnShutdown('standalone')).toBe(false);
    expect(shouldReconnectSocketClientsOnShutdown('shared_postgres')).toBe(true);
  });

  it('leaves healthy Tasks, Sessions, and queued work untouched in shared PostgreSQL mode', async () => {
    const { ctx, tasksService, sessionsService } = makeStartupContextWithGuardedDb({
      orphanedTasks: [makeTask({ status: TaskStatus.RUNNING })],
      queuedTasks: [makeTask({ task_id: 'queued-1', status: TaskStatus.QUEUED })],
    });
    ctx.taskRuntimePolicy = 'shared_postgres';

    await expect(prepareTaskRuntimeStartup(ctx)).resolves.toBeNull();
    expect(tasksService.getOrphaned).not.toHaveBeenCalled();
    expect(tasksService.find).not.toHaveBeenCalled();
    expect(tasksService.patch).not.toHaveBeenCalled();
    expect(tasksService.claimTermination).not.toHaveBeenCalled();
    expect(sessionsService.find).not.toHaveBeenCalled();
    expect(sessionsService.patch).not.toHaveBeenCalled();
  });

  it.each([
    ['daemon-a', 'boot-a'],
    ['daemon-b', 'boot-b'],
  ])(
    'constructs and initializes the distributed environment monitor on HA replica %s',
    async (instanceId, bootId) => {
      const { ctx } = makeStartupContextWithGuardedDb();
      ctx.distributedWorkIdentity = { instanceId, bootId };
      ctx.taskRuntimePolicy = 'shared_postgres';
      ctx.environmentHealthMonitorPolicy = 'shared_postgres';
      ctx.environmentHealthMonitorSettings = {
        scanIntervalMs: 5_000,
        maxIdleIntervalMs: 30_000,
        startupOffsetMaxMs: 3_000,
        scanBatchSize: 32,
        maxInFlight: 8,
        httpTimeoutMs: 1_000,
        claimLeaseMs: 15_000,
        shutdownDrainTimeoutMs: 5_000,
      };
      const initialize = vi.fn(async () => undefined);
      const cleanup = vi.fn();
      const factory = vi.fn(() => ({ initialize, cleanup }));

      const monitor = createEnvironmentHealthMonitor(ctx, factory);

      expect(monitor).not.toBeNull();
      expect(factory).toHaveBeenCalledWith('shared_postgres', ctx.app, ctx);
      expect(initializeEnvironmentHealthMonitor(monitor)).toBe(true);
      await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    }
  );

  it('preserves environment monitor construction and initialization in standalone', async () => {
    const { ctx } = makeStartupContextWithGuardedDb();
    ctx.taskRuntimePolicy = 'standalone';
    ctx.environmentHealthMonitorPolicy = 'standalone';
    const initialize = vi.fn(async () => undefined);
    const cleanup = vi.fn();
    const factory = vi.fn(() => ({ initialize, cleanup }));

    const monitor = createEnvironmentHealthMonitor(ctx, factory);

    expect(monitor).not.toBeNull();
    expect(factory).toHaveBeenCalledOnce();
    expect(initializeEnvironmentHealthMonitor(monitor)).toBe(true);
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
  });

  it('refuses the environment monitor when a shared runtime caller supplies a mismatched policy', () => {
    const { ctx } = makeStartupContextWithGuardedDb();
    ctx.taskRuntimePolicy = 'shared_postgres';
    ctx.environmentHealthMonitorPolicy = 'standalone';
    const factory = vi.fn();

    expect(createEnvironmentHealthMonitor(ctx, factory)).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it('runs recovery inside short configured tenant DB scopes', async () => {
    const { ctx, baseDb } = makeStartupContextWithGuardedDb();

    await expect(cleanupOrphanStatuses(ctx)).resolves.toMatchObject({
      orphanedTasks: [],
      orphanedSessions: [],
      sessionsResetFromOrphanedTasks: 0,
    });
    expect(baseDb.marker).toHaveBeenCalled();
  });

  it('does not share one database scope across runtime recovery units', async () => {
    const task = makeTask({});
    const session = makeSession({ status: SessionStatus.RUNNING, tasks: [task.task_id] as never });
    const { ctx, tasksService, sessionsService } = makeStartupContextWithGuardedDb({
      orphanedTasks: [task],
      sessionsById: { [session.session_id]: session },
    });
    const scopes: unknown[] = [];
    const captureScope = () => {
      const scope = getCurrentTenantDatabaseScope();
      expect(scope).toBeTruthy();
      scopes.push(scope);
    };
    tasksService.getOrphaned.mockImplementation(async () => {
      captureScope();
      return [task];
    });
    tasksService.claimTermination.mockImplementation(async () => {
      captureScope();
      return { outcome: 'claimed', task };
    });
    sessionsService.find.mockImplementation(async (params: { query?: { status?: string } }) => {
      captureScope();
      const matches = params.query?.status === SessionStatus.RUNNING ? [session] : [];
      return { data: matches, total: matches.length };
    });
    tasksService.reconcileSessionState.mockImplementation(async () => {
      captureScope();
      return session;
    });

    await cleanupOrphanStatuses(ctx);

    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it('claims orphaned execution for containment without terminalizing it or wiping its queue', async () => {
    const task = makeTask({});
    const queued = makeTask({ task_id: 'queued-1', status: TaskStatus.QUEUED });
    const { ctx, tasksService } = makeStartupContextWithGuardedDb({
      orphanedTasks: [task],
      queuedTasks: [queued],
    });

    const result = await cleanupOrphanStatuses(ctx);

    expect(tasksService.claimTermination).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.task_id, cause: 'daemon_restart' }),
      expect.anything()
    );
    expect(tasksService.patch).not.toHaveBeenCalled();
    expect(tasksService.find).not.toHaveBeenCalled();
    expect(result.orphanedTasks).toEqual([task]);
  });

  it('reconciles active Session projection from the claimed Task truth', async () => {
    const task = makeTask({});
    const session = makeSession({ status: SessionStatus.RUNNING, tasks: [task.task_id] as never });
    const { ctx, tasksService } = makeStartupContextWithGuardedDb({
      orphanedTasks: [task],
      sessionsById: { [session.session_id]: session },
    });
    const sessionsService = ctx.sessionsService as unknown as { find: ReturnType<typeof vi.fn> };
    sessionsService.find.mockImplementation(async (params: { query?: { status?: string } }) => ({
      data: params.query?.status === SessionStatus.RUNNING ? [session] : [],
      total: params.query?.status === SessionStatus.RUNNING ? 1 : 0,
    }));

    await cleanupOrphanStatuses(ctx);

    expect(tasksService.reconcileSessionState).toHaveBeenCalledWith(
      session.session_id,
      expect.objectContaining({ suppressTerminalQueueProcessing: true })
    );
  });

  it('demonstrates guarded startup DB access fails without scope', () => {
    const { baseDb, ctx } = makeStartupContextWithGuardedDb();
    expect(() => (ctx.db as unknown as { marker(): string }).marker()).toThrow(
      MissingTenantDatabaseScopeError
    );
    expect(baseDb.marker).not.toHaveBeenCalled();
  });

  it('preserves every durable queued task for the fleet queue worker', async () => {
    const queuedTasks = Array.from({ length: 1001 }, (_, index) =>
      makeTask({ task_id: `queued-${index}`, status: TaskStatus.QUEUED })
    );
    const { ctx, tasksService } = makeStartupContextWithGuardedDb({ queuedTasks });

    await cleanupOrphanStatuses(ctx);

    expect(tasksService.patch).not.toHaveBeenCalled();
    expect(tasksService.find).not.toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ status: TaskStatus.QUEUED }) })
    );
  });

  it('re-enters each discovered tenant instead of using the static fallback', async () => {
    const discovery = vi
      .spyOn(RuntimeRecoveryDiscoveryRepository.prototype, 'findRecoveryTenantIds')
      .mockResolvedValue(['tenant-a', 'tenant-b'] as never);
    const { ctx, tasksService } = makeStartupContextWithGuardedDb();
    (ctx.config.multi_tenancy as { mode: string }).mode = 'required_from_auth';
    const seen: Array<string | undefined> = [];
    tasksService.getOrphaned.mockImplementation(async () => {
      const tenantId = getCurrentTenantId();
      if (tenantId !== 'tenant-a' && tenantId !== 'tenant-b') {
        throw new Error(`cross-tenant recovery scope: ${tenantId ?? 'missing'}`);
      }
      seen.push(tenantId);
      return [];
    });

    await cleanupOrphanStatuses(ctx);

    expect(seen).toEqual(['tenant-a', 'tenant-b']);
    discovery.mockRestore();
  });

  it('contains outside a transaction before recording notices and repairing consequences', async () => {
    const task = makeTask({});
    const session = makeSession({
      status: SessionStatus.RUNNING,
      tasks: [task.task_id] as never,
    });
    const { ctx, tasksService } = makeStartupContextWithGuardedDb({
      orphanedTasks: [task],
      sessionsById: { [session.session_id]: session },
    });
    const order: string[] = [];
    let finishContainment: () => void = () => undefined;
    const containmentGate = new Promise<void>((resolve) => {
      finishContainment = resolve;
    });
    const containment = vi
      .spyOn(terminationCoordinator, 'requestExecutorTermination')
      .mockImplementation(async (input) => {
        order.push('containment-start');
        expect(getCurrentTenantId()).toBe('startup-tenant');
        expect(() => (ctx.db as unknown as { marker(): string }).marker()).toThrow(
          MissingTenantDatabaseScopeError
        );
        expect(input.params).toMatchObject({ suppressTerminalQueueProcessing: true });
        await containmentGate;
        order.push('containment-end');
        return { status: 'terminal', task };
      });
    const countMessages = vi
      .spyOn(SessionRepository.prototype, 'countMessages')
      .mockImplementation(async () => {
        expect((ctx.db as unknown as { marker(): string }).marker()).toBe('scoped');
        order.push('notice');
        return 0;
      });
    const appendNotice = vi
      .spyOn(systemMessages, 'appendSystemMessage')
      .mockResolvedValue({ index: 0 } as never);
    tasksService.repairTerminalConsequences.mockImplementation(async () => {
      order.push('repair');
    });

    const recovery = resumeRuntimeRecovery(ctx, {
      wasGraceful: false,
      recoveries: [
        {
          tenantId: 'startup-tenant',
          orphanedTasks: [task],
          orphanedSessions: [session],
        },
      ],
    } as Awaited<ReturnType<typeof cleanupOrphanStatuses>>);
    await vi.waitFor(() => expect(order).toEqual(['containment-start']));
    finishContainment();
    await recovery;

    expect(order).toEqual(['containment-start', 'containment-end', 'notice', 'repair']);
    expect(appendNotice).toHaveBeenCalledOnce();
    expect(containment).toHaveBeenCalledOnce();
    expect(countMessages).toHaveBeenCalledOnce();
  });

  it('continues restart repair when one containment attempt fails', async () => {
    const task = makeTask({});
    const { ctx, tasksService } = makeStartupContextWithGuardedDb({ orphanedTasks: [task] });
    vi.spyOn(terminationCoordinator, 'requestExecutorTermination').mockRejectedValue(
      new Error('transient containment failure')
    );
    vi.spyOn(SessionRepository.prototype, 'countMessages').mockResolvedValue(0);
    vi.spyOn(systemMessages, 'appendSystemMessage').mockResolvedValue({ index: 0 } as never);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await resumeRuntimeRecovery(ctx, {
      wasGraceful: false,
      recoveries: [
        {
          tenantId: 'startup-tenant',
          orphanedTasks: [task],
          orphanedSessions: [],
        },
      ],
    } as Awaited<ReturnType<typeof cleanupOrphanStatuses>>);

    expect(tasksService.repairTerminalConsequences).toHaveBeenCalledOnce();
  });
});

describe('stuck-idle sweep (IDLE + ready_for_prompt=false)', () => {
  it('unblocks an interrupted session whose latest task was orphan-stopped this boot', async () => {
    // Kill-during-stop race: stop path wrote status=idle but died before
    // ready_for_prompt=true; the executing task is orphaned at boot.
    const task = makeTask({ task_id: 'task-1', session_id: 'session-1' });
    const session = makeSession({
      session_id: 'session-1',
      tasks: ['task-1'] as Session['tasks'],
    });
    const { ctx, sessionsService } = makeStartupContextWithGuardedDb({
      orphanedTasks: [task],
      idleNotReadySessions: [session],
      sessionsById: { 'session-1': session },
    });

    await cleanupOrphanStatuses(ctx);

    expect(sessionsService.patch).toHaveBeenCalledWith(
      'session-1',
      { ready_for_prompt: true },
      expect.anything()
    );
  });

  it('unblocks a session whose latest task is still in a non-terminal state', async () => {
    // Daemon died between task creation and executor start — task row exists
    // in a pre-executor state that neither the orphan nor queue pass touched.
    const task = makeTask({
      task_id: 'task-2',
      session_id: 'session-2',
      status: TaskStatus.CREATED,
    });
    const session = makeSession({
      session_id: 'session-2',
      tasks: ['task-2'] as Session['tasks'],
    });
    const { ctx, sessionsService } = makeStartupContextWithGuardedDb({
      idleNotReadySessions: [session],
      tasksById: { 'task-2': task },
    });

    await cleanupOrphanStatuses(ctx);

    expect(sessionsService.patch).toHaveBeenCalledWith(
      'session-2',
      { ready_for_prompt: true },
      expect.anything()
    );
  });

  it('leaves a read session untouched across daemon restarts (latest task terminal)', async () => {
    // The normal resting state of a read/acknowledged session: the UI patched
    // ready_for_prompt=false on open, and its latest task completed long ago.
    const task = makeTask({
      task_id: 'task-3',
      session_id: 'session-3',
      status: TaskStatus.COMPLETED,
    });
    const session = makeSession({
      session_id: 'session-3',
      tasks: ['task-3'] as Session['tasks'],
    });
    const { ctx, sessionsService } = makeStartupContextWithGuardedDb({
      idleNotReadySessions: [session],
      tasksById: { 'task-3': task },
    });

    // Two consecutive boots — the session must never be re-flagged unread.
    await cleanupOrphanStatuses(ctx);
    await cleanupOrphanStatuses(ctx);

    expect(sessionsService.patch).not.toHaveBeenCalled();
  });

  it('leaves a session with no tasks untouched', async () => {
    const session = makeSession({ session_id: 'session-4', tasks: [] as Session['tasks'] });
    const { ctx, sessionsService } = makeStartupContextWithGuardedDb({
      idleNotReadySessions: [session],
    });

    await cleanupOrphanStatuses(ctx);

    expect(sessionsService.patch).not.toHaveBeenCalled();
  });

  it('fails closed when the latest task row cannot be loaded', async () => {
    const session = makeSession({
      session_id: 'session-5',
      tasks: ['task-missing'] as Session['tasks'],
    });
    const { ctx, sessionsService } = makeStartupContextWithGuardedDb({
      idleNotReadySessions: [session],
    });

    await cleanupOrphanStatuses(ctx);

    expect(sessionsService.patch).not.toHaveBeenCalled();
  });
});
