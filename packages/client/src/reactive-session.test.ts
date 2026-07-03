import type { AgorClient, Message, Session, Task } from '@agor/core/client';
import { TaskStatus } from '@agor/core/client';
import { describe, expect, it, vi } from 'vitest';
import { ReactiveSessionHandle, type TaskHydrationMode } from './reactive-session';

const SESSION_ID = 'session-1';

function makeTask(taskId: string, status: TaskStatus): Task {
  return {
    task_id: taskId,
    session_id: SESSION_ID,
    status,
  } as unknown as Task;
}

function makeMessage(taskId: string, index: number): Message {
  return {
    message_id: `${taskId}-msg-${index}`,
    session_id: SESSION_ID,
    task_id: taskId,
    index,
  } as unknown as Message;
}

interface MockClientOptions {
  tasks: Task[];
  messagesByTask: Record<string, Message[]>;
  failTaskMessageFetch?: boolean;
}

function createMockClient(opts: MockClientOptions) {
  const messageFindAll = vi.fn(async ({ query }: { query: Record<string, unknown> }) => {
    if (typeof query.task_id === 'string') {
      if (opts.failTaskMessageFetch) {
        throw new Error('latest-task message fetch failed');
      }
      return opts.messagesByTask[query.task_id] ?? [];
    }
    // Eager path: every message for the session.
    return Object.values(opts.messagesByTask).flat();
  });

  const listener = () => ({ on: vi.fn(), removeListener: vi.fn() });

  const services: Record<string, unknown> = {
    sessions: { get: vi.fn(async () => ({ session_id: SESSION_ID }) as Session), ...listener() },
    tasks: { findAll: vi.fn(async () => opts.tasks), ...listener() },
    messages: { findAll: messageFindAll, ...listener() },
  };
  const queueService = { find: vi.fn(async () => ({ data: [] })) };

  const client = {
    io: { connected: true, on: vi.fn(), off: vi.fn() },
    service: vi.fn((name: string) =>
      name.includes('/tasks/queue') ? queueService : services[name]
    ),
  } as unknown as AgorClient;

  return { client, messageFindAll };
}

async function bootstrapHandle(opts: MockClientOptions, taskHydration: TaskHydrationMode) {
  const { client, messageFindAll } = createMockClient(opts);
  const handle = new ReactiveSessionHandle(client, SESSION_ID, { taskHydration });
  await handle.ready();
  return { handle, messageFindAll };
}

describe('ReactiveSessionHandle bootstrap hydration', () => {
  const tasks = [
    makeTask('task-1', TaskStatus.COMPLETED),
    makeTask('task-2', TaskStatus.COMPLETED),
    makeTask('task-3', TaskStatus.QUEUED),
  ];
  const messagesByTask = {
    'task-1': [makeMessage('task-1', 0)],
    'task-2': [makeMessage('task-2', 1), makeMessage('task-2', 0)],
  };

  it('lazy: hydrates the latest non-queued task only', async () => {
    const { handle, messageFindAll } = await bootstrapHandle({ tasks, messagesByTask }, 'lazy');

    // task-3 is queued, so the latest hydratable task is task-2.
    expect(handle.isTaskLoaded('task-2')).toBe(true);
    expect(handle.isTaskLoaded('task-1')).toBe(false);
    expect(handle.isTaskLoaded('task-3')).toBe(false);

    // Messages are seeded and index-sorted.
    expect(handle.getTaskMessages('task-2').map((m) => m.index)).toEqual([0, 1]);
    expect(handle.getTaskMessages('task-1')).toEqual([]);

    // Only the latest task's messages were fetched at bootstrap.
    expect(messageFindAll).toHaveBeenCalledTimes(1);
    expect(messageFindAll).toHaveBeenCalledWith({
      query: { task_id: 'task-2', $sort: { index: 1 } },
    });
  });

  it('eager: hydrates every task', async () => {
    const { handle } = await bootstrapHandle({ tasks, messagesByTask }, 'eager');

    expect(handle.isTaskLoaded('task-1')).toBe(true);
    expect(handle.isTaskLoaded('task-2')).toBe(true);
  });

  it('none: hydrates no task', async () => {
    const { handle, messageFindAll } = await bootstrapHandle({ tasks, messagesByTask }, 'none');

    expect(handle.isTaskLoaded('task-1')).toBe(false);
    expect(handle.isTaskLoaded('task-2')).toBe(false);
    expect(messageFindAll).not.toHaveBeenCalled();
  });

  it('lazy: a failing latest-task fetch still resolves bootstrap (graceful degradation)', async () => {
    const { handle } = await bootstrapHandle(
      { tasks, messagesByTask, failTaskMessageFetch: true },
      'lazy'
    );

    // Bootstrap completed despite the fetch throwing.
    expect(handle.state.loading).toBe(false);
    expect(handle.state.error).toBeNull();
    // The latest task is left unhydrated for TaskBlock to lazy-load later.
    expect(handle.isTaskLoaded('task-2')).toBe(false);
  });

  it('lazy: hydrates nothing when every task is queued', async () => {
    const allQueued = [
      makeTask('task-1', TaskStatus.QUEUED),
      makeTask('task-2', TaskStatus.QUEUED),
    ];
    const { handle, messageFindAll } = await bootstrapHandle(
      { tasks: allQueued, messagesByTask: {} },
      'lazy'
    );

    expect(handle.state.loading).toBe(false);
    expect(handle.isTaskLoaded('task-1')).toBe(false);
    expect(handle.isTaskLoaded('task-2')).toBe(false);
    expect(messageFindAll).not.toHaveBeenCalled();
  });

  it('lazy: hydrates nothing when there are no tasks', async () => {
    const { handle, messageFindAll } = await bootstrapHandle(
      { tasks: [], messagesByTask: {} },
      'lazy'
    );

    expect(handle.state.loading).toBe(false);
    expect(messageFindAll).not.toHaveBeenCalled();
  });
});

describe('ReactiveSessionHandle resync hydration parity', () => {
  it('lazy: keeps the latest task hydrated and adopts a new latest task on resync', async () => {
    const opts: MockClientOptions = {
      tasks: [
        makeTask('task-1', TaskStatus.COMPLETED),
        makeTask('task-2', TaskStatus.COMPLETED),
        makeTask('task-3', TaskStatus.QUEUED),
      ],
      messagesByTask: {
        'task-1': [makeMessage('task-1', 0)],
        'task-2': [makeMessage('task-2', 0)],
      },
    };
    const { client, messageFindAll } = createMockClient(opts);
    const handle = new ReactiveSessionHandle(client, SESSION_ID, { taskHydration: 'lazy' });
    await handle.ready();

    expect(handle.isTaskLoaded('task-2')).toBe(true);

    // Reconnect with no change: the latest (scroll-target) task stays hydrated.
    await handle.resync();
    expect(handle.isTaskLoaded('task-2')).toBe(true);
    expect(handle.getTaskMessages('task-2')).toHaveLength(1);

    // A new non-queued task became the latest while disconnected.
    opts.tasks = [...opts.tasks, makeTask('task-4', TaskStatus.COMPLETED)];
    opts.messagesByTask['task-4'] = [makeMessage('task-4', 0)];

    await handle.resync();

    expect(handle.isTaskLoaded('task-4')).toBe(true);
    expect(handle.getTaskMessages('task-4')).toHaveLength(1);
    expect(messageFindAll).toHaveBeenCalledWith({
      query: { task_id: 'task-4', $sort: { index: 1 } },
    });
  });
});
