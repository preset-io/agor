import { createTenantScopedDatabaseProxy, MissingTenantDatabaseScopeError } from '@agor/core/db';
import type { Session, Task } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { cleanupOrphanStatuses, type StartupContext } from './startup.js';

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
    find: vi.fn(async (params: { query?: { status?: string } }) => {
      touchDb();
      if (params?.query?.status === TaskStatus.QUEUED) {
        return { data: fixtures.queuedTasks ?? [] };
      }
      return { data: [] };
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
  };
  const sessionsService = {
    find: vi.fn(async (params: { query?: { status?: string; ready_for_prompt?: boolean } }) => {
      touchDb();
      if (
        params?.query?.status === SessionStatus.IDLE &&
        params?.query?.ready_for_prompt === false
      ) {
        return { data: fixtures.idleNotReadySessions ?? [] };
      }
      return { data: [] };
    }),
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
        mode: 'required_from_auth',
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
    status: SessionStatus.IDLE,
    ready_for_prompt: false,
    tasks: [],
    ...overrides,
  } as Session;
}

describe('startup tenant database scope', () => {
  it('runs orphan cleanup inside an explicit startup tenant DB scope', async () => {
    const { ctx, baseDb } = makeStartupContextWithGuardedDb();

    await expect(cleanupOrphanStatuses(ctx)).resolves.toMatchObject({
      orphanedTasks: [],
      orphanedSessions: [],
      queuedTasks: [],
      sessionsResetFromOrphanedTasks: 0,
    });
    expect(baseDb.marker).toHaveBeenCalled();
  });

  it('demonstrates guarded startup DB access fails without scope', () => {
    const { baseDb, ctx } = makeStartupContextWithGuardedDb();

    expect(() => (ctx.db as unknown as { marker(): string }).marker()).toThrow(
      MissingTenantDatabaseScopeError
    );
    expect(baseDb.marker).not.toHaveBeenCalled();
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
