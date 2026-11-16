import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  rawRows,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  sql,
} from '@agor/core/db';
import { TaskStatus } from '@agor/core/types';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureRepoOriginAlignedById } from '../utils/realign-repo-origin';
import { TasksService } from './tasks';

vi.mock('../utils/realign-repo-origin', () => ({ ensureRepoOriginAlignedById: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  'completion fanout follows native commit, never rollback (%s)',
  async (rollback) => {
    const raw = createDatabase({ dialect: 'sqlite', url: ':memory:' });
    const db = createTenantScopedDatabaseProxy(raw);
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000099',
      session_id: '018f0000-0000-7000-8000-000000000098',
      status: TaskStatus.FAILED,
    };
    const session = {
      session_id: task.session_id,
      branch_id: 'fixture-branch',
      fork_origin: 'btw',
      tasks: [task.task_id],
    };
    let originalScope: ReturnType<typeof getCurrentTenantDatabaseScope>;
    const archive = vi.fn(async () => {
      expect(getCurrentTenantDatabaseScope()).toBe(originalScope);
      await executeRaw(db, sql`INSERT INTO completion_fixture VALUES ('archive')`);
    });
    const patchSession = vi.fn();
    let injectionVerified = false;
    let originVerified = false;
    const inject = vi.fn(async () => {
      expect(getCurrentTenantDatabaseScope()).not.toBe(originalScope);
      expect(getCurrentTenantId()).toBe('tenant-completion');
      expect(
        rawRows(await executeRaw(db, sql`SELECT id FROM completion_fixture ORDER BY id`))
      ).toEqual([{ id: 'archive' }, { id: 'projection' }, { id: 'task' }]);
      await expect(
        runWithTenantDatabaseScope(db, 'foreign-tenant', async () => {})
      ).rejects.toThrow('active tenant');
      injectionVerified = true;
    });
    const origin = vi.mocked(ensureRepoOriginAlignedById).mockImplementation(async () => {
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      expect(getCurrentTenantId()).toBe('tenant-completion');
      originVerified = true;
    });
    origin.mockClear();
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'db', db);
    Reflect.set(
      service,
      'get',
      vi.fn(async () => ({ ...task, status: TaskStatus.RUNNING }))
    );
    Reflect.set(service, 'id', 'task_id');
    Reflect.set(service, 'repository', {
      update: async () => {
        expect(getCurrentTenantDatabaseScope()).toBe(originalScope);
        // TaskRepository owns both writes atomically; the service only
        // publishes the resulting Session, never patches it a second time.
        await executeRaw(db, sql`INSERT INTO completion_fixture VALUES ('task')`);
        await executeRaw(db, sql`INSERT INTO completion_fixture VALUES ('projection')`);
        return task;
      },
    });
    Reflect.set(service, 'injectBtwResultMessage', inject);
    Reflect.set(
      service,
      'dispatchCompletionCallbacks',
      vi.fn(async () => {})
    );
    Reflect.set(service, 'app', {
      service: (name: string) =>
        name === 'branches'
          ? { get: async () => ({ repo_id: 'fixture-repo' }) }
          : { get: async () => session, patch: patchSession, archiveBtwSession: archive },
    });
    try {
      await executeRaw(raw, sql`CREATE TABLE completion_fixture (id TEXT PRIMARY KEY)`);
      const completion = runWithTenantDatabaseTransaction(db, 'tenant-completion', async () => {
        originalScope = getCurrentTenantDatabaseScope();
        await service.patch(
          task.task_id,
          { status: TaskStatus.FAILED },
          { suppressTerminalQueueProcessing: true }
        );
        expect(archive).toHaveBeenCalledOnce();
        expect(patchSession).not.toHaveBeenCalled();
        expect(inject).not.toHaveBeenCalled();
        expect(origin).not.toHaveBeenCalled();
        if (rollback) throw new Error('fixture rollback');
      });
      if (rollback) await expect(completion).rejects.toThrow('fixture rollback');
      else await completion;
      await nextTurn();
      expect(inject).toHaveBeenCalledTimes(rollback ? 0 : 1);
      expect(origin).toHaveBeenCalledTimes(rollback ? 0 : 1);
      expect(injectionVerified).toBe(!rollback);
      expect(originVerified).toBe(!rollback);
      if (rollback)
        expect(rawRows(await executeRaw(raw, sql`SELECT id FROM completion_fixture`))).toEqual([]);
    } finally {
      (raw as typeof raw & { $client: { close(): void } }).$client.close();
    }
  }
);

it.each([false, true])(
  'gateway final reply flush follows native commit, never rollback (%s)',
  async (rollback) => {
    const raw = createDatabase({ dialect: 'sqlite', url: ':memory:' });
    const db = createTenantScopedDatabaseProxy(raw);
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000088',
      session_id: '018f0000-0000-7000-8000-000000000087',
      status: TaskStatus.COMPLETED,
      metadata: {
        gateway_reply_metadata: { processing_comment_id: 42 },
      },
    };
    const session = {
      session_id: task.session_id,
      tasks: [task.task_id],
      title: 'Existing Non-Null Title',
    };
    const patchSession = vi.fn();
    const flushOutboundBuffer = vi.fn(async () => {});
    const updateProgress = vi.fn(async () => {});
    const wakeDeliveryLoop = vi.fn();

    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'db', db);
    Reflect.set(
      service,
      'get',
      vi.fn(async () => ({ ...task, status: TaskStatus.RUNNING }))
    );
    Reflect.set(service, 'id', 'task_id');
    Reflect.set(service, 'repository', {
      update: async () => task,
    });
    Reflect.set(
      service,
      'dispatchCompletionCallbacks',
      vi.fn(async () => {})
    );
    Reflect.set(service, 'app', {
      service: (name: string) => {
        if (name === 'sessions') {
          return { get: async () => session, patch: patchSession };
        }
        if (name === 'gateway') {
          return { flushOutboundBuffer, updateProgress, wakeDeliveryLoop };
        }
        return {};
      },
    });

    try {
      const completion = runWithTenantDatabaseTransaction(
        db,
        'tenant-gateway-completion',
        async () => {
          await service.patch(
            task.task_id,
            { status: TaskStatus.COMPLETED },
            { suppressTerminalQueueProcessing: true }
          );
          expect(patchSession).not.toHaveBeenCalled();
          expect(flushOutboundBuffer).not.toHaveBeenCalled();
          expect(updateProgress).not.toHaveBeenCalled();
          if (rollback) throw new Error('gateway test rollback');
        }
      );

      if (rollback) await expect(completion).rejects.toThrow('gateway test rollback');
      else await completion;

      await nextTurn();
      expect(patchSession).not.toHaveBeenCalled();
      expect(flushOutboundBuffer).toHaveBeenCalledTimes(rollback ? 0 : 1);
      expect(updateProgress).toHaveBeenCalledTimes(rollback ? 0 : 1);
      if (!rollback) {
        expect(flushOutboundBuffer).toHaveBeenCalledWith(task.session_id, {
          taskId: task.task_id,
        });
        expect(updateProgress).toHaveBeenCalledWith({
          session_id: task.session_id,
          task_id: task.task_id,
          state: 'done',
        });
        expect(wakeDeliveryLoop).toHaveBeenCalledTimes(1);
      }
    } finally {
      (raw as typeof raw & { $client: { close(): void } }).$client.close();
    }
  }
);

it.each([false, true])(
  'Slack string thread identifiers do not block completion and dispatch progress post-commit (%s)',
  async (rollback) => {
    const raw = createDatabase({ dialect: 'sqlite', url: ':memory:' });
    const db = createTenantScopedDatabaseProxy(raw);
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000089',
      session_id: '018f0000-0000-7000-8000-000000000087',
      status: TaskStatus.COMPLETED,
      metadata: {
        // Slack uses string thread timestamp without a numeric comment ID
        gateway_task_source: {
          thread_id: '1712345678.999999',
          channel_type: 'slack',
        },
      },
    };
    const session = {
      session_id: task.session_id,
      tasks: [task.task_id],
      title: 'Slack Thread Session',
    };
    const patchSession = vi.fn();
    const flushOutboundBuffer = vi.fn(async () => {});
    const updateProgress = vi.fn(async () => {});
    const wakeDeliveryLoop = vi.fn();

    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'db', db);
    Reflect.set(
      service,
      'get',
      vi.fn(async () => ({ ...task, status: TaskStatus.RUNNING }))
    );
    Reflect.set(service, 'id', 'task_id');
    Reflect.set(service, 'repository', {
      update: async () => task,
    });
    Reflect.set(
      service,
      'dispatchCompletionCallbacks',
      vi.fn(async () => {})
    );
    Reflect.set(service, 'app', {
      service: (name: string) => {
        if (name === 'sessions') {
          return { get: async () => session, patch: patchSession };
        }
        if (name === 'gateway') {
          return { flushOutboundBuffer, updateProgress, wakeDeliveryLoop };
        }
        return {};
      },
    });

    try {
      const completion = runWithTenantDatabaseTransaction(
        db,
        'tenant-slack-completion',
        async () => {
          await service.patch(
            task.task_id,
            { status: TaskStatus.COMPLETED },
            { suppressTerminalQueueProcessing: true }
          );
          expect(patchSession).not.toHaveBeenCalled();
          expect(updateProgress).not.toHaveBeenCalled();
          if (rollback) throw new Error('slack test rollback');
        }
      );

      if (rollback) await expect(completion).rejects.toThrow('slack test rollback');
      else await completion;

      await nextTurn();
      expect(patchSession).not.toHaveBeenCalled();
      expect(updateProgress).toHaveBeenCalledTimes(rollback ? 0 : 1);
      if (!rollback) {
        expect(updateProgress).toHaveBeenCalledWith({
          session_id: task.session_id,
          task_id: task.task_id,
          state: 'done',
        });
        expect(wakeDeliveryLoop).toHaveBeenCalledTimes(1);
      }
    } finally {
      (raw as typeof raw & { $client: { close(): void } }).$client.close();
    }
  }
);

it('flush failure does not prevent progress dispatch or delivery loop wake', async () => {
  const raw = createDatabase({ dialect: 'sqlite', url: ':memory:' });
  const db = createTenantScopedDatabaseProxy(raw);
  const task = {
    task_id: '018f0000-0000-7000-8000-000000000091',
    session_id: '018f0000-0000-7000-8000-000000000087',
    status: TaskStatus.COMPLETED,
  };
  const session = {
    session_id: task.session_id,
    tasks: [task.task_id],
    title: 'Fault Isolation Test',
  };
  const flushOutboundBuffer = vi.fn(async () => {
    throw new Error('Transient provider 429');
  });
  const updateProgress = vi.fn(async () => {});
  const wakeDeliveryLoop = vi.fn();

  const service = Object.create(TasksService.prototype) as TasksService;
  Reflect.set(service, 'db', db);
  Reflect.set(
    service,
    'get',
    vi.fn(async () => ({ ...task, status: TaskStatus.RUNNING }))
  );
  Reflect.set(service, 'id', 'task_id');
  Reflect.set(service, 'repository', {
    update: async () => task,
  });
  Reflect.set(
    service,
    'dispatchCompletionCallbacks',
    vi.fn(async () => {})
  );
  Reflect.set(service, 'app', {
    service: (name: string) => {
      if (name === 'sessions') {
        return { get: async () => session, patch: vi.fn() };
      }
      if (name === 'gateway') {
        return { flushOutboundBuffer, updateProgress, wakeDeliveryLoop };
      }
      return {};
    },
  });

  try {
    await service.patch(
      task.task_id,
      { status: TaskStatus.COMPLETED },
      { suppressTerminalQueueProcessing: true }
    );
    await nextTurn();

    expect(flushOutboundBuffer).toHaveBeenCalledTimes(1);
    expect(updateProgress).toHaveBeenCalledWith({
      session_id: task.session_id,
      task_id: task.task_id,
      state: 'done',
    });
    expect(wakeDeliveryLoop).toHaveBeenCalledTimes(1);
  } finally {
    (raw as typeof raw & { $client: { close(): void } }).$client.close();
  }
});
