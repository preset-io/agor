import type { AgorClient, Message, Session, Task } from '@agor/core/client';
import { TaskStatus } from '@agor/core/client';
import { describe, expect, it, vi } from 'vitest';
import {
  __streamSubscriptionCountForTest,
  attachReactiveSessionApi,
  ReactiveSessionHandle,
  releaseReactiveSession,
  retainReactiveSession,
  type TaskHydrationMode,
} from './reactive-session';

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
  /** When true, `session-streams.create` blocks until releaseCreate() is called. */
  deferCreate?: boolean;
  deferTaskMessageFetch?: string;
  deferSessionGet?: boolean;
  sessionTaskIds?: string[];
}

function createMockClient(opts: MockClientOptions) {
  // Records the relative order of subscribe vs. hydrate vs. unsubscribe so
  // tests can assert the subscribe-before-hydrate ordering and dispose races.
  const order: string[] = [];

  const messageFetchResolvers: Array<() => void> = [];
  const messageFindAll = vi.fn(async ({ query }: { query: Record<string, unknown> }) => {
    if (
      typeof query.task_id === 'string' ||
      (query.task_id && typeof query.task_id === 'object' && '$in' in query.task_id)
    ) {
      const ids =
        typeof query.task_id === 'string'
          ? [query.task_id]
          : (query.task_id as { $in: string[] }).$in;
      if (opts.failTaskMessageFetch) {
        throw new Error('latest-task message fetch failed');
      }
      const snapshot = ids.flatMap((id) => opts.messagesByTask[id] ?? []);
      if (opts.deferTaskMessageFetch && ids.includes(opts.deferTaskMessageFetch)) {
        await new Promise<void>((resolve) => messageFetchResolvers.push(resolve));
      }
      return query.transcript === 'lean'
        ? snapshot.map((message) => ({
            ...message,
            tool_uses: undefined,
            content: Array.isArray(message.content)
              ? message.content.filter(
                  (block) => !['tool_use', 'tool_result', 'thinking'].includes(block.type)
                )
              : message.content,
          }))
        : snapshot;
    }
    // Eager path: every message for the session.
    return Object.values(opts.messagesByTask).flat();
  });
  const taskFindAll = vi.fn(async (params?: { query?: { status?: { $in?: string[] } } }) =>
    params?.query?.status?.$in
      ? opts.tasks.filter((task) => params.query!.status!.$in!.includes(task.status))
      : opts.tasks
  );

  // Capture service event handlers so tests can fire realtime events (e.g. a
  // streaming:chunk that arrives with no preceding streaming:start).
  const serviceHandlers: Record<string, Record<string, Array<(...a: unknown[]) => void>>> = {};
  const listener = (svc: string) => ({
    on: vi.fn((event: string, handler: (...a: unknown[]) => void) => {
      const byEvent = serviceHandlers[svc] ?? {};
      const handlers = byEvent[event] ?? [];
      handlers.push(handler);
      byEvent[event] = handlers;
      serviceHandlers[svc] = byEvent;
    }),
    removeListener: vi.fn((event: string, handler: (...a: unknown[]) => void) => {
      const handlers = serviceHandlers[svc]?.[event];
      if (!handlers) return;
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }),
  });
  const emitServiceEvent = (svc: string, event: string, payload: unknown) => {
    for (const handler of [...(serviceHandlers[svc]?.[event] ?? [])]) handler(payload);
  };

  // Deferred create() resolvers (queue supports multiple in-flight creates).
  const createResolvers: Array<() => void> = [];
  const sessionGetResolvers: Array<() => void> = [];
  const sessionStreams = {
    create: vi.fn(async () => {
      order.push('subscribe');
      if (opts.deferCreate) {
        await new Promise<void>((resolve) => {
          createResolvers.push(resolve);
        });
      }
      return { session_id: SESSION_ID, subscribed: true };
    }),
    remove: vi.fn(async () => {
      order.push('unsubscribe');
      return { session_id: SESSION_ID, subscribed: false };
    }),
  };

  const services: Record<string, unknown> = {
    sessions: {
      get: vi.fn(async () => {
        order.push('hydrate');
        if (opts.deferSessionGet) {
          await new Promise<void>((resolve) => sessionGetResolvers.push(resolve));
        }
        return {
          session_id: SESSION_ID,
          tasks: opts.sessionTaskIds ?? opts.tasks.map((task) => task.task_id),
        } as Session;
      }),
      ...listener('sessions'),
    },
    tasks: {
      findAll: taskFindAll,
      find: vi.fn(async ({ query }: { query: Record<string, unknown> }) => {
        let rows = [...opts.tasks].sort((a, b) => b.task_id.localeCompare(a.task_id));
        if (typeof query.status === 'string')
          rows = rows.filter((task) => task.status === query.status);
        if (query.status && typeof query.status === 'object' && '$ne' in query.status)
          rows = rows.filter((task) => task.status !== (query.status as { $ne: string }).$ne);
        const cursor = query.task_id as { $lte?: string; $gt?: string } | undefined;
        if (cursor?.$gt) rows = rows.filter((task) => task.task_id > cursor.$gt!);
        if ((query.$sort as { task_id?: number })?.task_id === 1) rows.reverse();
        if (cursor?.$lte) rows = rows.filter((task) => task.task_id <= cursor.$lte!);
        return { data: rows.slice(0, Number(query.$limit)), total: rows.length };
      }),
      get: vi.fn(async (id: string) => {
        const task = opts.tasks.find((task) => task.task_id === id);
        if (!task) throw Object.assign(new Error('Not found'), { code: 404 });
        return task;
      }),
      ...listener('tasks'),
    },
    messages: { findAll: messageFindAll, ...listener('messages') },
    'session-streams': sessionStreams,
  };
  const queueService = { find: vi.fn(async () => ({ data: [] })) };

  const ioHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const client = {
    io: {
      connected: true,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const handlers = ioHandlers[event] ?? [];
        handlers.push(handler);
        ioHandlers[event] = handlers;
      }),
      off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const handlers = ioHandlers[event];
        if (!handlers) return;
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }),
    },
    service: vi.fn((name: string) =>
      name.includes('/tasks/queue') ? queueService : services[name]
    ),
  } as unknown as AgorClient;

  const fireIo = (event: string) => {
    for (const handler of [...(ioHandlers[event] ?? [])]) handler();
  };

  // Release all currently-blocked create() calls (FIFO drain).
  const releaseCreateFn = () => {
    const pending = createResolvers.splice(0);
    for (const resolve of pending) resolve();
  };

  return {
    client,
    messageFindAll,
    taskFindAll,
    sessionStreams,
    fireIo,
    emitServiceEvent,
    order,
    releaseCreate: releaseCreateFn,
    releaseMessageFetch: () => {
      for (const resolve of messageFetchResolvers.splice(0)) resolve();
    },
    releaseSessionGet: () => {
      for (const resolve of sessionGetResolvers.splice(0)) resolve();
    },
  };
}

async function bootstrapHandle(opts: MockClientOptions, taskHydration: TaskHydrationMode) {
  const { client, messageFindAll } = createMockClient(opts);
  const handle = new ReactiveSessionHandle(client, SESSION_ID, { taskHydration });
  await handle.ready();
  return { handle, messageFindAll };
}

describe('shared ReactiveSessionHandle call counts', () => {
  it('uses one lazy bootstrap and one reconnect resync for two open-session consumers', async () => {
    const mock = createMockClient({ tasks: [], messagesByTask: {} });
    const sessionGet = mock.client.service('sessions').get as ReturnType<typeof vi.fn>;

    // SessionPanel and ConversationView now retain this exact same tuple.
    const panel = retainReactiveSession(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    const conversation = retainReactiveSession(mock.client, SESSION_ID, {
      taskHydration: 'lazy',
    });
    expect(conversation).toBe(panel);
    await panel.ready();

    expect(sessionGet).toHaveBeenCalledTimes(1);
    expect(mock.sessionStreams.create).toHaveBeenCalledTimes(1);

    mock.fireIo('disconnect');
    mock.fireIo('connect');
    await vi.waitFor(() => expect(sessionGet).toHaveBeenCalledTimes(2));
    expect(mock.sessionStreams.create).toHaveBeenCalledTimes(2);

    releaseReactiveSession(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    expect(mock.sessionStreams.remove).not.toHaveBeenCalled();
    releaseReactiveSession(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    await vi.waitFor(() => expect(mock.sessionStreams.remove).toHaveBeenCalledTimes(1));
  });
});

describe('ReactiveSessionHandle prompt contract', () => {
  it('returns the admitted Task from the shared sessions helper', async () => {
    const mock = createMockClient({ tasks: [], messagesByTask: {} });
    const admittedTask = makeTask('task-admitted', TaskStatus.DISPATCHING);
    const prompt = vi.fn().mockResolvedValue(admittedTask);
    Object.assign(mock.client, { sessions: { prompt } });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, {
      taskHydration: 'none',
    });
    await handle.ready();

    const result = await handle.prompt('Fix failing tests', {
      permissionMode: 'auto',
    });

    expect(prompt).toHaveBeenCalledWith(SESSION_ID, 'Fix failing tests', {
      permissionMode: 'auto',
    });
    expect(result).toBe(admittedTask);
  });
});

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
      query: { task_id: 'task-2', $sort: { index: 1 }, $limit: 1000 },
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

  it('preserves the canonical Task order stored on the Session', async () => {
    const { handle } = await bootstrapHandle(
      {
        tasks: [tasks[0], tasks[1]],
        sessionTaskIds: [tasks[1].task_id, tasks[0].task_id],
        messagesByTask,
      },
      'none'
    );
    expect(handle.state.tasks.map((task) => task.task_id)).toEqual([
      tasks[1].task_id,
      tasks[0].task_id,
    ]);
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

describe('ReactiveSessionHandle message snapshot reconciliation', () => {
  it('delivers structured Claude task results unchanged over the message realtime path', async () => {
    const task = makeTask('task-tools', TaskStatus.RUNNING);
    const mock = createMockClient({ tasks: [task], messagesByTask: { [task.task_id]: [] } });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    await handle.ready();

    const result = {
      ...makeMessage(task.task_id, 0),
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'create-1',
          content: 'Task created',
          tool_use_result: { task: { id: 'task-7', subject: 'Verify the fix' } },
        },
      ],
    } as Message;
    mock.emitServiceEvent('messages', 'created', result);

    expect(handle.getTaskMessages(task.task_id)).toEqual([result]);
  });

  it.each([
    ['immediate', false],
    ['drained queue', true],
  ])(
    'does not lose a realtime user message during a stale %s task fetch',
    async (_path, startsQueued) => {
      const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
      const mock = createMockClient(opts);
      const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });
      await handle.ready();

      const task = makeTask('new-task', startsQueued ? TaskStatus.QUEUED : TaskStatus.CREATED);
      mock.emitServiceEvent('tasks', 'created', task);
      if (startsQueued) {
        mock.emitServiceEvent('tasks', 'patched', {
          ...task,
          status: TaskStatus.DISPATCHING,
        });
      }
      opts.deferTaskMessageFetch = task.task_id;
      const loading = handle.loadTaskMessages(task.task_id);
      await vi.waitFor(() => expect(mock.messageFindAll).toHaveBeenCalled());

      const created = makeMessage(task.task_id, 2);
      const patched = { ...created, content_preview: 'patched metadata' } as Message;
      const earlier = makeMessage(task.task_id, 1);
      mock.emitServiceEvent('messages', 'created', created);
      mock.emitServiceEvent('messages', 'created', created); // duplicate delivery
      mock.emitServiceEvent('messages', 'patched', patched); // reordered update
      mock.emitServiceEvent('messages', 'created', earlier); // out-of-order index
      mock.emitServiceEvent('messages', 'created', {
        ...makeMessage(task.task_id, 1),
        message_id: 'other-session-message',
        session_id: 'session-2',
      });
      mock.releaseMessageFetch();
      await loading;

      expect(handle.getTaskMessages(task.task_id)).toEqual([earlier, patched]);
    }
  );

  it('does not resurrect a message removed while a reconnect/refetch snapshot is in flight', async () => {
    const existing = makeMessage('task-1', 0);
    const opts: MockClientOptions = {
      tasks: [makeTask('task-1', TaskStatus.COMPLETED)],
      messagesByTask: { 'task-1': [existing] },
    };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    await handle.ready();

    opts.deferTaskMessageFetch = 'task-1';
    const resync = handle.resync();
    await vi.waitFor(() => expect(mock.messageFindAll).toHaveBeenCalledTimes(2));
    mock.emitServiceEvent('messages', 'removed', existing);
    mock.releaseMessageFetch();
    await resync;

    expect(handle.getTaskMessages('task-1')).toEqual([]);
  });

  it('does not recreate a Task message bucket when the Task is removed during load', async () => {
    const task = makeTask('task-removed-during-load', TaskStatus.COMPLETED);
    const stale = makeMessage(task.task_id, 0);
    const opts: MockClientOptions = {
      tasks: [task],
      messagesByTask: { [task.task_id]: [stale] },
    };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    await handle.ready();

    opts.deferTaskMessageFetch = task.task_id;
    const loading = handle.loadTaskMessages(task.task_id);
    await vi.waitFor(() => expect(mock.messageFindAll).toHaveBeenCalledTimes(2));
    mock.emitServiceEvent('tasks', 'removed', task);
    mock.releaseMessageFetch();

    await expect(loading).resolves.toEqual([]);
    expect(handle.state.tasks).toEqual([]);
    expect(handle.state.messagesByTask.has(task.task_id)).toBe(false);
    expect(handle.isTaskLoaded(task.task_id)).toBe(false);
  });

  it('does not reverse an unload that occurs during a direct Task load', async () => {
    const first = makeTask('task-1', TaskStatus.COMPLETED);
    const second = makeTask('task-2', TaskStatus.COMPLETED);
    const snapshot = makeMessage(first.task_id, 0);
    const opts: MockClientOptions = {
      tasks: [first, second],
      messagesByTask: { [first.task_id]: [snapshot], [second.task_id]: [] },
    };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    await handle.ready();

    opts.deferTaskMessageFetch = first.task_id;
    const loading = handle.loadTaskMessages(first.task_id);
    await vi.waitFor(() => expect(mock.messageFindAll).toHaveBeenCalledTimes(2));
    handle.unloadTaskMessages(first.task_id);
    mock.releaseMessageFetch();

    await expect(loading).resolves.toEqual([snapshot]);
    expect(handle.isTaskLoaded(first.task_id)).toBe(false);
    expect(handle.getTaskMessages(first.task_id)).toEqual([]);
  });

  it('reconciles a removal over a large transcript snapshot before commit', async () => {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    await handle.ready();
    const task = makeTask('large-task', TaskStatus.COMPLETED);
    mock.emitServiceEvent('tasks', 'created', task);

    const stale = Array.from({ length: 1000 }, (_, index) => makeMessage(task.task_id, index));
    let releaseFirstPage!: () => void;
    mock.messageFindAll.mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          releaseFirstPage = () => resolve(stale);
        })
    );

    const loading = handle.loadTaskMessages(task.task_id);
    await vi.waitFor(() => expect(releaseFirstPage).toBeTypeOf('function'));
    mock.emitServiceEvent('messages', 'removed', stale[0]);
    releaseFirstPage();
    await loading;

    expect(mock.messageFindAll).toHaveBeenCalledTimes(1);
    expect(handle.getTaskMessages(task.task_id).map((message) => message.index)).toEqual(
      stale.slice(1).map((message) => message.index)
    );
  });
});

describe('ReactiveSessionHandle Task snapshot reconciliation', () => {
  it('reorders live Tasks when a Session patch supplies canonical Task IDs', async () => {
    const first = makeTask('task-first', TaskStatus.COMPLETED);
    const second = makeTask('task-second', TaskStatus.RUNNING);
    const mock = createMockClient({
      tasks: [first, second],
      messagesByTask: {},
      sessionTaskIds: [first.task_id, second.task_id],
    });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, {
      taskHydration: 'none',
    });
    await handle.ready();

    mock.emitServiceEvent('sessions', 'patched', {
      session_id: SESSION_ID,
      tasks: [second.task_id, first.task_id],
    } as Session);
    expect(handle.state.tasks.map((task) => task.task_id)).toEqual([second.task_id, first.task_id]);

    mock.emitServiceEvent('tasks', 'patched', { ...first, status: TaskStatus.FAILED });
    expect(handle.state.tasks.map((task) => task.task_id)).toEqual([second.task_id, first.task_id]);
  });

  it('reconciles a Session Task removal over the fetched snapshot', async () => {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });
    await handle.ready();

    const stale = Array.from({ length: 10_000 }, (_, index) =>
      makeTask(`task-${String(index).padStart(5, '0')}`, TaskStatus.COMPLETED)
    );
    const current = stale.slice(1);
    opts.tasks = current;
    let releaseFirstPage!: () => void;
    mock.taskFindAll.mockImplementationOnce(
      () =>
        new Promise<Task[]>((resolve) => {
          releaseFirstPage = () => resolve(stale);
        })
    );

    const resync = handle.resync();
    await vi.waitFor(() => expect(releaseFirstPage).toBeTypeOf('function'));
    mock.emitServiceEvent('tasks', 'removed', stale[0]);
    releaseFirstPage();
    await resync;

    expect(mock.taskFindAll).toHaveBeenCalledTimes(2); // bootstrap + resync
    expect(handle.state.tasks.map((task) => task.task_id)).toEqual(
      current.map((task) => task.task_id)
    );
  });

  it('keeps the Task journal open until a slower bootstrap request commits', async () => {
    const oldTask = makeTask('old', TaskStatus.COMPLETED);
    const newTask = makeTask('new', TaskStatus.RUNNING);
    const mock = createMockClient({
      tasks: [oldTask],
      messagesByTask: {},
      deferSessionGet: true,
    });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });

    await vi.waitFor(() => expect(mock.taskFindAll).toHaveBeenCalledTimes(1));
    mock.emitServiceEvent('tasks', 'created', newTask);
    mock.releaseSessionGet();
    await handle.ready();

    expect(handle.state.tasks.map((task) => task.task_id)).toEqual(['old', 'new']);
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
      query: { task_id: 'task-4', $sort: { index: 1 }, $limit: 1000 },
    });
  });

  it('keeps one Message journal open across sequential Task refreshes', async () => {
    const firstOld = makeMessage('task-1', 0);
    const second = makeMessage('task-2', 0);
    const opts: MockClientOptions = {
      tasks: [makeTask('task-1', TaskStatus.COMPLETED), makeTask('task-2', TaskStatus.COMPLETED)],
      messagesByTask: { 'task-1': [firstOld], 'task-2': [second] },
    };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    await handle.ready();
    await handle.loadTaskMessages('task-1');

    mock.messageFindAll.mockClear();
    opts.deferTaskMessageFetch = 'task-1';
    const resync = handle.resync();
    await vi.waitFor(() =>
      expect(mock.messageFindAll).toHaveBeenCalledWith({
        query: { task_id: 'task-1', $sort: { index: 1 }, $limit: 1000 },
      })
    );
    const secondNew = makeMessage('task-2', 1);
    mock.emitServiceEvent('messages', 'created', secondNew);
    mock.releaseMessageFetch();
    await resync;

    expect(handle.getTaskMessages('task-2').map((message) => message.message_id)).toEqual([
      second.message_id,
      secondNew.message_id,
    ]);
  });

  it('preserves a Task loaded while lazy resync is in flight', async () => {
    const opts: MockClientOptions = {
      tasks: [makeTask('task-1', TaskStatus.COMPLETED), makeTask('task-2', TaskStatus.COMPLETED)],
      messagesByTask: {
        'task-1': [makeMessage('task-1', 0)],
        'task-2': [makeMessage('task-2', 0)],
      },
    };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    await handle.ready();

    opts.deferTaskMessageFetch = 'task-2';
    const resync = handle.resync();
    await vi.waitFor(() => expect(mock.messageFindAll).toHaveBeenCalledTimes(2));

    await handle.loadTaskMessages('task-1');
    expect(handle.isTaskLoaded('task-1')).toBe(true);

    mock.releaseMessageFetch();
    await resync;

    expect(handle.isTaskLoaded('task-1')).toBe(true);
    expect(handle.getTaskMessages('task-1')).toHaveLength(1);
  });

  it('preserves a Task unload while lazy resync is in flight', async () => {
    const opts: MockClientOptions = {
      tasks: [makeTask('task-1', TaskStatus.COMPLETED)],
      messagesByTask: { 'task-1': [makeMessage('task-1', 0)] },
    };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    await handle.ready();

    opts.deferTaskMessageFetch = 'task-1';
    const resync = handle.resync();
    await vi.waitFor(() => expect(mock.messageFindAll).toHaveBeenCalledTimes(2));

    handle.unloadTaskMessages('task-1');
    mock.releaseMessageFetch();
    await resync;

    expect(handle.isTaskLoaded('task-1')).toBe(false);
    expect(handle.getTaskMessages('task-1')).toEqual([]);
  });
});

describe('ReactiveSessionHandle stream subscription', () => {
  const opts = { tasks: [], messagesByTask: {} };

  it('subscribes to the session stream on attach', async () => {
    const { client, sessionStreams } = createMockClient(opts);
    const handle = new ReactiveSessionHandle(client, SESSION_ID, { taskHydration: 'none' });
    await handle.ready();

    expect(sessionStreams.create).toHaveBeenCalledWith({ session_id: SESSION_ID });
    handle.dispose();
  });

  it('unsubscribes on dispose', async () => {
    const { client, sessionStreams } = createMockClient(opts);
    const handle = new ReactiveSessionHandle(client, SESSION_ID, { taskHydration: 'none' });
    await handle.ready();

    handle.dispose();
    // Unsubscribe is serialized onto the stream-op chain, so it runs on a
    // microtask after dispose returns.
    await vi.waitFor(() => {
      expect(sessionStreams.remove).toHaveBeenCalledWith(SESSION_ID);
    });
  });

  it('does not hydrate until the subscribe ack resolves', async () => {
    // Hold create() unresolved: hydration must NOT have started yet. This fails
    // if subscribe were fire-and-forget (hydration would race ahead).
    const mock = createMockClient({ tasks: [], messagesByTask: {}, deferCreate: true });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });

    await vi.waitFor(() => {
      expect(mock.sessionStreams.create).toHaveBeenCalledTimes(1);
    });
    // Give any (incorrectly) un-awaited hydration a chance to run.
    await Promise.resolve();
    expect(mock.order).toEqual(['subscribe']);

    // Resolving the subscribe ack lets hydration proceed — strictly after.
    mock.releaseCreate();
    await handle.ready();
    expect(mock.order).toEqual(['subscribe', 'hydrate']);
    handle.dispose();
  });

  it('dispose during an in-flight subscribe leaves no room membership', async () => {
    const mock = createMockClient({ tasks: [], messagesByTask: {}, deferCreate: true });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });

    // Let the subscribe op actually start and block inside create() so we
    // exercise the genuine in-flight race (not the trivial "disposed before the
    // op ran" case).
    await vi.waitFor(() => {
      expect(mock.sessionStreams.create).toHaveBeenCalledTimes(1);
    });

    // Dispose enqueues the compensating unsubscribe onto the same serialized
    // chain, behind the in-flight create.
    handle.dispose();
    mock.releaseCreate();

    await vi.waitFor(() => {
      expect(mock.sessionStreams.remove).toHaveBeenCalledTimes(1);
    });
    // The create ran once and the unsubscribe ran strictly after it, so the
    // net membership is empty rather than a stale re-join.
    expect(mock.sessionStreams.create).toHaveBeenCalledTimes(1);
    expect(mock.order).toEqual(['subscribe', 'unsubscribe']);
  });

  it('re-subscribes on reconnect and awaits the ack before resyncing', async () => {
    // Deferred create lets us prove the resync ordering: hydration must not run
    // while the re-subscribe ack is pending, only after it resolves.
    const mock = createMockClient({
      tasks: [makeTask('task-1', TaskStatus.RUNNING)],
      messagesByTask: {},
      deferCreate: true,
    });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });

    // Complete the initial attach subscription first.
    await vi.waitFor(() => {
      expect(mock.sessionStreams.create).toHaveBeenCalledTimes(1);
    });
    mock.releaseCreate();
    await handle.ready();
    mock.order.length = 0; // observe only the reconnect ordering below

    // Reconnect: disconnect resets the re-subscribe token, connect re-subscribes.
    mock.fireIo('disconnect');
    mock.fireIo('connect');

    // The re-subscribe create is in flight; resync/hydration must NOT have run.
    await vi.waitFor(() => {
      expect(mock.sessionStreams.create).toHaveBeenCalledTimes(2);
    });
    await Promise.resolve();
    expect(mock.order).toEqual(['subscribe']);

    // Resolving the re-subscribe ack lets the resync proceed — strictly after.
    mock.releaseCreate();
    await handle.ready();
    expect(mock.order).toEqual(['subscribe', 'hydrate']);
    handle.dispose();
  });

  it('re-subscribes exactly once across multiple handles on reconnect', async () => {
    const mock = createMockClient({ tasks: [], messagesByTask: {} });
    const a = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });
    const b = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    await a.ready();
    await b.ready();
    expect(mock.sessionStreams.create).toHaveBeenCalledTimes(1);

    mock.fireIo('disconnect');
    mock.fireIo('connect');
    await a.ready();
    await b.ready();

    // Two handles, one shared re-subscribe (not one per handle).
    expect(mock.sessionStreams.create).toHaveBeenCalledTimes(2);
    a.dispose();
    b.dispose();
  });

  it('tolerates a client without the session-streams service (deploy skew)', async () => {
    const { client } = createMockClient(opts);
    (
      client.service as unknown as { mockImplementation: (fn: (n: string) => unknown) => void }
    ).mockImplementation((name: string) =>
      name === 'session-streams'
        ? undefined
        : {
            get: vi.fn(async () => ({})),
            findAll: vi.fn(async () => []),
            find: vi.fn(async () => ({ data: [] })),
            on: vi.fn(),
            removeListener: vi.fn(),
          }
    );

    // Construction + dispose must not throw even though subscribe/unsubscribe
    // hit an undefined service.
    const handle = new ReactiveSessionHandle(client, SESSION_ID, { taskHydration: 'none' });
    await handle.ready();
    expect(() => handle.dispose()).not.toThrow();
  });

  it('renders chunks that arrive after start already fired (attach mid-stream)', async () => {
    // A viewer opening a running session subscribes after streaming:start; the
    // chunk handler must initialize the stream from the chunk instead of
    // dropping it, grouping it under the active task so it renders.
    const mock = createMockClient({
      tasks: [makeTask('task-1', TaskStatus.RUNNING)],
      messagesByTask: {},
    });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });
    await handle.ready();

    // No streaming:start — the stream is already in progress upstream.
    mock.emitServiceEvent('messages', 'streaming:chunk', {
      message_id: 'm1',
      session_id: SESSION_ID,
      chunk: 'hello',
    });
    mock.emitServiceEvent('messages', 'streaming:chunk', {
      message_id: 'm1',
      session_id: SESSION_ID,
      chunk: ' world',
    });

    const streamed = handle.getStreamingMessage('m1');
    expect(streamed?.content).toBe('hello world');
    expect(streamed?.isStreaming).toBe(true);
    // Grouped under the active task so useStreamingMessagesByTask renders it.
    expect(streamed?.task_id).toBe('task-1');
    handle.dispose();
  });

  it('unsubscribes using the canonical room id returned by subscribe', async () => {
    // A short-id caller joins the canonical room (create echoes the full id);
    // remove must target that canonical room, so a later-revoked user still
    // leaves the room they actually joined.
    const shortId = 'ffffffff';
    const canonical = 'ffffffff-1111-2222-3333-444444444444';
    const create = vi.fn(async () => ({ session_id: canonical, subscribed: true }));
    const remove = vi.fn(async () => ({ session_id: canonical, subscribed: false }));
    const listener = () => ({ on: vi.fn(), removeListener: vi.fn() });
    const services: Record<string, unknown> = {
      sessions: { get: vi.fn(async () => ({ session_id: canonical }) as Session), ...listener() },
      tasks: { findAll: vi.fn(async () => []), ...listener() },
      messages: { findAll: vi.fn(async () => []), ...listener() },
      'session-streams': { create, remove },
    };
    const queueService = { find: vi.fn(async () => ({ data: [] })) };
    const client = {
      io: { connected: true, on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) =>
        name.includes('/tasks/queue') ? queueService : services[name]
      ),
    } as unknown as AgorClient;

    const handle = new ReactiveSessionHandle(client, shortId, { taskHydration: 'none' });
    await handle.ready();
    expect(create).toHaveBeenCalledWith({ session_id: shortId });

    handle.dispose();
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith(canonical);
    });
    expect(remove).not.toHaveBeenCalledWith(shortId);
  });

  it('shares one subscription across handles and only unsubscribes on the last detach', async () => {
    // Two handles for the same session (different taskHydration) share one
    // socket connection and thus one room membership.
    const mock = createMockClient({
      tasks: [makeTask('task-1', TaskStatus.RUNNING)],
      messagesByTask: {},
    });
    const a = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });
    const b = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    await a.ready();
    await b.ready();

    // Single shared subscription — not one per handle.
    expect(mock.sessionStreams.create).toHaveBeenCalledTimes(1);

    // Disposing one handle must NOT evict the shared connection from the room.
    a.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.sessionStreams.remove).not.toHaveBeenCalled();

    // The surviving handle still receives chunks.
    mock.emitServiceEvent('messages', 'streaming:chunk', {
      message_id: 'm1',
      session_id: SESSION_ID,
      chunk: 'still here',
    });
    expect(b.getStreamingMessage('m1')?.content).toBe('still here');

    // Last detach actually removes the membership.
    b.dispose();
    await vi.waitFor(() => {
      expect(mock.sessionStreams.remove).toHaveBeenCalledTimes(1);
    });
  });

  it('a late create from a disposing handle cannot evict a newer handle (ordered chain)', async () => {
    const mock = createMockClient({ tasks: [], messagesByTask: {}, deferCreate: true });
    const a = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });

    // a's create is in flight (deferred).
    await vi.waitFor(() => {
      expect(mock.sessionStreams.create).toHaveBeenCalledTimes(1);
    });

    // a disposes (refcount 0 → remove enqueued behind the in-flight create),
    // then a NEW handle b attaches (refcount 0→1 → create enqueued behind the
    // remove on the same shared chain).
    a.dispose();
    const b = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });

    // Drain a's create; the remove then runs, then b's create is issued.
    mock.releaseCreate();
    await vi.waitFor(() => {
      expect(mock.sessionStreams.remove).toHaveBeenCalledTimes(1);
      expect(mock.sessionStreams.create).toHaveBeenCalledTimes(2);
    });
    // Drain b's create so the join completes last.
    mock.releaseCreate();
    await b.ready();

    // Order proves b's join lands strictly after a's remove — membership is b's.
    expect(mock.order.filter((o) => o !== 'hydrate')).toEqual([
      'subscribe',
      'unsubscribe',
      'subscribe',
    ]);
    b.dispose();
  });

  it('renders thinking chunks that arrive mid-thinking (attach during a thinking block)', async () => {
    const mock = createMockClient({
      tasks: [makeTask('task-1', TaskStatus.RUNNING)],
      messagesByTask: {},
    });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });
    await handle.ready();

    mock.emitServiceEvent('messages', 'thinking:chunk', {
      message_id: 'm1',
      session_id: SESSION_ID,
      chunk: 'pondering',
    });

    const streamed = handle.getStreamingMessage('m1');
    expect(streamed?.thinkingContent).toBe('pondering');
    expect(streamed?.isThinking).toBe(true);
    expect(streamed?.task_id).toBe('task-1');
    handle.dispose();
  });

  it('re-stamps task_id on streams that arrived before tasks were hydrated', async () => {
    const mock = createMockClient({
      tasks: [makeTask('task-1', TaskStatus.RUNNING)],
      messagesByTask: {},
      deferCreate: true,
    });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });

    // Subscribe is in flight; tasks are not hydrated yet, so a chunk landing now
    // initializes the stream with an undefined task_id.
    await vi.waitFor(() => {
      expect(mock.sessionStreams.create).toHaveBeenCalledTimes(1);
    });
    mock.emitServiceEvent('messages', 'streaming:chunk', {
      message_id: 'm1',
      session_id: SESSION_ID,
      chunk: 'hi',
    });
    expect(handle.getStreamingMessage('m1')?.task_id).toBeUndefined();

    // Completing the ack lets bootstrap hydrate tasks and re-stamp the stream.
    mock.releaseCreate();
    await handle.ready();
    expect(handle.getStreamingMessage('m1')?.task_id).toBe('task-1');
    handle.dispose();
  });

  // A minimal client whose session-streams.create always echoes `canonical`
  // (the full UUID) regardless of the id form the caller supplied.
  function makeCanonicalClient(canonical: string) {
    const create = vi.fn(async () => ({ session_id: canonical, subscribed: true }));
    const remove = vi.fn(async () => ({ session_id: canonical, subscribed: false }));
    const listener = () => ({ on: vi.fn(), removeListener: vi.fn() });
    const services: Record<string, unknown> = {
      sessions: { get: vi.fn(async () => ({ session_id: canonical }) as Session), ...listener() },
      tasks: { findAll: vi.fn(async () => []), ...listener() },
      messages: { findAll: vi.fn(async () => []), ...listener() },
      'session-streams': { create, remove },
    };
    const queueService = { find: vi.fn(async () => ({ data: [] })) };
    const client = {
      io: { connected: true, on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) =>
        name.includes('/tasks/queue') ? queueService : services[name]
      ),
    } as unknown as AgorClient;
    return { client, create, remove };
  }

  it('shares one canonical room across short-id and full-id retains (short first)', async () => {
    const shortId = 'ffffffff';
    const canonical = 'ffffffff-1111-2222-3333-444444444444';
    const { client, create, remove } = makeCanonicalClient(canonical);

    const short = new ReactiveSessionHandle(client, shortId, { taskHydration: 'none' });
    await short.ready();
    const full = new ReactiveSessionHandle(client, canonical, { taskHydration: 'lazy' });
    await full.ready();

    // The full-id retain resolves to the canonical entry the short-id retain
    // established — reuse, no second create.
    expect(create).toHaveBeenCalledTimes(1);

    // Disposing one id form must NOT evict the shared room membership.
    short.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();

    // Only the last detach across all id forms removes it — once, canonically.
    full.dispose();
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledTimes(1);
    });
    expect(remove).toHaveBeenCalledWith(canonical);
  });

  it('folds a redundant subscription into the canonical room (full first, then short)', async () => {
    const shortId = 'ffffffff';
    const canonical = 'ffffffff-1111-2222-3333-444444444444';
    const { client, create, remove } = makeCanonicalClient(canonical);

    const full = new ReactiveSessionHandle(client, canonical, { taskHydration: 'none' });
    await full.ready();
    const short = new ReactiveSessionHandle(client, shortId, { taskHydration: 'lazy' });
    await short.ready();

    // The client can't know the short id maps to the canonical room without
    // asking, so a second create is sent — but both join ONE canonical room and
    // the entries fold together.
    expect(create).toHaveBeenCalledTimes(2);

    full.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();

    short.dispose();
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledTimes(1);
    });
    expect(remove).toHaveBeenCalledWith(canonical);
  });

  // Client for a handle constructed with a SHORT id: hydration + create ack echo
  // the canonical id, and events (which always carry the full UUID) can be fired.
  function makeShortIdEventClient(canonical: string) {
    const serviceHandlers: Record<string, Record<string, Array<(...a: unknown[]) => void>>> = {};
    const listener = (svc: string) => ({
      on: vi.fn((event: string, handler: (...a: unknown[]) => void) => {
        const byEvent = serviceHandlers[svc] ?? {};
        const handlers = byEvent[event] ?? [];
        handlers.push(handler);
        byEvent[event] = handlers;
        serviceHandlers[svc] = byEvent;
      }),
      removeListener: vi.fn(),
    });
    const emit = (svc: string, event: string, payload: unknown) => {
      for (const handler of [...(serviceHandlers[svc]?.[event] ?? [])]) handler(payload);
    };
    const runningTask = {
      task_id: 'task-1',
      session_id: canonical,
      status: TaskStatus.RUNNING,
    } as unknown as Task;
    const services: Record<string, unknown> = {
      // Hydration returns the canonical row even though we asked by short id.
      sessions: {
        get: vi.fn(async () => ({ session_id: canonical }) as Session),
        ...listener('sessions'),
      },
      tasks: { findAll: vi.fn(async () => [runningTask]), ...listener('tasks') },
      messages: { findAll: vi.fn(async () => []), ...listener('messages') },
      'session-streams': {
        create: vi.fn(async () => ({ session_id: canonical, subscribed: true })),
        remove: vi.fn(async () => ({ session_id: canonical, subscribed: false })),
      },
    };
    const queueService = { find: vi.fn(async () => ({ data: [] })) };
    const client = {
      io: { connected: true, on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) =>
        name.includes('/tasks/queue') ? queueService : services[name]
      ),
    } as unknown as AgorClient;
    return { client, emit };
  }

  it('a short-id handle matches events that carry the canonical id', async () => {
    const shortId = 'ffffffff';
    const canonical = 'ffffffff-1111-2222-3333-444444444444';
    const { client, emit } = makeShortIdEventClient(canonical);
    const handle = new ReactiveSessionHandle(client, shortId, { taskHydration: 'none' });
    await handle.ready();

    // (a) a canonical-id streaming chunk renders into streaming state.
    emit('messages', 'streaming:chunk', {
      message_id: 'm1',
      session_id: canonical,
      chunk: 'hello',
    });
    expect(handle.getStreamingMessage('m1')?.content).toBe('hello');

    // (b) a canonical-id tool event applies.
    emit('tasks', 'tool:start', {
      task_id: 'task-1',
      session_id: canonical,
      tool_use_id: 'tool-1',
      tool_name: 'Bash',
    });
    expect(handle.getTaskTools('task-1').map((t) => t.toolName)).toContain('Bash');

    // (c) sanity — an event for a DIFFERENT session id is still ignored.
    emit('messages', 'streaming:chunk', {
      message_id: 'm2',
      session_id: 'aaaaaaaa-0000-0000-0000-000000000000',
      chunk: 'nope',
    });
    expect(handle.getStreamingMessage('m2')).toBeUndefined();

    handle.dispose();
  });

  it('a short-id handle disposed before its ack leaves the registry empty', async () => {
    const shortId = 'ffffffff';
    const canonical = 'ffffffff-1111-2222-3333-444444444444';
    const createResolvers: Array<() => void> = [];
    const create = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        createResolvers.push(resolve);
      });
      return { session_id: canonical, subscribed: true };
    });
    const remove = vi.fn(async () => ({ session_id: canonical, subscribed: false }));
    const listener = () => ({ on: vi.fn(), removeListener: vi.fn() });
    const services: Record<string, unknown> = {
      sessions: { get: vi.fn(async () => ({ session_id: canonical }) as Session), ...listener() },
      tasks: { findAll: vi.fn(async () => []), ...listener() },
      messages: { findAll: vi.fn(async () => []), ...listener() },
      'session-streams': { create, remove },
    };
    const queueService = { find: vi.fn(async () => ({ data: [] })) };
    const client = {
      io: { connected: true, on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) =>
        name.includes('/tasks/queue') ? queueService : services[name]
      ),
    } as unknown as AgorClient;

    const handle = new ReactiveSessionHandle(client, shortId, { taskHydration: 'none' });
    // The create ack is held; dispose BEFORE it lands (release captured the
    // short-id key, but the ack re-keys the entry to the canonical id).
    await vi.waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });
    handle.dispose();
    for (const resolve of createResolvers.splice(0)) resolve();

    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledTimes(1);
    });
    // The compensating remove targeted the canonical room...
    expect(remove).toHaveBeenCalledWith(canonical);
    // ...and the registry ends empty (entry dropped under its re-keyed id,
    // connect handler detached) rather than leaking a stale entry.
    await vi.waitFor(() => {
      expect(__streamSubscriptionCountForTest(client)).toBe(0);
    });
  });
});

describe('session-streams capability announce', () => {
  // Library stays neutral: attaching the reactive API must not announce (the
  // announce is UI-private now), so a bare raw-listener consumer keeps the owner
  // fallback. Fail-on-revert: re-adding an announce into attachReactiveSessionApi
  // turns this red.
  it('does not announce from attachReactiveSessionApi alone', async () => {
    const appHandlers: Record<string, Array<() => void>> = {};
    const create = vi.fn(async () => ({ session_id: '', subscribed: false }));
    const client = {
      io: { connected: false, on: vi.fn(), off: vi.fn() },
      on: vi.fn((event: string, handler: () => void) => {
        const handlers = appHandlers[event] ?? [];
        handlers.push(handler);
        appHandlers[event] = handlers;
      }),
      off: vi.fn(),
      service: vi.fn((name: string) => {
        if (name === 'session-streams') return { create };
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as AgorClient;

    attachReactiveSessionApi(client);

    // Fire any post-auth listeners; a neutral library registers none.
    for (const handler of appHandlers.authenticated ?? []) handler();
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('snapshot reconciliation of persisted streams', () => {
  it.each(['lazy', 'eager'] as const)(
    'cleans persisted duplicates on %s resync without clearing active/unloaded streams',
    async (taskHydration) => {
      const message = makeMessage('task-2', 1);
      const opts: MockClientOptions = {
        tasks: [makeTask('task-1', TaskStatus.COMPLETED), makeTask('task-2', TaskStatus.RUNNING)],
        messagesByTask: { 'task-1': [makeMessage('task-1', 1)], 'task-2': [message] },
      };
      const mock = createMockClient(opts);
      const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration });
      await handle.ready();
      for (const [id, taskId] of [
        [message.message_id, 'task-2'],
        ['active', 'task-2'],
        ['task-1-msg-1', 'task-1'],
      ]) {
        mock.emitServiceEvent('messages', 'streaming:start', {
          message_id: id,
          session_id: SESSION_ID,
          task_id: taskId,
        });
        mock.emitServiceEvent('messages', 'streaming:chunk', {
          message_id: id,
          session_id: SESSION_ID,
          chunk: 'retained',
        });
      }
      await handle.resync();
      expect(handle.state.streamingMessages.has(message.message_id)).toBe(false);
      expect(handle.state.streamingMessages.get('active')?.content).toBe('retained');
      expect(handle.state.streamingMessages.has('task-1-msg-1')).toBe(taskHydration === 'lazy');
      handle.dispose();
    }
  );

  it('preserves an unload during bootstrap and reconciles only after later hydration', async () => {
    const message = makeMessage('task-1', 1);
    const opts: MockClientOptions = {
      tasks: [makeTask('task-1', TaskStatus.RUNNING)],
      messagesByTask: { 'task-1': [message] },
      deferSessionGet: true,
      deferTaskMessageFetch: 'task-1',
    };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID);
    await vi.waitFor(() => expect(mock.order).toContain('hydrate'));
    mock.emitServiceEvent('messages', 'streaming:start', {
      message_id: message.message_id,
      session_id: SESSION_ID,
      task_id: 'task-1',
    });
    mock.releaseSessionGet();
    await vi.waitFor(() => expect(mock.messageFindAll).toHaveBeenCalledTimes(1));
    handle.unloadTaskMessages('task-1');
    mock.releaseMessageFetch();
    await handle.ready();
    expect(handle.state.loadedTaskIds.has('task-1')).toBe(false);
    expect(handle.state.messagesByTask.has('task-1')).toBe(false);
    expect(handle.state.streamingMessages.has(message.message_id)).toBe(true);
    opts.deferTaskMessageFetch = undefined;
    await handle.loadTaskMessages('task-1');
    expect(handle.state.streamingMessages.size).toBe(0);
    handle.dispose();
  });

  it('reconciles a persisted stream during bootstrap', async () => {
    const message = makeMessage('task-1', 1);
    const mock = createMockClient({
      tasks: [makeTask('task-1', TaskStatus.RUNNING)],
      messagesByTask: { 'task-1': [message] },
      deferSessionGet: true,
    });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID);
    await vi.waitFor(() => expect(mock.order).toContain('hydrate'));
    mock.emitServiceEvent('messages', 'streaming:start', {
      message_id: message.message_id,
      session_id: SESSION_ID,
      task_id: 'task-1',
    });
    mock.releaseSessionGet();
    await handle.ready();
    expect(handle.state.streamingMessages.size).toBe(0);
    handle.dispose();
  });

  it('preserves a stream changed while a stale snapshot was in flight, then reconciles on the next fetch', async () => {
    const message = makeMessage('task-1', 1);
    const opts: MockClientOptions = {
      tasks: [makeTask('task-1', TaskStatus.RUNNING)],
      messagesByTask: { 'task-1': [message] },
    };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID);
    await handle.ready();
    mock.emitServiceEvent('messages', 'streaming:start', {
      message_id: message.message_id,
      session_id: SESSION_ID,
      task_id: 'task-1',
    });
    opts.deferTaskMessageFetch = 'task-1';
    const sync = handle.resync();
    await vi.waitFor(() => expect(mock.messageFindAll).toHaveBeenCalledTimes(2));
    mock.emitServiceEvent('messages', 'streaming:chunk', {
      message_id: message.message_id,
      session_id: SESSION_ID,
      chunk: 'newer than snapshot',
    });
    mock.releaseMessageFetch();
    await sync;
    expect(handle.state.streamingMessages.get(message.message_id)?.content).toBe(
      'newer than snapshot'
    );
    opts.deferTaskMessageFetch = undefined;
    await handle.resync();
    expect(handle.state.streamingMessages.size).toBe(0);
    handle.dispose();
  });
});

describe('stream reconciliation authority and lazy cache boundaries', () => {
  it('does not use unrefreshed cache rows in none hydration mode', async () => {
    const message = makeMessage('task-1', 1);
    const mock = createMockClient({
      tasks: [makeTask('task-1', TaskStatus.RUNNING)],
      messagesByTask: { 'task-1': [message] },
    });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });
    await handle.ready();
    await handle.loadTaskMessages('task-1');
    mock.emitServiceEvent('messages', 'streaming:start', {
      message_id: message.message_id,
      session_id: SESSION_ID,
      task_id: 'task-1',
    });
    await handle.resync();
    expect(handle.state.streamingMessages.has(message.message_id)).toBe(true);
    expect(mock.messageFindAll).toHaveBeenCalledTimes(1);
    await handle.loadTaskMessages('task-1');
    expect(handle.state.streamingMessages.size).toBe(0);
    handle.dispose();
  });

  it.each(['foreign-session', 'foreign-task'])(
    'does not reconcile from a %s row with a matching message ID',
    async (boundary) => {
      const message = makeMessage('task-1', 1);
      const opts: MockClientOptions = {
        tasks: [makeTask('task-1', TaskStatus.RUNNING)],
        messagesByTask: { 'task-1': [] },
      };
      const mock = createMockClient(opts);
      const handle = new ReactiveSessionHandle(mock.client, SESSION_ID);
      await handle.ready();
      mock.emitServiceEvent('messages', 'streaming:start', {
        message_id: message.message_id,
        session_id: SESSION_ID,
        task_id: 'task-1',
      });
      opts.messagesByTask['task-1'] = [
        {
          ...message,
          ...(boundary === 'foreign-session'
            ? { session_id: 'other-session' }
            : { task_id: 'other-task' }),
        } as Message,
      ];
      await handle.resync();
      expect(handle.state.streamingMessages.has(message.message_id)).toBe(true);
      mock.emitServiceEvent('messages', 'created', { ...message, session_id: 'other-session' });
      expect(handle.state.streamingMessages.has(message.message_id)).toBe(true);
      handle.dispose();
    }
  );

  it('preserves concurrent unload membership and removes a duplicate on later explicit hydration', async () => {
    const message = makeMessage('task-1', 1);
    const opts: MockClientOptions = {
      tasks: [makeTask('task-1', TaskStatus.RUNNING)],
      messagesByTask: { 'task-1': [message] },
    };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID);
    await handle.ready();
    mock.emitServiceEvent('messages', 'streaming:start', {
      message_id: message.message_id,
      session_id: SESSION_ID,
      task_id: 'task-1',
    });
    opts.deferTaskMessageFetch = 'task-1';
    const sync = handle.resync();
    await vi.waitFor(() => expect(mock.messageFindAll).toHaveBeenCalledTimes(2));
    handle.unloadTaskMessages('task-1');
    mock.releaseMessageFetch();
    await sync;
    expect(handle.state.loadedTaskIds.has('task-1')).toBe(false);
    expect(handle.state.streamingMessages.has(message.message_id)).toBe(true);
    opts.deferTaskMessageFetch = undefined;
    await handle.loadTaskMessages('task-1');
    expect(handle.state.streamingMessages.size).toBe(0);
    handle.dispose();
  });
});

describe('lean transcript POC hydration', () => {
  const history = () => {
    const tasks = Array.from({ length: 24 }, (_, index) =>
      makeTask(`task-${String(index).padStart(3, '0')}`, TaskStatus.COMPLETED)
    );
    const messagesByTask = Object.fromEntries(
      tasks.map((task) => [
        task.task_id,
        [
          { ...makeMessage(task.task_id, 0), content: 'Prompt' },
          {
            ...makeMessage(task.task_id, 1),
            content: [
              { type: 'text', text: 'Answer before' },
              { type: 'tool_use', id: 'tool', name: 'Read', input: { canary: 'TOOL_CANARY' } },
            ],
          },
          { ...makeMessage(task.task_id, 2), content: 'Answer after' },
        ] as Message[],
      ])
    );
    return { tasks, messagesByTask };
  };

  it('isolates preview ownership from expanded conversation history and clears disposed caches', async () => {
    const mock = createMockClient(history());
    const reader = retainReactiveSession(mock.client, SESSION_ID, { taskHydration: 'lean' });
    const preview = retainReactiveSession(mock.client, SESSION_ID, {
      taskHydration: 'lean',
      cacheScope: 'preview',
    });
    await Promise.all([reader.ready(), preview.ready()]);
    expect(reader).not.toBe(preview);
    expect(reader.state.tasks).toHaveLength(10);
    expect(preview.state.tasks).toHaveLength(1);
    await reader.loadOlderTasks();
    await reader.loadTaskMessages(reader.state.tasks[0].task_id);
    expect(reader.state.tasks).toHaveLength(20);
    expect(preview.state.tasks).toHaveLength(1);
    expect(preview.state.messagesByTask.size).toBe(1);
    await preview.loadOlderTasks();
    expect(preview.state.hasOlderTasks).toBe(false);
    releaseReactiveSession(mock.client, SESSION_ID, { taskHydration: 'lean' });
    expect(reader.state.tasks).toEqual([]);
    expect(reader.state.messagesByTask.size).toBe(0);
    expect(reader.state.toolsByTask.size).toBe(0);
    expect(preview.state.tasks).toHaveLength(1);
    expect(mock.sessionStreams.remove).not.toHaveBeenCalled();
    await preview.loadTaskMessages('task-023');
    const latest = makeTask('task-024', TaskStatus.COMPLETED);
    mock.emitServiceEvent('tasks', 'created', latest);
    await vi.waitFor(() =>
      expect(preview.state.tasks.map((task) => task.task_id)).toEqual(['task-024'])
    );
    expect(preview.state.messagesByTask.has('task-023')).toBe(false);
    expect(preview.state.loadedTaskIds.has('task-023')).toBe(false);
    releaseReactiveSession(mock.client, SESSION_ID, {
      taskHydration: 'lean',
      cacheScope: 'preview',
    });
    expect(preview.state.messagesByTask.size).toBe(0);
  });

  it('keeps history and preview reachable behind a full page of queued tasks', async () => {
    const opts = history();
    opts.tasks.slice(1).forEach((task) => {
      task.status = TaskStatus.QUEUED;
    });
    for (const cacheScope of ['session', 'preview'] as const) {
      const handle = new ReactiveSessionHandle(createMockClient(opts).client, SESSION_ID, {
        taskHydration: 'lean',
        cacheScope,
      });
      await handle.ready();
      expect(handle.state.tasks.some((task) => task.task_id === 'task-000')).toBe(true);
      expect(handle.state.messagesByTask.has('task-000')).toBe(true);
      handle.dispose();
    }
  });

  it('runs a fresh resync after reconnect invalidates an in-flight resync', async () => {
    const opts: MockClientOptions = history();
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    opts.deferTaskMessageFetch = 'task-023';
    const old = handle.resync();
    await vi.waitFor(() => expect(mock.messageFindAll.mock.calls.length).toBe(2));
    mock.fireIo('disconnect');
    opts.tasks.push(makeTask('task-024', TaskStatus.COMPLETED));
    mock.fireIo('connect');
    opts.deferTaskMessageFetch = undefined;
    mock.releaseMessageFetch();
    await old;
    await vi.waitFor(() =>
      expect(handle.state.tasks.some((task) => task.task_id === 'task-024')).toBe(true)
    );
    expect(handle.state.error).toBeNull();
    handle.dispose();
  });

  it('hydrates the latest executing turn fully without an active-task query', async () => {
    const opts = history();
    opts.tasks.at(-1)!.status = TaskStatus.RUNNING;
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    expect(mock.taskFindAll).not.toHaveBeenCalled();
    expect(handle.state.loadedTaskIds.has('task-023')).toBe(true);
    expect(JSON.stringify(handle.state.messagesByTask.get('task-023'))).toContain('TOOL_CANARY');
    expect(handle.state.loadedTaskIds.has('task-022')).toBe(false);
    handle.dispose();
  });

  it('starts with ten lean tasks, loads older pages once, and coalesces explicit details', async () => {
    const opts = history();
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    expect(handle.state.error).toBeNull();
    expect(handle.state.tasks).toHaveLength(10);
    expect(mock.taskFindAll).not.toHaveBeenCalled();
    expect(mock.messageFindAll.mock.calls[0][0].query).toMatchObject({
      session_id: SESSION_ID,
      task_id: { $in: handle.state.tasks.map((task) => task.task_id) },
    });
    expect(mock.messageFindAll).toHaveBeenCalledTimes(1);
    expect(
      mock.messageFindAll.mock.calls.every(([params]) => params.query.transcript === 'lean')
    ).toBe(true);
    expect(JSON.stringify([...handle.state.messagesByTask])).not.toContain('TOOL_CANARY');
    expect(handle.state.loadedTaskIds.size).toBe(0);
    await Promise.all([handle.loadTaskMessages('task-023'), handle.loadTaskMessages('task-023')]);
    expect(mock.messageFindAll).toHaveBeenCalledTimes(2);
    expect(handle.state.messagesByTask.get('task-023')?.map((message) => message.index)).toEqual([
      0, 1, 2,
    ]);
    expect(JSON.stringify(handle.state.messagesByTask.get('task-023'))).toContain('TOOL_CANARY');
    handle.unloadTaskMessages('task-023');
    expect(handle.state.loadedTaskIds.has('task-023')).toBe(true);
    const sessionGet = mock.client.service('sessions').get;
    const queueFind = mock.client.service(`/sessions/${SESSION_ID}/tasks/queue`).find;
    const sessionReads = vi.mocked(sessionGet).mock.calls.length;
    const queueReads = vi.mocked(queueFind).mock.calls.length;
    await Promise.all([handle.loadOlderTasks(), handle.loadOlderTasks()]);
    expect(vi.mocked(sessionGet).mock.calls).toHaveLength(sessionReads);
    expect(vi.mocked(queueFind).mock.calls).toHaveLength(queueReads);
    expect(handle.state.tasks).toHaveLength(20);
    await handle.loadOlderTasks();
    expect(handle.state.tasks).toHaveLength(24);
    expect(handle.state.hasOlderTasks).toBe(false);
    handle.dispose();
  });

  it('keeps prompts on detail failure, retries, and does not re-fetch unopened details on reconnect', async () => {
    const opts: MockClientOptions = history();
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    opts.failTaskMessageFetch = true;
    await expect(handle.loadTaskMessages('task-023')).rejects.toThrow();
    expect(handle.state.messagesByTask.get('task-023')?.[0].content).toBe('Prompt');
    opts.failTaskMessageFetch = false;
    await handle.loadTaskMessages('task-023');
    mock.messageFindAll.mockClear();
    await handle.resync();
    expect(
      mock.messageFindAll.mock.calls
        .filter(([params]) => params.query.transcript !== 'lean')
        .map(([params]) => params.query.task_id)
    ).toEqual(['task-023']);
    expect(
      new Set(handle.state.messagesByTask.get('task-023')?.map((message) => message.message_id))
        .size
    ).toBe(3);
    handle.dispose();
  });

  it('keeps active tools through completion and merges a live message over a stale detail fetch', async () => {
    const opts: MockClientOptions = history();
    opts.tasks[23] = makeTask('task-023', TaskStatus.AWAITING_PERMISSION);
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    expect(handle.state.loadedTaskIds.has('task-023')).toBe(true);
    expect(JSON.stringify(handle.state.messagesByTask.get('task-023'))).toContain('TOOL_CANARY');
    opts.deferTaskMessageFetch = 'task-023';
    const loading = handle.loadTaskMessages('task-023');
    const newer = {
      ...opts.messagesByTask['task-023'][1],
      content: 'Newer live content',
    } as Message;
    mock.emitServiceEvent('messages', 'patched', newer);
    mock.releaseMessageFetch();
    await loading;
    expect(handle.state.messagesByTask.get('task-023')?.[1].content).toBe('Newer live content');
    opts.tasks[23] = makeTask('task-023', TaskStatus.COMPLETED);
    mock.emitServiceEvent('tasks', 'patched', opts.tasks[23]);
    expect(handle.state.messagesByTask.get('task-023')).toHaveLength(3);
    opts.deferTaskMessageFetch = undefined;
    mock.messageFindAll.mockClear();
    await handle.resync();
    expect(
      mock.messageFindAll.mock.calls.find(([params]) => params.query.task_id === 'task-023')?.[0]
        .query.transcript
    ).toBeUndefined();
    handle.dispose();
  });

  it('fills the reached history window after more than a page of offline turns', async () => {
    const opts = history();
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    for (let index = 24; index < 49; index++) {
      const task = makeTask(`task-${String(index).padStart(3, '0')}`, TaskStatus.COMPLETED);
      opts.tasks.push(task);
      opts.messagesByTask[task.task_id] = [makeMessage(task.task_id, 0)];
    }
    await handle.resync();
    expect(handle.state.error).toBeNull();
    expect(handle.state.tasks).toHaveLength(35);
    expect(handle.state.tasks.some((task) => task.task_id === 'task-032')).toBe(true);
    expect(handle.state.loadedTaskIds.size).toBe(0);
    await handle.loadOlderTasks();
    await handle.loadOlderTasks();
    await handle.loadOlderTasks();
    await handle.loadOlderTasks();
    expect(handle.state.tasks).toHaveLength(49);
    handle.dispose();
  });

  it('keeps live stream and tool events during lean hydration and clears revoked history', async () => {
    const opts: MockClientOptions = history();
    opts.deferTaskMessageFetch = 'task-023';
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await vi.waitFor(() =>
      expect(
        mock.messageFindAll.mock.calls.some(([params]) =>
          (params.query.task_id as { $in?: string[] })?.$in?.includes('task-023')
        )
      ).toBe(true)
    );
    const streamed = { ...makeMessage('task-023', 3), content: 'Live answer' } as Message;
    mock.emitServiceEvent('messages', 'streaming:start', { ...streamed, role: 'assistant' });
    mock.emitServiceEvent('messages', 'streaming:chunk', {
      message_id: streamed.message_id,
      session_id: SESSION_ID,
      chunk: 'Live answer',
    });
    mock.emitServiceEvent('tasks', 'tool:start', {
      session_id: SESSION_ID,
      task_id: 'task-023',
      tool_use_id: 'live-tool',
      tool_name: 'Read',
    });
    mock.emitServiceEvent('messages', 'created', streamed);
    mock.releaseMessageFetch();
    await handle.ready();
    expect(
      handle.state.messagesByTask
        .get('task-023')
        ?.filter((message) => message.message_id === streamed.message_id)
    ).toHaveLength(1);
    expect(handle.state.streamingMessages.has(streamed.message_id)).toBe(false);
    expect(handle.state.toolsByTask.get('task-023')?.at(-1)?.toolName).toBe('Read');
    // A task-status event may be missed; observed tool activity still requires full reconnect hydration.
    opts.deferTaskMessageFetch = undefined;
    mock.messageFindAll.mockClear();
    await handle.resync();
    expect(
      mock.messageFindAll.mock.calls.find(([params]) => params.query.task_id === 'task-023')?.[0]
        .query.transcript
    ).toBeUndefined();
    mock.emitServiceEvent('sessions', 'removed', { session_id: SESSION_ID });
    expect(handle.state.messagesByTask.size).toBe(0);
    expect(handle.state.terminal).toBe(true);
    mock.emitServiceEvent('messages', 'created', streamed);
    expect(handle.state.messagesByTask.size).toBe(0);
    handle.dispose();
  });

  it('does not let a lean reconnect snapshot erase a concurrent completed expansion', async () => {
    const mock = createMockClient(history());
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    const original = mock.messageFindAll.getMockImplementation()!;
    let releaseFull: (() => void) | undefined;
    let releaseLean: (() => void) | undefined;
    mock.messageFindAll.mockImplementation(async (params) => {
      if (
        params.query.task_id !== 'task-023' &&
        !(params.query.task_id as { $in?: string[] })?.$in?.includes('task-023')
      )
        return original(params);
      return new Promise<Message[]>((resolve) => {
        const release = () => resolve(original(params));
        if (params.query.transcript === 'lean') releaseLean = release;
        else releaseFull = release;
      });
    });
    const expanded = handle.loadTaskMessages('task-023');
    const reconnect = handle.resync();
    await vi.waitFor(() => expect(releaseLean).toBeDefined());
    releaseFull!();
    await expanded;
    releaseLean!();
    await reconnect;
    expect(handle.state.loadedTaskIds.has('task-023')).toBe(true);
    expect(JSON.stringify(handle.state.messagesByTask.get('task-023'))).toContain('TOOL_CANARY');
    handle.dispose();
  });

  it('fences disposed and disconnected detail results', async () => {
    const opts: MockClientOptions = history();
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    opts.deferTaskMessageFetch = 'task-023';
    const loading = handle.loadTaskMessages('task-023');
    mock.fireIo('disconnect');
    mock.releaseMessageFetch();
    await loading;
    expect(handle.state.loadedTaskIds.has('task-023')).toBe(false);
    const again = handle.loadTaskMessages('task-023');
    handle.dispose();
    mock.releaseMessageFetch();
    await again;
    expect(handle.state.messagesByTask.size).toBe(0);
    expect(handle.state.tasks).toEqual([]);
    expect(handle.state.loadedTaskIds.has('task-023')).toBe(false);
  });
});

it('retains consecutive tool activity across partial persistence, duplicate events and reconciliation', async () => {
  const task = makeTask('tool-handoff', TaskStatus.RUNNING);
  const first = makeMessage(task.task_id, 1);
  const second = makeMessage(task.task_id, 2);
  const opts: MockClientOptions = { tasks: [task], messagesByTask: { [task.task_id]: [first] } };
  const mock = createMockClient(opts);
  const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
  await handle.ready();
  const event = (id: string) => ({
    session_id: SESSION_ID,
    task_id: task.task_id,
    tool_use_id: id,
    tool_name: 'Read',
  });
  try {
    mock.emitServiceEvent('tasks', 'tool:start', event('first'));
    mock.emitServiceEvent('tasks', 'tool:complete', event('first'));
    mock.emitServiceEvent('tasks', 'tool:start', event('second'));
    // This is a real public snapshot, not an atomic event/message handoff.
    expect(handle.state.messagesByTask.get(task.task_id)).toEqual([first]);
    expect(handle.getTaskTools(task.task_id).at(-1)?.toolUseId).toBe('second');
    mock.emitServiceEvent('tasks', 'tool:start', event('second'));
    mock.emitServiceEvent('tasks', 'tool:complete', event('first'));
    expect(handle.getTaskTools(task.task_id)).toEqual([
      { toolUseId: 'first', toolName: 'Read', status: 'complete' },
      { toolUseId: 'second', toolName: 'Read', status: 'executing' },
    ]);
    mock.emitServiceEvent('messages', 'created', second);
    mock.emitServiceEvent('messages', 'created', second);
    mock.emitServiceEvent('messages', 'created', first);
    mock.emitServiceEvent('tasks', 'tool:start', event('third'));
    mock.emitServiceEvent('tasks', 'tool:complete', event('second'));
    expect(handle.state.messagesByTask.get(task.task_id)).toEqual([first, second]);
    expect(handle.getTaskTools(task.task_id).at(-1)?.toolUseId).toBe('third');
    opts.messagesByTask[task.task_id] = [second, first];
    await handle.resync();
    expect(handle.state.messagesByTask.get(task.task_id)).toEqual([first, second]);
    expect(handle.getTaskTools(task.task_id)).toHaveLength(3);
    expect(handle.getTaskTools(task.task_id).at(-1)?.toolUseId).toBe('third');
  } finally {
    handle.dispose();
  }
});
