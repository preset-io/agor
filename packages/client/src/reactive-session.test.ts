import type { AgorClient, Message, Session, SessionID, Task, TaskID } from '@agor/core/client';
import { TaskStatus } from '@agor/core/client';
import { completionCallbackTaskId } from '@agor/core/ids';
import { describe, expect, it, vi } from 'vitest';
import {
  __streamSubscriptionCountForTest,
  attachReactiveSessionApi,
  LEAN_TRANSCRIPT_DETAIL_BYTE_BUDGET,
  LEAN_TRANSCRIPT_DETAIL_RETENTION_COUNT,
  LEAN_TRANSCRIPT_TASK_WINDOW,
  ReactiveSessionHandle,
  type ReactiveSessionOptions,
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
        // The daemon appends Session.tasks at dispatch: never a queued or
        // never-run (CREATED) Task.
        return {
          session_id: SESSION_ID,
          tasks:
            opts.sessionTaskIds ??
            opts.tasks
              .filter(
                (task) => task.status !== TaskStatus.QUEUED && task.status !== TaskStatus.CREATED
              )
              .map((task) => task.task_id),
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
        const cursor = query.task_id as { $lte?: string; $gt?: string; $in?: string[] } | undefined;
        if (cursor?.$in) rows = rows.filter((task) => cursor.$in!.includes(task.task_id));
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
  const queueService = {
    find: vi.fn(async () => ({
      data: opts.tasks.filter((task) => task.status === TaskStatus.QUEUED),
    })),
  };

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

interface FetchInternals {
  messageFetches: Map<number, number>;
  taskFetches: Map<number, number>;
  messageMutations: unknown[];
  taskMutations: unknown[];
  queueInflight: Promise<void> | null;
  leanSyncInflight: Promise<void> | null;
  resyncInflight: Promise<void> | null;
}

function expectNoStrandedFetches(internals: FetchInternals) {
  expect(internals.messageFetches.size).toBe(0);
  expect(internals.taskFetches.size).toBe(0);
  expect(internals.messageMutations).toHaveLength(0);
  expect(internals.taskMutations).toHaveLength(0);
  expect(internals.queueInflight).toBeNull();
  expect(internals.leanSyncInflight).toBeNull();
  expect(internals.resyncInflight).toBeNull();
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
  it('never renders a queue entry for a task born dispatching', async () => {
    const mock = createMockClient({ tasks: [], messagesByTask: {} });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });
    await handle.ready();
    const queueSizes: number[] = [];
    const unsubscribe = handle.subscribe(() => queueSizes.push(handle.state.queuedTasks.length));
    const task = makeTask('direct-prompt', TaskStatus.DISPATCHING);
    mock.emitServiceEvent('tasks', 'created', task);
    mock.emitServiceEvent('tasks', 'created', task); // duplicate delivery
    mock.emitServiceEvent('messages', 'created', makeMessage(task.task_id, 0));
    mock.emitServiceEvent('tasks', 'patched', { ...task, status: TaskStatus.RUNNING });
    expect(handle.state.tasks).toEqual([{ ...task, status: TaskStatus.RUNNING }]);
    expect(queueSizes.length).toBeGreaterThan(0);
    expect(queueSizes.every((size) => size === 0)).toBe(true);
    unsubscribe();
    handle.dispose();
  });

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
        // Both are nonterminal: this test exercises unloaded/active streams,
        // not late events for a task whose executor has already settled.
        tasks: [makeTask('task-1', TaskStatus.RUNNING), makeTask('task-2', TaskStatus.RUNNING)],
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

describe('queue-management realtime compatibility', () => {
  it('applies reordered positions and selected removals without disturbing active work', async () => {
    const active = makeTask('active', TaskStatus.RUNNING);
    const a = { ...makeTask('a', TaskStatus.QUEUED), queue_position: 1 };
    const b = { ...makeTask('b', TaskStatus.QUEUED), queue_position: 2 };
    const opts = { tasks: [active, a, b], messagesByTask: {} };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });
    await handle.ready();
    opts.tasks = [active, { ...b, queue_position: 1 }, { ...a, queue_position: 2 }];
    mock.emitServiceEvent('tasks', 'patched', { ...b, queue_position: 1 });
    mock.emitServiceEvent('tasks', 'patched', { ...a, queue_position: 2 });
    await vi.waitFor(() =>
      expect(handle.state.queuedTasks.map((t) => t.task_id)).toEqual(['b', 'a'])
    );
    opts.tasks = [active, a];
    mock.emitServiceEvent('tasks', 'removed', b);
    expect(handle.state.queuedTasks.map((t) => t.task_id)).toEqual(['a']);
    expect(handle.state.tasks.find((t) => t.task_id === active.task_id)).toEqual(active);
    handle.dispose();
  });
});

describe('authoritative queue snapshot ownership', () => {
  it('lean queue recovery clears successive different refresh failures', async () => {
    const queued = { ...makeTask('queued', TaskStatus.QUEUED), queue_position: 1 };
    const mock = createMockClient({ tasks: [queued], messagesByTask: {} });
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    try {
      await handle.ready();
      const queueFind = vi.mocked(mock.client.service(`/sessions/${SESSION_ID}/tasks/queue`).find);
      queueFind.mockRejectedValueOnce(new Error('Timeout'));
      mock.emitServiceEvent('tasks', 'queued', queued);
      await vi.waitFor(() => expect(handle.state.error).toBe('Timeout'));
      expect(handle.state.queuedTasks).toEqual([queued]);

      queueFind.mockRejectedValueOnce(new Error('Service unavailable'));
      mock.emitServiceEvent('tasks', 'queued', queued);
      await vi.waitFor(() => expect(queueFind).toHaveBeenCalledTimes(3));
      expect.soft(handle.state.error).toBe('Service unavailable');
      expect(handle.state.queuedTasks).toEqual([queued]);

      queueFind.mockResolvedValueOnce({ data: [], total: 0, limit: 100, skip: 0 });
      mock.emitServiceEvent('tasks', 'queued', queued);
      await vi.waitFor(() => expect(handle.state.queuedTasks).toEqual([]));
      expect(handle.state.error).toBeNull();
    } finally {
      handle.dispose();
    }
  });

  it.each(['before failures', 'between failures', 'before recovery'])(
    'lean queue refresh preserves an unrelated history error introduced %s',
    async (timing) => {
      const queued = { ...makeTask('queued', TaskStatus.QUEUED), queue_position: 1 };
      const history = Array.from({ length: 11 }, (_, i) =>
        makeTask(`task-${String(i).padStart(2, '0')}`, TaskStatus.COMPLETED)
      );
      const mock = createMockClient({ tasks: [...history, queued], messagesByTask: {} });
      const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, {
        taskHydration: 'lean',
      });
      try {
        await handle.ready();
        expect(handle.state.hasOlderTasks).toBe(true);
        const queueFind = vi.mocked(
          mock.client.service(`/sessions/${SESSION_ID}/tasks/queue`).find
        );
        const failHistory = async () => {
          vi.mocked(mock.client.service('tasks').find).mockRejectedValueOnce(
            new Error('History unavailable')
          );
          await expect(handle.loadOlderTasks()).rejects.toThrow('History unavailable');
          expect(handle.state.error).toBe('History unavailable');
        };
        if (timing === 'before failures') await failHistory();
        queueFind.mockRejectedValueOnce(new Error('Timeout'));
        mock.emitServiceEvent('tasks', 'queued', queued);
        await vi.waitFor(() => expect(queueFind).toHaveBeenCalledTimes(2));
        expect(handle.state.error).toBe(
          timing === 'before failures' ? 'History unavailable' : 'Timeout'
        );

        if (timing === 'between failures') await failHistory();
        queueFind.mockRejectedValueOnce(new Error('Service unavailable'));
        mock.emitServiceEvent('tasks', 'queued', queued);
        await vi.waitFor(() => expect(queueFind).toHaveBeenCalledTimes(3));
        if (timing === 'before recovery') await failHistory();
        expect(handle.state.error).toBe('History unavailable');
        expect(handle.state.queuedTasks).toEqual([queued]);

        queueFind.mockResolvedValueOnce({ data: [], total: 0, limit: 100, skip: 0 });
        mock.emitServiceEvent('tasks', 'queued', queued);
        await vi.waitFor(() => expect(handle.state.queuedTasks).toEqual([]));
        expect(handle.state.error).toBe('History unavailable');
      } finally {
        handle.dispose();
      }
    }
  );

  it('does not lose an invalidation between publishing a snapshot and promise cleanup', async () => {
    const a = { ...makeTask('a', TaskStatus.QUEUED), queue_position: 1 };
    const b = { ...makeTask('b', TaskStatus.QUEUED), queue_position: 2 };
    const c = { ...makeTask('c', TaskStatus.QUEUED), queue_position: 3 };
    const opts: MockClientOptions = { tasks: [a], messagesByTask: {} };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'none' });
    await handle.ready();
    let delivered = false;
    handle.subscribe(() => {
      if (delivered || handle.state.queuedTasks.length !== 2) return;
      delivered = true;
      void Promise.resolve().then(() => {
        opts.tasks = [b, c];
        mock.emitServiceEvent('tasks', 'queued', c);
      });
    });
    opts.tasks = [a, b];
    mock.emitServiceEvent('tasks', 'queued', b);
    await vi.waitFor(() => expect(delivered).toBe(true));
    await vi.waitFor(() => expect(handle.state.queuedTasks).toEqual([b, c]));
    // A late old reorder still reconciles, rather than using event payloads.
    mock.emitServiceEvent('tasks', 'patched', a);
    await handle.resync();
    expect(handle.state.queuedTasks).toEqual([b, c]);
    handle.dispose();
  });

  it.each(['eager', 'lazy', 'none', 'lean'] as const)(
    '%s bootstrap and resync cannot replay queued rows over newer removals',
    async (taskHydration) => {
      const active = makeTask('active', TaskStatus.COMPLETED);
      const a = { ...makeTask('a', TaskStatus.QUEUED), queue_position: 1 };
      const b = { ...makeTask('b', TaskStatus.QUEUED), queue_position: 2 };
      const opts: MockClientOptions = {
        tasks: [active, a, b],
        messagesByTask: {},
        deferSessionGet: true,
      };
      const mock = createMockClient(opts);
      const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration });
      await vi.waitFor(() => expect(handle.state.queuedTasks).toHaveLength(2));
      opts.tasks = [active, a];
      mock.emitServiceEvent('tasks', 'removed', b);
      mock.emitServiceEvent('tasks', 'patched', b);
      mock.releaseSessionGet();
      await handle.ready();
      expect(handle.state.queuedTasks).toEqual([a]);
      expect(handle.state.tasks.some((task) => task.task_id === b.task_id)).toBe(false);

      const syncing = handle.resync();
      await vi.waitFor(() =>
        expect(mock.order.filter((step) => step === 'hydrate')).toHaveLength(2)
      );
      opts.tasks = [active];
      mock.emitServiceEvent('tasks', 'removed', a);
      mock.emitServiceEvent('tasks', 'queued', a);
      mock.releaseSessionGet();
      await syncing;
      expect(handle.state.queuedTasks).toEqual([]);
      expect(handle.state.tasks).toEqual([active]);
      handle.dispose();
    }
  );
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

  it('retires journals and single-flight markers stranded by a disconnect mid-sync', async () => {
    const opts: MockClientOptions = history();
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    // Twenty reached Tasks: a resync refreshes them by ID.
    await handle.loadOlderTasks();
    const internals = handle as unknown as FetchInternals;
    // Without an ack deadline, Socket.IO drops the callback of a request that
    // was in flight at disconnect; the awaiting call never settles.
    const taskFind = vi.mocked(mock.client.service('tasks').find);
    const answer = taskFind.getMockImplementation()!;
    let settleStranded: (() => void) | undefined;
    taskFind.mockImplementationOnce(
      (params) =>
        new Promise((resolve) => {
          settleStranded = () => resolve(answer(params));
        })
    );
    const stranded = handle.resync();
    await vi.waitFor(() => expect(settleStranded).toBeDefined());
    expect(internals.taskFetches.size).toBe(1);
    expect(internals.messageFetches.size).toBe(1);

    mock.fireIo('disconnect');
    expectNoStrandedFetches(internals);

    opts.tasks.push(makeTask('task-024', TaskStatus.COMPLETED));
    mock.fireIo('connect');
    await vi.waitFor(() =>
      expect(handle.state.tasks.some((task) => task.task_id === 'task-024')).toBe(true)
    );
    expect(handle.state.tasks).toHaveLength(21);
    expect(handle.state.error).toBeNull();

    // Executor heartbeats and message patches keep arriving on the new connection.
    const running = makeTask('task-024', TaskStatus.RUNNING);
    const message = makeMessage('task-024', 0);
    for (let beat = 0; beat < 50; beat++) {
      mock.emitServiceEvent('tasks', 'patched', running);
      mock.emitServiceEvent('messages', 'patched', message);
    }
    expectNoStrandedFetches(internals);

    // A stranded request that settles after the reconnect is discarded.
    settleStranded!();
    await stranded;
    expect(handle.state.tasks).toHaveLength(21);
    expect(handle.getTask('task-024')?.status).toBe(TaskStatus.RUNNING);
    expect(handle.state.error).toBeNull();
    expectNoStrandedFetches(internals);
    handle.dispose();
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

// Only invented payloads and a fake transport; all lifecycle handlers are real.
describe.each(['lean', 'lazy'] as const)('stream lifecycle (%s)', (taskHydration) => {
  async function fixture() {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    const mock = createMockClient(opts);
    const handle = attachReactiveSessionApi(mock.client).session(SESSION_ID, {
      taskHydration,
    });
    await handle.ready();
    const task = (id: string, status: TaskStatus = TaskStatus.RUNNING) => {
      const row = makeTask(id, status);
      opts.tasks = [...opts.tasks.filter((t) => t.task_id !== id), row];
      mock.emitServiceEvent('tasks', 'patched', row);
    };
    const event = (name: string, id: string, taskId: string, extra = {}) =>
      mock.emitServiceEvent('messages', name, {
        session_id: SESSION_ID,
        message_id: id,
        task_id: taskId,
        timestamp: '2026-01-01T00:00:00.000Z',
        role: 'assistant',
        ...extra,
      });
    const thinking = (id: string, taskId: string) => {
      event('thinking:start', id, taskId);
      event('thinking:chunk', id, taskId, { chunk: 'synthetic violet pebble '.repeat(64) });
    };
    const persist = (id: string, taskId: string) => {
      const row = {
        ...makeMessage(taskId, (opts.messagesByTask[taskId] ?? []).length),
        message_id: id as Message['message_id'],
        role: 'assistant',
        content: [{ type: 'text', text: 'invented amber square' }],
      } as Message;
      opts.messagesByTask[taskId] = [...(opts.messagesByTask[taskId] ?? []), row];
      mock.emitServiceEvent('messages', 'created', row);
    };
    return { ...mock, opts, handle, task, event, thinking, persist };
  }

  it.each(['separate', 'same', 'thinking-only'] as const)(
    'releases 40 completed turns (%s IDs), including reconnect and resync',
    async (ids) => {
      const f = await fixture();
      const retained: number[] = [];
      for (let n = 0; n < 40; n++) {
        const t = `turn-${String(n).padStart(2, '0')}`;
        const thought = `${t}-thought`;
        const text = ids === 'separate' ? `${t}-text` : thought;
        f.task(t);
        f.thinking(thought, t);
        f.event('thinking:end', thought, t);
        if (ids !== 'thinking-only') {
          f.event('streaming:start', text, t);
          f.event('streaming:chunk', text, t, { chunk: 'invented amber square' });
          f.event('streaming:end', text, t);
        }
        f.persist(text, t);
        f.task(t, TaskStatus.COMPLETED);
        if ([10, 20, 40].includes(n + 1)) retained.push(f.handle.state.streamingMessages.size);
      }
      expect(retained).toEqual([0, 0, 0]);
      f.fireIo('disconnect');
      f.fireIo('connect');
      await f.handle.ready();
      await f.handle.resync();
      expect(f.handle.state.streamingMessages.size).toBe(0);
      f.handle.dispose();
    }
  );

  it('does not mistake earlier assistant persistence for newer thinking completion', async () => {
    const f = await fixture();
    f.task('turn');
    f.thinking('newer', 'turn');
    f.persist('earlier', 'turn');
    expect(f.handle.getStreamingMessage('newer')?.isThinking).toBe(true);
    f.event('thinking:end', 'newer', 'turn');
    expect(f.handle.getStreamingMessage('newer')).toMatchObject({
      isThinking: false,
      isStreaming: false,
    });
    // Even ended thinking may belong to a later, not-yet-persisted message.
    f.persist('another-earlier', 'turn');
    expect(f.handle.getStreamingMessage('newer')?.thinkingContent).toContain('violet');
    f.task('turn', TaskStatus.COMPLETED);
    expect(f.handle.state.streamingMessages.size).toBe(0);
    f.handle.dispose();
  });

  it('cleans many blocks at the task boundary without sweeping another active task', async () => {
    const f = await fixture();
    f.task('first');
    f.task('second');
    f.thinking('live', 'second');
    for (let n = 0; n < 40; n++) {
      f.thinking(`block-${n}`, 'first');
      f.event('thinking:end', `block-${n}`, 'first');
      f.persist(`saved-${n}`, 'first');
    }
    f.task('first', TaskStatus.COMPLETED);
    expect([...f.handle.state.streamingMessages.keys()]).toEqual(['live']);
    expect(f.handle.getStreamingMessage('live')?.isThinking).toBe(true);
    f.handle.dispose();
    expect(f.handle.state.streamingMessages.size).toBe(0);
  });

  it.each([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.STOPPED, TaskStatus.TIMED_OUT])(
    'clears stale activity on %s before persistence and ignores late thinking events',
    async (status) => {
      const f = await fixture();
      f.task('turn');
      f.thinking('thought', 'turn'); // no end was delivered
      f.event('streaming:start', 'text', 'turn');
      f.event('streaming:chunk', 'text', 'turn', { chunk: 'synthetic partial' });
      f.event('streaming:start', 'error', 'turn');
      f.event('streaming:error', 'error', 'turn', { error: 'invented failure' });
      f.task('turn', status);
      expect(f.handle.getStreamingMessage('thought')).toBeUndefined();
      expect(f.handle.getStreamingMessage('text')).toMatchObject({
        content: 'synthetic partial',
        isStreaming: false,
        isThinking: false,
      });
      expect(f.handle.getStreamingMessage('error')?.error).toBe('invented failure');
      f.task('next');
      f.event('thinking:chunk', 'thought', 'turn', { chunk: 'late synthetic' });
      f.thinking('thought', 'turn');
      f.event('thinking:end', 'thought', 'turn');
      f.event('streaming:chunk', 'text', 'turn', { chunk: 'late synthetic' });
      expect(f.handle.getStreamingMessage('thought')).toBeUndefined();
      expect(f.handle.getStreamingMessage('text')?.content).toBe('synthetic partial');
      f.persist('text', 'turn');
      expect([...f.handle.state.streamingMessages.keys()]).toEqual(['error']);
      f.handle.dispose();
    }
  );

  it.each(['thinking', 'streaming'] as const)(
    'preserves overlapping same-ID activity when %s ends first',
    async (first) => {
      const f = await fixture();
      f.task('turn');
      f.thinking('both', 'turn');
      f.event('streaming:start', 'both', 'turn');
      f.event('streaming:chunk', 'both', 'turn', { chunk: 'synthetic text' });
      f.event(`${first}:end`, 'both', 'turn');
      expect(f.handle.getStreamingMessage('both')).toMatchObject({
        content: 'synthetic text',
        isStreaming: true,
      });
      expect(f.handle.getStreamingMessage('both')?.thinkingContent).toContain('violet');
      f.event(`${first === 'thinking' ? 'streaming' : 'thinking'}:end`, 'both', 'turn');
      expect(f.handle.getStreamingMessage('both')?.isStreaming).toBe(false);
      f.persist('both', 'turn');
      expect(f.handle.state.streamingMessages.size).toBe(0);
      f.handle.dispose();
    }
  );

  it('ends thinking-only activity but does not turn stopping into terminal', async () => {
    const f = await fixture();
    f.task('turn');
    f.thinking('thought', 'turn');
    f.task('turn', TaskStatus.STOPPING);
    expect(f.handle.getStreamingMessage('thought')?.isThinking).toBe(true);
    f.event('thinking:end', 'thought', 'turn');
    f.event('thinking:end', 'thought', 'turn');
    expect(f.handle.getStreamingMessage('thought')?.isStreaming).toBe(false);
    f.handle.dispose();
  });

  it('recovers a missed terminal event through resync and reconnect', async () => {
    const f = await fixture();
    f.task('turn');
    f.thinking('thought', 'turn');
    f.event('thinking:end', 'thought', 'turn');
    f.opts.tasks = [makeTask('turn', TaskStatus.COMPLETED)];
    f.fireIo('disconnect');
    f.fireIo('connect');
    await f.handle.ready();
    expect(f.handle.state.streamingMessages.size).toBe(0);
    await f.handle.resync();
    expect(f.handle.state.streamingMessages.size).toBe(0);
    f.handle.dispose();
  });

  it('retains 40 intended partial errors, not 40 additional thinking orphans', async () => {
    const f = await fixture();
    for (let n = 0; n < 40; n++) {
      const t = `error-turn-${n}`;
      f.task(t);
      f.thinking(`thought-${n}`, t);
      f.event('thinking:end', `thought-${n}`, t);
      f.event('streaming:start', `error-${n}`, t);
      f.event('streaming:chunk', `error-${n}`, t, { chunk: 'invented partial square' });
      f.event('streaming:error', `error-${n}`, t, { error: 'invented failure' });
      f.task(t, TaskStatus.FAILED);
    }
    const streams = [...f.handle.state.streamingMessages.values()];
    expect(streams).toHaveLength(40);
    expect(streams.every((s) => s.error && s.content && !s.isStreaming && !s.isThinking)).toBe(
      true
    );
    f.handle.dispose();
    expect(f.handle.state.streamingMessages.size).toBe(0);
  });

  it('preserves text-first same-ID streams and duplicate starts without losing payloads', async () => {
    const f = await fixture();
    f.task('turn');
    f.event('streaming:start', 'both', 'turn');
    f.event('streaming:chunk', 'both', 'turn', { chunk: 'synthetic text' });
    f.thinking('both', 'turn');
    f.event('streaming:start', 'both', 'turn');
    f.event('thinking:end', 'both', 'turn');
    expect(f.handle.getStreamingMessage('both')).toMatchObject({
      content: 'synthetic text',
      isStreaming: true,
    });
    f.event('streaming:end', 'both', 'turn');
    expect(f.handle.getStreamingMessage('both')?.isStreaming).toBe(false);
    f.handle.dispose();
  });

  it('uses the chunk task attribution instead of the latest task after reconnect', async () => {
    const f = await fixture();
    f.task('first');
    f.task('latest');
    f.event('thinking:chunk', 'thought', 'first', { chunk: 'synthetic early pebble' });
    f.event('streaming:chunk', 'text', 'first', { chunk: 'synthetic early square' });
    expect(f.handle.getStreamingMessage('thought')?.task_id).toBe('first');
    expect(f.handle.getStreamingMessage('text')?.task_id).toBe('first');
    f.task('first', TaskStatus.COMPLETED);
    expect(f.handle.getStreamingMessage('thought')).toBeUndefined();
    expect(f.handle.getStreamingMessage('text')?.isStreaming).toBe(false);
    f.handle.dispose();
  });

  it('ignores mismatched-task end/chunk/error events for the same stream ID', async () => {
    const f = await fixture();
    f.task('first');
    f.task('second');
    f.thinking('thought', 'first');
    const before = f.handle.getStreamingMessage('thought');
    f.event('thinking:end', 'thought', 'second');
    f.event('thinking:chunk', 'thought', 'second', { chunk: 'foreign synthetic' });
    f.event('streaming:end', 'thought', 'second');
    f.event('streaming:error', 'thought', 'second', { error: 'foreign synthetic' });
    expect(f.handle.getStreamingMessage('thought')).toBe(before);
    f.handle.dispose();
  });

  it('settles late/duplicate chunks and ends after persistence and terminal-before-persistence', async () => {
    const f = await fixture();
    f.task('turn');
    f.thinking('thought', 'turn');
    f.persist('text', 'turn');
    f.event('thinking:end', 'thought', 'turn');
    f.event('thinking:chunk', 'thought', 'turn', { chunk: 'delayed synthetic pebble' });
    f.event('thinking:end', 'thought', 'turn');
    f.task('turn', TaskStatus.COMPLETED);
    f.persist('text', 'turn');
    f.event('thinking:end', 'thought', 'turn');
    f.event('streaming:end', 'text', 'turn');
    expect(f.handle.state.streamingMessages.size).toBe(0);
    f.handle.dispose();
  });

  it('rejects foreign-session lifecycle events even with colliding task/message IDs', async () => {
    const f = await fixture();
    f.task('turn');
    f.thinking('thought', 'turn');
    const before = f.handle.getStreamingMessage('thought');
    f.emitServiceEvent('tasks', 'patched', {
      ...makeTask('turn', TaskStatus.COMPLETED),
      session_id: 'foreign-session',
    });
    f.event('thinking:end', 'thought', 'turn', { session_id: 'foreign-session' });
    f.event('thinking:chunk', 'thought', 'turn', {
      session_id: 'foreign-session',
      chunk: 'foreign synthetic',
    });
    expect(f.handle.getStreamingMessage('thought')).toBe(before);
    f.handle.dispose();
  });

  it('refreshes the stream task index on replacement and clears it on reset/dispose', async () => {
    const f = await fixture();
    f.task('turn');
    f.thinking('first', 'turn');
    const originalTasks = f.handle.state.tasks;
    f.task('turn', TaskStatus.FAILED);
    expect(originalTasks[0].status).toBe(TaskStatus.RUNNING);
    expect(f.handle.getStreamingMessage('first')).toBeUndefined();
    f.task('turn');
    f.thinking('fresh', 'turn');
    expect(f.handle.getStreamingMessage('fresh')?.isThinking).toBe(true);
    f.opts.tasks = [makeTask('replacement', TaskStatus.RUNNING)];
    await f.handle.resync();
    f.event('streaming:chunk', 'replacement-text', 'replacement', { chunk: 'synthetic square' });
    expect(f.handle.getStreamingMessage('replacement-text')?.isStreaming).toBe(true);
    // Inspect only the bounded memoization lifetime, not a public API contract.
    const index = () => Reflect.get(f.handle, 'streamTaskIndex');
    expect(index().tasks).toBe(f.handle.state.tasks);
    expect(index().byId.has('turn')).toBe(false);
    f.emitServiceEvent('sessions', 'removed', { session_id: SESSION_ID });
    expect(index()).toBeUndefined();
    f.handle.dispose();
    expect(index()).toBeUndefined();
  });

  it.each([300, 3000])(
    'does not rescan %i task rows during warmed real chunk updates',
    async (count) => {
      const f = await fixture();
      f.opts.tasks = Array.from({ length: count }, (_, n) =>
        makeTask(`history-${String(n).padStart(5, '0')}`, TaskStatus.COMPLETED)
      );
      // Load history through the real hydration path (lean intentionally pages).
      await f.handle.resync();
      f.task('zz-live');
      f.event('streaming:chunk', 'text', 'zz-live', { chunk: 'x' });
      const tasks = f.handle.state.tasks;
      const reads = tasks.flatMap((task) => {
        const taskId = task.task_id;
        const status = task.status;
        Object.defineProperty(task, 'task_id', { configurable: true, get: () => taskId });
        Object.defineProperty(task, 'status', { configurable: true, get: () => status });
        return [vi.spyOn(task, 'task_id', 'get'), vi.spyOn(task, 'status', 'get')];
      });
      for (let n = 0; n < 2000; n++) {
        f.event('streaming:chunk', 'text', 'zz-live', { chunk: 'x' });
      }
      expect(f.handle.state.tasks).toBe(tasks);
      expect(f.handle.getStreamingMessage('text')?.content.length).toBe(2001);
      expect(reads.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(0);
      for (const spy of reads) spy.mockRestore();
      f.handle.dispose();
    }
  );

  it.each(['empty', 'thinking'] as const)(
    'retains an attributed late error after terminal settlement (%s)',
    async (kind) => {
      const f = await fixture();
      f.task('turn');
      if (kind === 'thinking') f.thinking('retired', 'turn');
      else f.event('streaming:start', 'retired', 'turn');
      f.task('turn', TaskStatus.FAILED);
      expect(f.handle.getStreamingMessage('retired')).toBeUndefined();
      f.task('next');
      f.thinking('active', 'next');
      const active = f.handle.getStreamingMessage('active');
      f.event('streaming:error', 'retired', 'turn', {
        session_id: 'foreign-session',
        error: 'synthetic foreign failure',
      });
      f.event('streaming:error', 'retired', 'next', { error: 'synthetic wrong task' });
      f.event('streaming:error', 'retired', 'unknown-task', { error: 'synthetic unknown task' });
      f.event('streaming:error', 'unknown-message', 'turn', { error: 'synthetic unknown message' });
      expect([...f.handle.state.streamingMessages.keys()]).toEqual(['active']);
      f.event('streaming:error', 'retired', 'turn', { error: 'synthetic late failure' });
      expect(f.handle.getStreamingMessage('retired')).toMatchObject({
        task_id: 'turn',
        content: '',
        error: 'synthetic late failure',
        isStreaming: false,
        isThinking: false,
        isTextStreaming: false,
      });
      expect(f.handle.getStreamingMessage('retired')?.thinkingContent || '').toBe('');
      expect(f.handle.getStreamingMessage('active')).toBe(active);
      f.event('streaming:error', 'retired', 'turn', { error: 'synthetic late failure' });
      f.event('thinking:chunk', 'retired', 'turn', { chunk: 'synthetic discarded' });
      expect(f.handle.getStreamingMessage('retired')?.thinkingContent || '').toBe('');
      expect(f.handle.getStreamingMessage('retired')?.isStreaming).toBe(false);
      f.persist('retired', 'turn');
      expect(f.handle.getStreamingMessage('retired')).toBeUndefined();
      f.handle.dispose();
    }
  );

  it('preserves late-error attribution across reconnect/resync but not persistence or task replacement', async () => {
    const f = await fixture();
    f.task('turn');
    f.thinking('thought', 'turn');
    f.event('streaming:start', 'partial', 'turn');
    f.event('streaming:chunk', 'partial', 'turn', { chunk: 'synthetic partial' });
    f.task('turn', TaskStatus.FAILED);
    f.fireIo('disconnect');
    f.fireIo('connect');
    await f.handle.ready();
    await f.handle.resync();
    f.event('streaming:error', 'thought', 'turn', { error: 'synthetic failure' });
    f.event('streaming:error', 'partial', 'turn', { error: 'synthetic failure' });
    expect(f.handle.getStreamingMessage('thought')?.error).toBe('synthetic failure');
    expect(f.handle.getStreamingMessage('partial')).toMatchObject({
      content: 'synthetic partial',
      error: 'synthetic failure',
      isStreaming: false,
    });
    f.task('next');
    f.thinking('saved', 'next');
    f.thinking('removed', 'next');
    f.task('next', TaskStatus.FAILED);
    f.persist('saved', 'next');
    f.event('streaming:error', 'saved', 'next', { error: 'synthetic obsolete' });
    expect(f.handle.getStreamingMessage('saved')).toBeUndefined();
    f.task('next'); // reactivation discards the previous retirement window
    f.event('streaming:error', 'removed', 'next', { error: 'synthetic obsolete' });
    expect(f.handle.getStreamingMessage('removed')).toBeUndefined();
    f.handle.dispose();
  });

  it('bounds retired attribution, drops unknown/evicted IDs, and clears it on reset/dispose', async () => {
    const f = await fixture();
    f.task('turn');
    for (let n = 0; n < 300; n++) f.thinking(`thought-${n}`, 'turn');
    f.task('turn', TaskStatus.FAILED);
    const retired = () => Reflect.get(f.handle, 'retiredStreamTasks') as Map<string, string>;
    expect(f.handle.state.streamingMessages.size).toBe(0);
    expect(retired().size).toBe(256);
    expect([...retired().values()].every((value) => value === 'turn')).toBe(true);
    f.event('streaming:error', 'thought-0', 'turn', { error: 'synthetic evicted' });
    f.event('streaming:error', 'thought-299', 'turn', {
      task_id: undefined,
      error: 'synthetic untagged',
    });
    expect(f.handle.state.streamingMessages.size).toBe(0);
    f.event('streaming:error', 'thought-299', 'turn', { error: 'synthetic late failure' });
    expect(f.handle.getStreamingMessage('thought-299')?.error).toBe('synthetic late failure');
    f.emitServiceEvent('sessions', 'removed', { session_id: SESSION_ID });
    expect(retired().size).toBe(0);
    f.handle.dispose();
    expect(retired().size).toBe(0);
  });

  it('clears a retired ID when persistence is learned through resync with no live streams', async () => {
    const f = await fixture();
    f.task('turn');
    f.thinking('thought', 'turn');
    f.task('turn', TaskStatus.FAILED);
    f.opts.messagesByTask.turn = [
      {
        ...makeMessage('turn', 0),
        message_id: 'thought' as Message['message_id'],
      },
    ];
    await f.handle.resync();
    f.event('streaming:error', 'thought', 'turn', { error: 'synthetic obsolete' });
    expect(f.handle.getStreamingMessage('thought')).toBeUndefined();
    f.handle.dispose();
  });

  it('releases both populated memoization and retired attribution on direct disposal', async () => {
    const f = await fixture();
    f.task('turn');
    f.thinking('thought', 'turn');
    f.task('turn', TaskStatus.FAILED);
    expect(Reflect.get(f.handle, 'streamTaskIndex')).toBeDefined();
    expect(Reflect.get(f.handle, 'retiredStreamTasks').size).toBe(1);
    f.handle.dispose();
    expect(Reflect.get(f.handle, 'streamTaskIndex')).toBeUndefined();
    expect(Reflect.get(f.handle, 'retiredStreamTasks').size).toBe(0);
  });
});

describe('lazy resync stranded by a disconnect', () => {
  it('stops journaling, reconnects without waiting on it, and discards its late snapshot', async () => {
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
    const internals = handle as unknown as FetchInternals;

    opts.deferTaskMessageFetch = 'task-2';
    const stranded = handle.resync();
    await vi.waitFor(() => expect(internals.messageFetches.size).toBe(1));
    mock.fireIo('disconnect');
    expectNoStrandedFetches(internals);

    opts.deferTaskMessageFetch = undefined;
    const newer = makeMessage('task-2', 1);
    opts.messagesByTask['task-2'] = [...opts.messagesByTask['task-2'], newer];
    mock.fireIo('connect');
    await vi.waitFor(() => expect(handle.getTaskMessages('task-2')).toHaveLength(2));
    for (let beat = 0; beat < 50; beat++) {
      mock.emitServiceEvent('tasks', 'patched', makeTask('task-2', TaskStatus.RUNNING));
      mock.emitServiceEvent('messages', 'patched', newer);
    }
    expectNoStrandedFetches(internals);

    mock.releaseMessageFetch();
    await stranded;
    expect(handle.getTaskMessages('task-2').map((message) => message.message_id)).toEqual([
      'task-2-msg-0',
      newer.message_id,
    ]);
    expect(handle.state.error).toBeNull();
    handle.dispose();
  });
});

describe('bootstrap stranded by a disconnect', () => {
  it.each(['lazy', 'eager'] as const)(
    '%s: starts no hydration after abandonment and leaves no fetch token behind',
    async (taskHydration) => {
      const opts: MockClientOptions = {
        tasks: [makeTask('task-1', TaskStatus.COMPLETED), makeTask('task-2', TaskStatus.COMPLETED)],
        messagesByTask: {
          'task-1': [makeMessage('task-1', 0)],
          'task-2': [makeMessage('task-2', 0)],
        },
      };
      const mock = createMockClient(opts);
      // Session and Task reads resolve; the queue read is still in flight when
      // the socket drops and then rejects with the transport.
      const queueFind = vi.mocked(mock.client.service(`/sessions/${SESSION_ID}/tasks/queue`).find);
      let rejectQueue: (() => void) | undefined;
      queueFind.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectQueue = () => reject(new Error('socket has been disconnected'));
          })
      );
      const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration });
      const internals = handle as unknown as FetchInternals;
      await vi.waitFor(() => expect(rejectQueue).toBeDefined());
      expect(mock.taskFindAll).toHaveBeenCalledTimes(1);

      mock.fireIo('disconnect');
      rejectQueue!();
      await vi.waitFor(() => expect(handle.state.loading).toBe(false));
      expect(mock.messageFindAll).not.toHaveBeenCalled();
      expectNoStrandedFetches(internals);

      const newer = makeMessage('task-2', 1);
      opts.messagesByTask['task-2'] = [...opts.messagesByTask['task-2'], newer];
      mock.fireIo('connect');
      await vi.waitFor(() => expect(handle.getTaskMessages('task-2')).toHaveLength(2));
      for (let beat = 0; beat < 50; beat++) {
        mock.emitServiceEvent('tasks', 'patched', makeTask('task-2', TaskStatus.RUNNING));
        mock.emitServiceEvent('messages', 'patched', newer);
      }
      expectNoStrandedFetches(internals);
      expect(handle.state.tasks.map((task) => task.task_id)).toEqual(['task-1', 'task-2']);
      expect(handle.isTaskLoaded('task-2')).toBe(true);
      expect(handle.state.error).toBeNull();
      handle.dispose();
    }
  );
});

describe('disconnect cleanup alongside terminal stream settlement', () => {
  it('keeps retired thinking attribution across a stranded resync and reconnect', async () => {
    const opts: MockClientOptions = {
      tasks: [makeTask('task-1', TaskStatus.RUNNING)],
      messagesByTask: { 'task-1': [makeMessage('task-1', 0)] },
    };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lazy' });
    await handle.ready();
    const internals = handle as unknown as FetchInternals;
    const retired = () => Reflect.get(handle, 'retiredStreamTasks') as Map<string, string>;
    const thought = { message_id: 'thought', session_id: SESSION_ID, task_id: 'task-1' };
    mock.emitServiceEvent('messages', 'thinking:start', {
      ...thought,
      timestamp: new Date().toISOString(),
    });
    mock.emitServiceEvent('messages', 'thinking:chunk', { ...thought, chunk: 'Considering' });
    expect(handle.getStreamingMessage('thought')?.isThinking).toBe(true);

    // The terminal boundary retires the payload-free thinking stream.
    opts.tasks = [makeTask('task-1', TaskStatus.COMPLETED)];
    mock.emitServiceEvent('tasks', 'patched', opts.tasks[0]);
    expect(handle.getStreamingMessage('thought')).toBeUndefined();
    expect(retired().get('thought')).toBe('task-1');

    opts.deferTaskMessageFetch = 'task-1';
    const stranded = handle.resync();
    await vi.waitFor(() => expect(internals.messageFetches.size).toBe(1));
    mock.fireIo('disconnect');
    expectNoStrandedFetches(internals);
    // Disconnect is not disposal: the bounded attribution window survives.
    expect(retired().get('thought')).toBe('task-1');

    opts.deferTaskMessageFetch = undefined;
    mock.fireIo('connect');
    await vi.waitFor(() => expect(internals.resyncInflight).toBeNull());
    for (let beat = 0; beat < 50; beat++) {
      mock.emitServiceEvent('tasks', 'patched', opts.tasks[0]);
      mock.emitServiceEvent('messages', 'thinking:chunk', { ...thought, chunk: 'late' });
    }
    expectNoStrandedFetches(internals);
    expect(handle.getStreamingMessage('thought')).toBeUndefined();

    mock.emitServiceEvent('messages', 'streaming:error', { ...thought, error: 'late failure' });
    expect(handle.getStreamingMessage('thought')).toMatchObject({
      task_id: 'task-1',
      error: 'late failure',
      isStreaming: false,
      isThinking: false,
    });

    mock.releaseMessageFetch();
    await stranded;
    expect(handle.getStreamingMessage('thought')?.error).toBe('late failure');
    expect(handle.state.error).toBeNull();
    handle.dispose();
  });
});

describe('lean transcript detail retention', () => {
  const turnId = (n: number) => `turn-${String(n).padStart(3, '0')}`;
  /** `outputBytes` pads the tool result: a turn that read a large file. */
  const fullMessage = (taskId: string, n: number, outputBytes = 0) =>
    ({
      ...makeMessage(taskId, n),
      role: 'assistant',
      content: [
        { type: 'text', text: `Answer ${n}` },
        { type: 'thinking', text: `Reasoning ${n}` },
        { type: 'tool_use', id: `tool-${n}`, name: 'Read', input: { path: '/fixture' } },
        {
          type: 'tool_result',
          tool_use_id: `tool-${n}`,
          content: `TOOL_OUTPUT_${n}${'x'.repeat(outputBytes)}`,
        },
      ],
      tool_uses: [{ id: `tool-${n}`, name: 'Read', input: { path: '/fixture' } }],
      metadata: { model: 'synthetic', raw_sdk_message: `RAW_${n}` },
    }) as unknown as Message;

  async function fixture() {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    /** One live turn as the executor delivers it: running → payload → completed. */
    const runTurn = (n: number, whileRunning?: (taskId: string) => void, outputBytes = 0) => {
      const taskId = turnId(n);
      const running = makeTask(taskId, TaskStatus.RUNNING);
      opts.tasks = [...opts.tasks.filter((task) => task.task_id !== taskId), running];
      mock.emitServiceEvent('tasks', 'created', running);
      whileRunning?.(taskId);
      opts.messagesByTask[taskId] = [fullMessage(taskId, n, outputBytes)];
      mock.emitServiceEvent('messages', 'created', fullMessage(taskId, n, outputBytes));
      const completed = makeTask(taskId, TaskStatus.COMPLETED);
      opts.tasks = opts.tasks.map((task) => (task.task_id === taskId ? completed : task));
      mock.emitServiceEvent('tasks', 'patched', completed);
    };
    const fullIds = () =>
      [...handle.state.messagesByTask]
        .filter(([, messages]) =>
          messages.some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some((block) => block.type === 'tool_result')
          )
        )
        .map(([taskId]) => taskId)
        .sort();
    return { ...mock, opts, handle, runTurn, fullIds };
  }

  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => turnId(from + i));

  it('keeps recent and pinned turns full, projects older turns, and reloads them on demand', async () => {
    const f = await fixture();
    const releaseA = f.handle.retainTaskDetails(turnId(0));
    const releaseB = f.handle.retainTaskDetails(turnId(0));
    for (let n = 0; n < 30; n++) f.runTurn(n);
    expect(LEAN_TRANSCRIPT_DETAIL_RETENTION_COUNT).toBe(10);
    // History is projected, never deleted.
    expect(f.handle.state.messagesByTask.size).toBe(30);
    expect(f.fullIds()).toEqual([turnId(0), ...range(20, 29)]);
    expect(f.handle.getTaskMessages(turnId(5))).toEqual([
      {
        message_id: `${turnId(5)}-msg-5`,
        session_id: SESSION_ID,
        task_id: turnId(5),
        index: 5,
        role: 'assistant',
        content: [{ type: 'text', text: 'Answer 5' }],
        content_preview: '',
        has_deferred_reasoning: true,
        tool_uses: undefined,
        parent_tool_use_id: undefined,
        metadata: { model: 'synthetic' },
      },
    ]);

    // One consumer's release (even repeated) cannot unpin another reader.
    releaseA();
    releaseA();
    await Promise.resolve();
    expect(f.fullIds()).toContain(turnId(0));
    releaseB();
    expect(f.fullIds()).toContain(turnId(0)); // deferred past React effect replacement
    await Promise.resolve();
    expect(f.fullIds()).toEqual(range(20, 29));

    // A late persisted patch for an evicted turn lands projected.
    f.emitServiceEvent('messages', 'patched', fullMessage(turnId(0), 0));
    expect(f.fullIds()).toEqual(range(20, 29));
    expect(f.handle.getTaskMessages(turnId(0))[0].content).toEqual([
      { type: 'text', text: 'Answer 0' },
    ]);

    // Re-expanding reloads from persisted history and becomes the newest recent turn.
    await f.handle.loadTaskMessages(turnId(0));
    expect(f.handle.getTaskMessages(turnId(0))).toEqual([fullMessage(turnId(0), 0)]);
    expect(f.handle.isTaskLoaded(turnId(0))).toBe(true);
    expect(f.fullIds()).toEqual([turnId(0), ...range(21, 29)]);
    expect(f.handle.isTaskLoaded(turnId(20))).toBe(false);

    // Reconnect refetches only retained detail; evicted live turns come back lean.
    f.messageFindAll.mockClear();
    await f.handle.resync();
    const fullFetches = f.messageFindAll.mock.calls
      .filter(([params]) => params.query.transcript !== 'lean')
      .map(([params]) => params.query.task_id as string)
      .sort();
    expect(fullFetches).toEqual([turnId(0), ...range(21, 29)]);
    expect(f.fullIds()).toEqual([turnId(0), ...range(21, 29)]);
    f.handle.dispose();
    for (const name of ['recentDetailTaskIds', 'detailPins', 'detailTaskIds', 'leanLiveTaskIds'])
      expect((Reflect.get(f.handle, name) as Set<string>).size).toBe(0);
    // Late React cleanups/effects after disposal are harmless no-ops.
    f.handle.retainTaskDetails(turnId(0))();
    releaseB();
  });

  it('keeps a delayed reload that newer turns overtake until its reader can see it', async () => {
    const f = await fixture();
    for (let n = 0; n < 12; n++) f.runTurn(n);
    expect(f.fullIds()).not.toContain(turnId(0));
    f.opts.deferTaskMessageFetch = turnId(0);
    const reload = f.handle.loadTaskMessages(turnId(0));
    // A full recent-turn budget of newer turns arrives while the read is pending.
    for (let n = 12; n < 12 + LEAN_TRANSCRIPT_DETAIL_RETENTION_COUNT; n++) f.runTurn(n);
    f.opts.deferTaskMessageFetch = undefined;
    f.releaseMessageFetch();
    expect(await reload).toEqual([fullMessage(turnId(0), 0)]);
    // The commit, not the request, makes it the newest recent turn.
    expect(f.handle.isTaskLoaded(turnId(0))).toBe(true);
    expect(f.handle.getTaskMessages(turnId(0))).toEqual([fullMessage(turnId(0), 0)]);
    for (let n = 22; n < 22 + LEAN_TRANSCRIPT_DETAIL_RETENTION_COUNT - 1; n++) f.runTurn(n);
    expect(f.fullIds()).toContain(turnId(0));
    f.runTurn(31);
    expect(f.fullIds()).not.toContain(turnId(0));
    f.handle.dispose();
  });

  it('keeps no evicted turn reasoning in cached messages or settled thinking streams', async () => {
    const f = await fixture();
    for (let n = 0; n < 15; n++) {
      // Live reasoning arrives on a temporary stream ID, then persists.
      f.runTurn(n, (taskId) => {
        const event = { session_id: SESSION_ID, message_id: `thought-${n}`, task_id: taskId };
        f.emitServiceEvent('messages', 'thinking:start', event);
        f.emitServiceEvent('messages', 'thinking:chunk', { ...event, chunk: `Streamed ${n}` });
        f.emitServiceEvent('messages', 'thinking:end', event);
        expect(f.handle.getStreamingMessage(`thought-${n}`)?.thinkingContent).toBe(`Streamed ${n}`);
      });
    }
    const state = JSON.stringify({
      messages: [...f.handle.state.messagesByTask],
      streams: [...f.handle.state.streamingMessages],
    });
    const turnsWith = (label: string) =>
      Array.from({ length: 15 }, (_, n) => n).filter((n) => state.includes(`${label} ${n}"`));
    expect(turnsWith('Reasoning')).toEqual(Array.from({ length: 10 }, (_, i) => i + 5));
    expect(turnsWith('Streamed')).toEqual([]);
    // The evicted turn still advertises its reasoning, and a reload restores it.
    expect(f.handle.getTaskMessages(turnId(0))[0]).toMatchObject({
      content: [{ type: 'text', text: 'Answer 0' }],
      has_deferred_reasoning: true,
    });
    await f.handle.loadTaskMessages(turnId(0));
    expect(f.handle.getTaskMessages(turnId(0))[0].content).toContainEqual({
      type: 'thinking',
      text: 'Reasoning 0',
    });
    f.handle.dispose();
  });

  it('keeps executing, latest and early-payload turns full regardless of age', async () => {
    const f = await fixture();
    const active = makeTask('active-old', TaskStatus.RUNNING);
    f.opts.tasks.push(active);
    f.emitServiceEvent('tasks', 'created', active);
    f.emitServiceEvent('messages', 'created', fullMessage(active.task_id, 99));
    for (let n = 0; n < 15; n++) f.runTurn(n);
    expect(f.fullIds()).toEqual(['active-old', ...range(5, 14)]);
    // A payload ahead of its Task is charged to the recent budget, not dropped.
    f.emitServiceEvent('messages', 'created', fullMessage('early', 100));
    expect(f.fullIds()).toContain('early');
    f.emitServiceEvent('tasks', 'created', makeTask('early', TaskStatus.RUNNING));
    expect(f.fullIds()).toContain('early');
    // The latest turn stays full even when the recent budget is spent elsewhere.
    for (let n = 15; n < 26; n++) await f.handle.loadTaskMessages(turnId(n % 15));
    expect(f.fullIds()).toEqual(expect.arrayContaining(['active-old', 'early', turnId(14)]));
    f.handle.dispose();
  });

  it('leaves terminal stream settlement intact for evicted turns', async () => {
    const f = await fixture();
    const event = (name: string, id: string, taskId: string, extra = {}) =>
      f.emitServiceEvent('messages', name, {
        session_id: SESSION_ID,
        message_id: id,
        task_id: taskId,
        timestamp: '2026-01-01T00:00:00.000Z',
        role: 'assistant',
        ...extra,
      });
    const failed = makeTask('failed', TaskStatus.RUNNING);
    f.emitServiceEvent('tasks', 'created', failed);
    event('thinking:start', 'thought', 'failed');
    event('thinking:chunk', 'thought', 'failed', { chunk: 'considering' });
    event('streaming:start', 'partial', 'failed');
    event('streaming:chunk', 'partial', 'failed', { chunk: 'unpersisted partial' });
    event('streaming:error', 'partial', 'failed', { error: 'synthetic failure' });
    f.emitServiceEvent('tasks', 'patched', makeTask('failed', TaskStatus.FAILED));
    for (let n = 0; n < 12; n++) f.runTurn(n);
    expect(f.fullIds()).not.toContain('failed');
    // The partial has no persisted reload path, so detail eviction keeps it.
    expect(f.handle.getStreamingMessage('partial')).toMatchObject({
      content: 'unpersisted partial',
      error: 'synthetic failure',
      isStreaming: false,
    });
    // Retired thinking attribution still accepts an exact late error only.
    expect(f.handle.getStreamingMessage('thought')).toBeUndefined();
    event('thinking:chunk', 'thought', 'failed', { chunk: 'late' });
    expect(f.handle.getStreamingMessage('thought')).toBeUndefined();
    event('streaming:error', 'thought', 'failed', { error: 'late failure' });
    expect(f.handle.getStreamingMessage('thought')).toMatchObject({
      task_id: 'failed',
      error: 'late failure',
    });
    // Persistence replaces the partial and lands projected for the evicted turn.
    f.emitServiceEvent('messages', 'created', {
      ...fullMessage('failed', 50),
      message_id: 'partial',
    });
    expect(f.handle.getStreamingMessage('partial')).toBeUndefined();
    expect(f.handle.getTaskMessages('failed').map((message) => message.content)).toEqual([
      [{ type: 'text', text: 'Answer 50' }],
    ]);
    f.handle.dispose();
  });

  it('strands no fetch tokens or journal entries across disconnect, eviction and reconnect', async () => {
    const f = await fixture();
    const internals = f.handle as unknown as FetchInternals;
    for (let n = 0; n < 12; n++) f.runTurn(n);
    const release = f.handle.retainTaskDetails(turnId(0));
    f.opts.deferTaskMessageFetch = turnId(0);
    const abandoned = f.handle.loadTaskMessages(turnId(0));
    expect(internals.messageFetches.size).toBe(1);
    f.fireIo('disconnect');
    expectNoStrandedFetches(internals);
    // Live traffic and evictions while offline neither journal nor regrow detail.
    for (let n = 12; n < 30; n++) f.runTurn(n);
    expect(internals.messageMutations).toHaveLength(0);
    expect(f.fullIds()).toEqual(range(20, 29));
    f.opts.deferTaskMessageFetch = undefined;
    f.fireIo('connect');
    await f.handle.ready();
    f.releaseMessageFetch();
    expect(await abandoned).toEqual([]);
    expectNoStrandedFetches(internals);
    expect(f.handle.isTaskLoaded(turnId(0))).toBe(false);
    // A fresh expansion on the new connection commits as the newest recent turn.
    await f.handle.loadTaskMessages(turnId(0));
    expect(f.fullIds()).toEqual([turnId(0), ...range(21, 29)]);
    release();
    await Promise.resolve();
    expect(f.fullIds()).toEqual([turnId(0), ...range(21, 29)]);
    expectNoStrandedFetches(internals);
    expect((Reflect.get(f.handle, 'leanLiveTaskIds') as Set<string>).size).toBeLessThanOrEqual(
      LEAN_TRANSCRIPT_DETAIL_RETENTION_COUNT
    );
    f.handle.dispose();
  });

  const BUDGET = LEAN_TRANSCRIPT_DETAIL_BYTE_BUDGET;
  /** Four of these fit the byte budget with their small text; a fifth does not. */
  const QUARTER = BUDGET / 4 - 4096;

  it('accounts retained detail bytes on commit, live and late messages', async () => {
    const f = await fixture();
    const bytes = () => f.handle.getRetainedDetailBytes();
    expect(bytes()).toBe(0);
    f.runTurn(0, undefined, 100_000);
    const one = bytes();
    expect(one).toBeGreaterThan(100_000);
    expect(one).toBeLessThan(101_000);
    // A live message adds its size; a patch replaces it rather than adding.
    f.emitServiceEvent('messages', 'created', { ...fullMessage(turnId(0), 1, 5000) });
    expect(bytes()).toBeGreaterThan(one + 5000);
    f.emitServiceEvent('messages', 'patched', { ...fullMessage(turnId(0), 1, 100) });
    expect(bytes()).toBeGreaterThan(one + 100);
    expect(bytes()).toBeLessThan(one + 1000);
    // Streaming chunks touch no message bucket and charge nothing.
    const settled = bytes();
    const stream = { session_id: SESSION_ID, message_id: 'stream-0', task_id: turnId(0) };
    f.emitServiceEvent('messages', 'streaming:start', { ...stream, role: 'assistant' });
    f.emitServiceEvent('messages', 'streaming:chunk', { ...stream, chunk: 'z'.repeat(9000) });
    expect(bytes()).toBe(settled);
    // Evicted turns stop counting; their late messages land projected and free.
    for (let n = 1; n <= LEAN_TRANSCRIPT_DETAIL_RETENTION_COUNT; n++) f.runTurn(n);
    expect(f.fullIds()).not.toContain(turnId(0));
    const recent = bytes();
    expect(recent).toBeLessThan(5000);
    f.emitServiceEvent('messages', 'patched', fullMessage(turnId(0), 0, 50_000));
    expect(bytes()).toBe(recent);
    // A committed reload is charged again.
    f.opts.messagesByTask[turnId(0)] = [fullMessage(turnId(0), 0, 20_000)];
    await f.handle.loadTaskMessages(turnId(0));
    expect(bytes()).toBeGreaterThan(20_000);
    f.handle.dispose();
    expect(bytes()).toBe(0);
  });

  it('evicts recent turns oldest first over the byte budget; the count bound still applies', async () => {
    const f = await fixture();
    for (let n = 0; n < 6; n++) f.runTurn(n, undefined, QUARTER);
    expect(f.fullIds()).toEqual(range(2, 5));
    expect(f.handle.getRetainedDetailBytes()).toBeLessThanOrEqual(BUDGET);
    expect(f.handle.isTaskLoaded(turnId(1))).toBe(false);
    expect(f.handle.getTaskMessages(turnId(1))[0]).toMatchObject({
      content: [{ type: 'text', text: 'Answer 1' }],
      has_deferred_reasoning: true,
    });
    // Small turns fill the count bound, which evicts on its own.
    for (let n = 6; n < 12; n++) f.runTurn(n);
    expect(f.fullIds()).toEqual(range(2, 11));
    f.runTurn(12);
    expect(f.fullIds()).toEqual(range(3, 12));
    f.handle.dispose();
  });

  it('never evicts protected turns for the budget, and evicts every other turn', async () => {
    const f = await fixture();
    const release = f.handle.retainTaskDetails(turnId(0));
    f.runTurn(0, undefined, BUDGET * 0.6);
    const active = makeTask('active', TaskStatus.RUNNING);
    f.opts.tasks.push(active);
    f.emitServiceEvent('tasks', 'created', active);
    f.emitServiceEvent('messages', 'created', fullMessage('active', 99, BUDGET * 0.6));
    f.runTurn(1);
    f.runTurn(2);
    // Pinned + executing alone exceed the budget: both stay, with the latest.
    expect(f.fullIds()).toEqual(['active', turnId(0), turnId(2)]);
    expect(f.handle.getRetainedDetailBytes()).toBeGreaterThan(BUDGET);
    release();
    await Promise.resolve();
    expect(f.fullIds()).toEqual(['active', turnId(2)]);
    f.handle.dispose();
  });

  it('evicts a single over-budget turn to lean; it reloads, and stays while pinned', async () => {
    const f = await fixture();
    f.runTurn(0, undefined, BUDGET * 1.5);
    // Latest: protected.
    expect(f.fullIds()).toEqual([turnId(0)]);
    f.runTurn(1);
    expect(f.fullIds()).toEqual([turnId(1)]);
    expect(f.handle.getTaskMessages(turnId(0))[0].content).toEqual([
      { type: 'text', text: 'Answer 0' },
    ]);
    // A reader expanding it pins it first; the reload is kept until released.
    const release = f.handle.retainTaskDetails(turnId(0));
    const loaded = await f.handle.loadTaskMessages(turnId(0));
    expect(loaded).toEqual([fullMessage(turnId(0), 0, BUDGET * 1.5)]);
    expect(f.handle.isTaskLoaded(turnId(0))).toBe(true);
    expect(f.fullIds()).toEqual([turnId(0), turnId(1)]);
    release();
    await Promise.resolve();
    expect(f.fullIds()).toEqual([turnId(1)]);
    expect(f.handle.isTaskLoaded(turnId(0))).toBe(false);
    f.handle.dispose();
  });

  it('keeps budget evictions out of the journal and the reconnect refetch', async () => {
    const f = await fixture();
    const internals = f.handle as unknown as FetchInternals;
    f.runTurn(0, undefined, QUARTER);
    f.opts.deferTaskMessageFetch = turnId(0);
    const abandoned = f.handle.loadTaskMessages(turnId(0));
    f.fireIo('disconnect');
    expectNoStrandedFetches(internals);
    for (let n = 1; n < 6; n++) f.runTurn(n, undefined, QUARTER);
    expect(internals.messageMutations).toHaveLength(0);
    expect(f.fullIds()).toEqual(range(2, 5));
    f.opts.deferTaskMessageFetch = undefined;
    f.messageFindAll.mockClear();
    f.fireIo('connect');
    await f.handle.ready();
    f.releaseMessageFetch();
    expect(await abandoned).toEqual([]);
    expectNoStrandedFetches(internals);
    const fullFetches = f.messageFindAll.mock.calls
      .filter(([params]) => params.query.transcript !== 'lean')
      .map(([params]) => params.query.task_id as string)
      .sort();
    expect(fullFetches).toEqual(range(2, 5));
    expect(f.fullIds()).toEqual(range(2, 5));
    expect(f.handle.isTaskLoaded(turnId(0))).toBe(false);
    f.handle.dispose();
  });

  it('keeps an evicted turn unpersisted partial stream when the budget evicts it', async () => {
    const f = await fixture();
    const failed = makeTask('failed', TaskStatus.RUNNING);
    f.opts.tasks.push(failed);
    f.emitServiceEvent('tasks', 'created', failed);
    f.emitServiceEvent('messages', 'created', fullMessage('failed', 40, BUDGET * 0.6));
    const event = (name: string, extra = {}) =>
      f.emitServiceEvent('messages', name, {
        session_id: SESSION_ID,
        message_id: 'partial',
        task_id: 'failed',
        timestamp: '2026-01-01T00:00:00.000Z',
        role: 'assistant',
        ...extra,
      });
    event('streaming:start');
    event('streaming:chunk', { chunk: 'unpersisted partial' });
    event('streaming:error', { error: 'synthetic failure' });
    f.emitServiceEvent('tasks', 'patched', makeTask('failed', TaskStatus.FAILED));
    // One newer large turn pushes the failed turn over the budget, not the count.
    f.runTurn(0, undefined, BUDGET * 0.6);
    expect(f.fullIds()).toEqual([turnId(0)]);
    expect(f.handle.getStreamingMessage('partial')).toMatchObject({
      content: 'unpersisted partial',
      error: 'synthetic failure',
      isStreaming: false,
    });
    // Persistence replaces the partial and lands projected.
    f.emitServiceEvent('messages', 'created', {
      ...fullMessage('failed', 50, BUDGET * 0.6),
      message_id: 'partial',
    });
    expect(f.handle.getStreamingMessage('partial')).toBeUndefined();
    expect(f.fullIds()).toEqual([turnId(0)]);
    f.handle.dispose();
  });
});

describe('lean transcript window trimming', () => {
  const id = (n: number) => `task-${String(n).padStart(3, '0')}`;
  const ids = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => id(from + i));
  const answer = (taskId: string) =>
    ({
      ...makeMessage(taskId, 1),
      role: 'assistant',
      content: [
        { type: 'text', text: `Answer ${taskId}` },
        { type: 'tool_use', id: `tool-${taskId}`, name: 'Read', input: {} },
      ],
    }) as unknown as Message;

  /** 24 persisted turns; the reader opens on the latest ten. */
  async function fixture(options: ReactiveSessionOptions = { taskHydration: 'lean' }) {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    for (let n = 0; n < 24; n++) {
      opts.tasks.push(makeTask(id(n), TaskStatus.COMPLETED));
      opts.messagesByTask[id(n)] = [makeMessage(id(n), 0), answer(id(n))];
    }
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, options);
    await handle.ready();
    let next = 24;
    /** The daemon appends Session.tasks when a turn dispatches. */
    const publishSession = () =>
      mock.emitServiceEvent('sessions', 'patched', {
        session_id: SESSION_ID,
        tasks: opts.tasks.map((task) => task.task_id),
      });
    /** Live turns as the executor publishes them while the reader watches. */
    const addTurns = (count: number, live = true) => {
      for (let i = 0; i < count; i++) {
        const taskId = id(next++);
        opts.tasks.push(makeTask(taskId, TaskStatus.COMPLETED));
        opts.messagesByTask[taskId] = [makeMessage(taskId, 0), answer(taskId)];
        if (!live) continue;
        mock.emitServiceEvent('tasks', 'created', makeTask(taskId, TaskStatus.RUNNING));
        publishSession();
        for (const message of opts.messagesByTask[taskId])
          mock.emitServiceEvent('messages', 'created', message);
        mock.emitServiceEvent('tasks', 'patched', makeTask(taskId, TaskStatus.COMPLETED));
      }
    };
    const reserve = () => id(next++);
    const taskIds = () => handle.state.tasks.map((task): string => task.task_id);
    /** Every per-task collection the handle exposes, keyed by Task ID. */
    const heldIds = () =>
      new Set([
        ...handle.state.messagesByTask.keys(),
        ...handle.state.toolsByTask.keys(),
        ...handle.state.loadedTaskIds,
        ...[...handle.state.streamingMessages.values()].map((stream) => stream.task_id),
      ]);
    return { ...mock, opts, handle, addTurns, reserve, publishSession, taskIds, heldIds };
  }

  it('drops the oldest turns beyond the window and pages them back in order', async () => {
    const f = await fixture();
    expect(LEAN_TRANSCRIPT_TASK_WINDOW).toBe(30);
    f.addTurns(30);
    f.emitServiceEvent('tasks', 'tool:start', {
      session_id: SESSION_ID,
      task_id: id(14),
      tool_use_id: 'old',
      tool_name: 'Read',
    });
    expect(f.taskIds()).toEqual(ids(14, 53));
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()).toEqual(ids(24, 53));
    expect(f.handle.state.hasOlderTasks).toBe(true);
    for (const trimmed of ids(14, 23)) expect(f.heldIds().has(trimmed)).toBe(false);
    expect((Reflect.get(f.handle, 'leanLiveTaskIds') as Set<string>).has(id(14))).toBe(false);
    expect(f.handle.trimOlderTasks()).toBe(false);

    // The existing older-history path restores them, page by page, gap-free.
    await f.handle.loadOlderTasks();
    expect(f.taskIds()).toEqual(ids(14, 53));
    expect(f.handle.getTaskMessages(id(14)).map((message) => message.index)).toEqual([0, 1]);
    expect(JSON.stringify(f.handle.getTaskMessages(id(14)))).not.toContain('tool_use');
    await f.handle.loadOlderTasks();
    await f.handle.loadOlderTasks();
    expect(f.taskIds()).toEqual(ids(0, 53));
    expect(f.handle.state.hasOlderTasks).toBe(false);

    // Back at the latest turns, the window applies again.
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()).toEqual(ids(24, 53));
    expect(f.handle.state.hasOlderTasks).toBe(true);
    f.handle.dispose();
  });

  it('keeps a contiguous window: stops at protected turns and the first visible turn', async () => {
    const f = await fixture();
    f.addTurns(36); // 46 loaded: task-014 … task-059
    // The first turn the reader sees bounds the trim.
    expect(f.handle.trimOlderTasks(id(17))).toBe(true);
    expect(f.taskIds()[0]).toBe(id(17));

    // A pinned turn (expanded disclosure, focus, selection, overlay) holds itself and everything newer.
    const release = f.handle.retainTaskDetails(id(20));
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()[0]).toBe(id(20));
    expect(f.handle.trimOlderTasks()).toBe(false);
    release();
    await Promise.resolve();
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()).toEqual(ids(30, 59));

    // Unsettled turns: executing (which covers streaming) or awaiting the reader.
    const blockers: Array<[string, () => void, () => void]> = [
      [
        'running',
        () => f.emitServiceEvent('tasks', 'patched', makeTask(id(30), TaskStatus.RUNNING)),
        () => f.emitServiceEvent('tasks', 'patched', makeTask(id(30), TaskStatus.COMPLETED)),
      ],
      [
        'pending permission',
        () =>
          f.emitServiceEvent('messages', 'created', {
            ...makeMessage(id(30), 5),
            type: 'permission_request',
            content: { request_id: 'r', tool_name: 'Bash', tool_input: {}, status: 'pending' },
          }),
        () =>
          f.emitServiceEvent('messages', 'patched', {
            ...makeMessage(id(30), 5),
            type: 'permission_request',
            content: { request_id: 'r', tool_name: 'Bash', tool_input: {}, status: 'approved' },
          }),
      ],
      [
        'pending widget',
        () =>
          f.emitServiceEvent('messages', 'created', {
            ...makeMessage(id(30), 6),
            type: 'widget_request',
            metadata: { widget: { widget_type: 'env_vars', status: 'pending' } },
          }),
        () =>
          f.emitServiceEvent('messages', 'patched', {
            ...makeMessage(id(30), 6),
            type: 'widget_request',
            metadata: { widget: { widget_type: 'env_vars', status: 'submitted' } },
          }),
      ],
    ];
    for (const [label, block, settle] of blockers) {
      f.addTurns(1);
      block();
      expect(f.handle.trimOlderTasks(), label).toBe(false);
      expect(f.taskIds()[0]).toBe(id(30));
      settle();
    }
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()).toHaveLength(LEAN_TRANSCRIPT_TASK_WINDOW);
    f.handle.dispose();
  });

  it('only trims a lean conversation reader', async () => {
    for (const options of [
      { taskHydration: 'lean', cacheScope: 'preview' },
      { taskHydration: 'lazy' },
      { taskHydration: 'eager' },
    ] as ReactiveSessionOptions[]) {
      const f = await fixture(options);
      f.addTurns(40);
      const before = f.taskIds();
      expect(f.handle.trimOlderTasks()).toBe(false);
      expect(f.taskIds()).toEqual(before);
      f.handle.dispose();
    }
  });

  it('never lets resync or late traffic resurrect a trimmed turn or open a gap', async () => {
    const f = await fixture();
    const internals = f.handle as unknown as FetchInternals;
    f.addTurns(30);
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()).toEqual(ids(24, 53));

    // Late traffic for trimmed turns: a Task patch, persisted messages, tools and streams.
    const trimmed = id(20);
    const event = { session_id: SESSION_ID, task_id: trimmed };
    f.emitServiceEvent('tasks', 'patched', makeTask(trimmed, TaskStatus.COMPLETED));
    f.emitServiceEvent('messages', 'created', makeMessage(trimmed, 7));
    f.emitServiceEvent('messages', 'patched', answer(trimmed));
    f.emitServiceEvent('messages', 'removed', makeMessage(trimmed, 0));
    f.emitServiceEvent('tasks', 'tool:start', { ...event, tool_use_id: 't', tool_name: 'Read' });
    f.emitServiceEvent('messages', 'streaming:chunk', { ...event, message_id: 's', chunk: 'x' });
    f.emitServiceEvent('messages', 'thinking:chunk', { ...event, message_id: 'h', chunk: 'x' });
    f.emitServiceEvent('messages', 'streaming:error', { ...event, message_id: 's', error: 'x' });
    expect(f.taskIds()).toEqual(ids(24, 53));
    expect(f.heldIds().has(trimmed)).toBe(false);
    expect(f.handle.state.streamingMessages.size).toBe(0);

    // Reconnect refreshes reached history only: no trimmed reads, no trimmed rows.
    const taskFind = vi.mocked(f.client.service('tasks').find);
    taskFind.mockClear();
    await f.handle.resync();
    expect(f.taskIds()).toEqual(ids(24, 53));
    const read = taskFind.mock.calls.flatMap(
      ([params]) => (params?.query?.task_id as { $in?: string[] } | undefined)?.$in ?? []
    );
    expect(read).toEqual(ids(24, 53));
    expect(vi.mocked(f.client.service('tasks').get)).not.toHaveBeenCalled();

    // A trim is refused while a history read is in flight; a patch journaled
    // for a trimmed turn during that read does not resurrect it at commit.
    f.addTurns(1);
    f.opts.deferTaskMessageFetch = id(54);
    f.messageFindAll.mockClear();
    const resync = f.handle.resync();
    expect(internals.taskFetches.size).toBe(1);
    expect(f.handle.trimOlderTasks()).toBe(false);
    f.emitServiceEvent('tasks', 'patched', makeTask(trimmed, TaskStatus.COMPLETED));
    await vi.waitFor(() => expect(JSON.stringify(f.messageFindAll.mock.calls)).toContain(id(54)));
    f.opts.deferTaskMessageFetch = undefined;
    f.releaseMessageFetch();
    await resync;
    expect(f.taskIds()).toEqual(ids(24, 54));
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()).toEqual(ids(25, 54));

    // More than a page of turns while offline: the window refills from the
    // cursor without a gap, and stays above the trimmed history.
    f.fireIo('disconnect');
    f.addTurns(25, false);
    f.fireIo('connect');
    await f.handle.ready();
    expect(f.taskIds()).toEqual(ids(25, 79));
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()).toEqual(ids(50, 79));
    await f.handle.loadOlderTasks();
    expect(f.taskIds()).toEqual(ids(40, 79));
    expectNoStrandedFetches(internals);
    f.handle.dispose();
  });

  it('discards an older page abandoned by a disconnect once the window moved', async () => {
    const f = await fixture();
    const internals = f.handle as unknown as FetchInternals;
    f.addTurns(30);
    f.opts.deferTaskMessageFetch = id(13);
    f.messageFindAll.mockClear();
    const older = f.handle.loadOlderTasks();
    await vi.waitFor(() => expect(JSON.stringify(f.messageFindAll.mock.calls)).toContain(id(13)));
    expect(f.handle.trimOlderTasks()).toBe(false);
    f.fireIo('disconnect');
    expectNoStrandedFetches(internals);
    // Offline, the parked reader's view still trims.
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()).toEqual(ids(24, 53));
    f.opts.deferTaskMessageFetch = undefined;
    f.releaseMessageFetch();
    await older;
    expect(f.taskIds()).toEqual(ids(24, 53));
    f.fireIo('connect');
    await f.handle.ready();
    expect(f.taskIds()).toEqual(ids(24, 53));
    await f.handle.loadOlderTasks();
    expect(f.taskIds()).toEqual(ids(14, 53));
    expectNoStrandedFetches(internals);
    f.handle.dispose();
  });

  it('settles terminal streams before trimming and attributes nothing to a trimmed turn', async () => {
    const f = await fixture();
    const failed = f.reserve();
    const stream = (name: string, messageId: string, extra = {}) =>
      f.emitServiceEvent('messages', name, {
        session_id: SESSION_ID,
        message_id: messageId,
        task_id: failed,
        timestamp: '2026-01-01T00:00:00.000Z',
        role: 'assistant',
        ...extra,
      });
    f.opts.tasks.push(makeTask(failed, TaskStatus.FAILED));
    f.opts.messagesByTask[failed] = [makeMessage(failed, 0)];
    f.emitServiceEvent('tasks', 'created', makeTask(failed, TaskStatus.RUNNING));
    f.publishSession();
    stream('thinking:start', 'thought');
    stream('thinking:chunk', 'thought', { chunk: 'considering' });
    stream('streaming:start', 'partial');
    stream('streaming:chunk', 'partial', { chunk: 'unpersisted partial' });
    stream('streaming:error', 'partial', { error: 'synthetic failure' });
    f.emitServiceEvent('tasks', 'patched', makeTask(failed, TaskStatus.FAILED));
    // #2930: terminal settlement keeps the errored partial and retires the thought.
    expect(f.handle.getStreamingMessage('partial')).toMatchObject({ isStreaming: false });
    expect(f.handle.getStreamingMessage('thought')).toBeUndefined();
    // Make the failed turn the oldest one loaded, then age it out.
    f.addTurns(40);
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()).not.toContain(failed);
    // Its settled partial has no reload path and goes with it, as on a page reload.
    expect(f.handle.state.streamingMessages.size).toBe(0);
    expect((Reflect.get(f.handle, 'retiredStreamTasks') as Map<string, string>).size).toBe(0);
    stream('streaming:error', 'thought', { error: 'late failure' });
    stream('thinking:chunk', 'thought', { chunk: 'late' });
    stream('streaming:chunk', 'partial', { chunk: 'late' });
    expect(f.handle.state.streamingMessages.size).toBe(0);
    // Paging back restores the persisted turn only.
    while (!f.taskIds().includes(failed)) await f.handle.loadOlderTasks();
    expect(f.handle.getTask(failed)?.status).toBe(TaskStatus.FAILED);
    expect(f.handle.getTaskMessages(failed).map((message) => message.message_id)).toEqual([
      `${failed}-msg-0`,
    ]);
    expect(f.handle.state.streamingMessages.size).toBe(0);
    f.handle.dispose();
  });
});

describe('lean transcript window follows displayed turn order', () => {
  // UUIDv7-shaped IDs in creation order, as the daemon mints ordinary turns.
  const turn = (n: number) => `0199c000-0000-7000-8000-${String(n).padStart(12, '0')}` as TaskID;
  /** A Task from another Session that finished long before this one began. */
  const earlierSource = '0199a000-0000-7000-8000-000000000001' as TaskID;
  const answer = (taskId: string) => ({ ...makeMessage(taskId, 1), content: `Answer ${taskId}` });

  async function fixture() {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    for (let n = 0; n < 24; n++) {
      opts.tasks.push(makeTask(turn(n), TaskStatus.COMPLETED));
      opts.messagesByTask[turn(n)] = [answer(turn(n)) as Message];
    }
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    let next = 24;
    /** The daemon appends Session.tasks at dispatch, in run order. */
    const publishSession = () =>
      mock.emitServiceEvent('sessions', 'patched', {
        session_id: SESSION_ID,
        tasks: opts.tasks.filter((task) => task.status !== TaskStatus.QUEUED).map((t) => t.task_id),
      });
    /** One turn runs to completion; it may be a known (e.g. callback or queued) Task. */
    const run = (taskId: string, { created = true } = {}) => {
      const known = opts.tasks.find((task) => task.task_id === taskId);
      if (known) opts.tasks.splice(opts.tasks.indexOf(known), 1);
      opts.tasks.push(makeTask(taskId, TaskStatus.RUNNING));
      opts.messagesByTask[taskId] = [answer(taskId) as Message];
      if (created) mock.emitServiceEvent('tasks', 'created', makeTask(taskId, TaskStatus.RUNNING));
      publishSession();
      if (created) mock.emitServiceEvent('messages', 'created', answer(taskId));
      opts.tasks[opts.tasks.length - 1] = makeTask(taskId, TaskStatus.COMPLETED);
      mock.emitServiceEvent('tasks', 'patched', makeTask(taskId, TaskStatus.COMPLETED));
    };
    const runTurns = (count: number) => {
      for (let i = 0; i < count; i++) run(turn(next++));
    };
    const taskIds = () => handle.state.tasks.map((task): string => task.task_id);
    return { ...mock, opts, handle, run, runTurns, taskIds, turn: (n: number) => turn(n) };
  }

  it('keeps a newest callback whose durable ID sorts before every loaded turn', async () => {
    const f = await fixture();
    f.runTurns(36); // 46 loaded: turns 14 … 59
    const callback = completionCallbackTaskId(earlierSource, SESSION_ID as SessionID);
    expect(callback < f.turn(0)).toBe(true);
    f.run(callback);
    expect(f.taskIds().at(-1)).toBe(callback);
    // The reader sees turns 20 … 59 and the callback answer at the bottom.
    expect(f.handle.trimOlderTasks(f.turn(20))).toBe(true);
    expect(f.taskIds().at(-1)).toBe(callback);
    expect(f.taskIds()[0]).toBe(f.turn(20));
    expect(f.handle.getTaskMessages(callback)).toHaveLength(1);
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()).toHaveLength(LEAN_TRANSCRIPT_TASK_WINDOW);
    expect(f.taskIds().at(-1)).toBe(callback);

    // Reconnect and paging back keep it once, at its displayed position.
    await f.handle.resync();
    expect(f.taskIds().at(-1)).toBe(callback);
    while (f.handle.state.hasOlderTasks) await f.handle.loadOlderTasks();
    expect(f.taskIds()).toEqual([...Array.from({ length: 60 }, (_, n) => f.turn(n)), callback]);

    // A second callback that is first seen settled is a new turn, not late history.
    f.handle.trimOlderTasks();
    const second = completionCallbackTaskId(
      earlierSource,
      '0199a000-0000-7000-8000-00000000abcd' as SessionID
    );
    f.run(second, { created: false });
    expect(f.taskIds().at(-1)).toBe(second);
    // Late traffic for a trimmed turn is still not re-added above a gap.
    f.emitServiceEvent('tasks', 'patched', makeTask(f.turn(3), TaskStatus.COMPLETED));
    f.emitServiceEvent('messages', 'created', answer(f.turn(3)));
    expect(f.taskIds()).not.toContain(f.turn(3));
    expect(f.handle.state.messagesByTask.has(f.turn(3))).toBe(false);
    f.handle.dispose();
  });

  it('keeps trimmed turns out when a reconnect page reaches below the cursor', async () => {
    const f = await fixture();
    // Mostly callbacks: few kept turns have IDs at or above the history cursor.
    const callbacks = Array.from({ length: 25 }, (_, k) =>
      completionCallbackTaskId(
        `0199a000-0000-7000-8000-${String(k).padStart(12, '0')}` as TaskID,
        SESSION_ID as SessionID
      )
    );
    for (const callback of callbacks) f.run(callback);
    f.runTurns(6); // turns 24 … 29
    expect(f.handle.trimOlderTasks()).toBe(true);
    const trimmed = [...Array.from({ length: 10 }, (_, n) => f.turn(14 + n)), callbacks[0]];
    for (const id of trimmed) expect(f.taskIds()).not.toContain(id);
    await f.handle.resync();
    for (const id of trimmed) expect(f.taskIds()).not.toContain(id);
    expect(f.taskIds()).toHaveLength(LEAN_TRANSCRIPT_TASK_WINDOW);
    expect(f.taskIds().at(-1)).toBe(f.turn(29));
    f.handle.dispose();
  });

  /** A 4-turn Session whose whole history is loaded: the ID cursor is exhausted. */
  async function shortSession() {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    for (let n = 0; n < 4; n++) {
      opts.tasks.push(makeTask(turn(n), TaskStatus.COMPLETED));
      opts.messagesByTask[turn(n)] = [answer(turn(n)) as Message];
    }
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    expect(handle.state.hasOlderTasks).toBe(false);
    /** Callback turns completing while the reader is offline; IDs sort below every turn. */
    const offlineCallbacks = (count: number) => {
      const ids = Array.from({ length: count }, (_, k) =>
        completionCallbackTaskId(
          `0199a000-0000-7000-8000-${String(k).padStart(12, '0')}` as TaskID,
          SESSION_ID as SessionID
        )
      );
      for (const id of ids) {
        expect(id < turn(0)).toBe(true);
        opts.tasks.push(makeTask(id, TaskStatus.COMPLETED));
        opts.messagesByTask[id] = [answer(id) as Message];
      }
      return ids;
    };
    const taskIds = () => handle.state.tasks.map((task): string => task.task_id);
    return { ...mock, opts, handle, offlineCallbacks, taskIds };
  }

  it('reconciles every turn dispatched while offline, even below an exhausted cursor', async () => {
    const f = await shortSession();
    f.fireIo('disconnect');
    const callbacks = f.offlineCallbacks(15);
    f.fireIo('connect');
    await f.handle.ready();
    expect(f.taskIds()).toEqual([...Array.from({ length: 4 }, (_, n) => turn(n)), ...callbacks]);
    for (const id of callbacks) expect(f.handle.getTaskMessages(id)).toHaveLength(1);
    expect(f.handle.state.hasOlderTasks).toBe(false);
    f.handle.dispose();
  });

  it('reconciles offline callbacks even when a fresh Session patch lands before the reconnect resync', async () => {
    const f = await shortSession();
    f.fireIo('disconnect');
    const callbacks = f.offlineCallbacks(15);
    // The reconnect join is acked late; meanwhile realtime delivers the fresh
    // Session row, which already lists the offline callbacks.
    f.opts.deferCreate = true;
    f.fireIo('connect');
    f.emitServiceEvent('sessions', 'patched', {
      session_id: SESSION_ID,
      tasks: f.opts.tasks.map((task) => task.task_id),
    });
    f.opts.deferCreate = false;
    f.releaseCreate();
    await f.handle.ready();
    expect(f.taskIds()).toEqual([...Array.from({ length: 4 }, (_, n) => turn(n)), ...callbacks]);
    expect(f.handle.state.hasOlderTasks).toBe(false);
    f.handle.dispose();
  });

  it('keeps pinned and waiting turns, contiguously, through a reconnect past the window', async () => {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    for (let n = 0; n < 12; n++) {
      opts.tasks.push(makeTask(turn(n), TaskStatus.COMPLETED));
      opts.messagesByTask[turn(n)] = [answer(turn(n)) as Message];
    }
    const widget = {
      ...makeMessage(turn(5), 2),
      type: 'widget_request',
      metadata: { widget: { widget_type: 'env_vars', status: 'pending' } },
    } as unknown as Message;
    opts.messagesByTask[turn(5)].push(widget);
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    expect(handle.state.tasks.map((task) => task.task_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => turn(2 + i))
    );
    const release = handle.retainTaskDetails(turn(3));
    mock.fireIo('disconnect');
    for (let n = 12; n < 52; n++) {
      opts.tasks.push(makeTask(turn(n), TaskStatus.COMPLETED));
      opts.messagesByTask[turn(n)] = [answer(turn(n)) as Message];
    }
    mock.fireIo('connect');
    await handle.ready();
    // From the earliest protected turn to the latest, with nothing missing.
    expect(handle.state.tasks.map((task) => task.task_id)).toEqual(
      Array.from({ length: 49 }, (_, i) => turn(3 + i))
    );
    expect(handle.getTaskMessages(turn(5))).toContainEqual(
      expect.objectContaining({ type: 'widget_request' })
    );
    expect(handle.state.hasOlderTasks).toBe(true);
    // Once released, an ordinary trim brings it back to the window.
    release();
    await Promise.resolve();
    expect(handle.trimOlderTasks()).toBe(true);
    expect(handle.state.tasks.map((task) => task.task_id)).toEqual(
      Array.from({ length: 49 }, (_, i) => turn(3 + i)).filter((id) => id >= turn(5))
    );
    handle.dispose();
  });

  it('loads the newest window after more offline turns than it holds, the rest via older history', async () => {
    const f = await shortSession();
    f.fireIo('disconnect');
    const callbacks = f.offlineCallbacks(LEAN_TRANSCRIPT_TASK_WINDOW + 7);
    f.fireIo('connect');
    await f.handle.ready();
    // Never a gap above the newest window: earlier turns become older history.
    expect(f.taskIds()).toEqual(callbacks.slice(-LEAN_TRANSCRIPT_TASK_WINDOW));
    expect(f.handle.state.hasOlderTasks).toBe(true);
    // Older history pages back in display order, then reports it is exhausted.
    await f.handle.loadOlderTasks();
    expect(f.taskIds()).toEqual([turn(1), turn(2), turn(3), ...callbacks]);
    expect(f.handle.state.hasOlderTasks).toBe(true);
    // Late traffic for still-unloaded history is not placed above the transcript.
    f.emitServiceEvent('tasks', 'patched', makeTask(turn(0), TaskStatus.COMPLETED));
    expect(f.taskIds()).not.toContain(turn(0));
    await f.handle.loadOlderTasks();
    expect(f.taskIds()).toEqual([...Array.from({ length: 4 }, (_, n) => turn(n)), ...callbacks]);
    expect(f.handle.state.hasOlderTasks).toBe(false);
    // A later trim still follows display order.
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()).toEqual(callbacks.slice(-LEAN_TRANSCRIPT_TASK_WINDOW));
    await f.handle.resync();
    expect(f.taskIds()).toEqual(callbacks.slice(-LEAN_TRANSCRIPT_TASK_WINDOW));
    while (f.handle.state.hasOlderTasks) await f.handle.loadOlderTasks();
    expect(f.taskIds()).toEqual([...Array.from({ length: 4 }, (_, n) => turn(n)), ...callbacks]);
    f.handle.dispose();
  });

  it('loads a newest callback on open even when it is not among the highest task IDs', async () => {
    const f = await fixture();
    const callback = completionCallbackTaskId(earlierSource, SESSION_ID as SessionID);
    f.opts.tasks.push(makeTask(callback, TaskStatus.COMPLETED));
    f.opts.messagesByTask[callback] = [answer(callback) as Message];
    const reopened = new ReactiveSessionHandle(f.client, SESSION_ID, { taskHydration: 'lean' });
    await reopened.ready();
    expect(reopened.state.tasks.at(-1)?.task_id).toBe(callback);
    expect(reopened.getTaskMessages(callback)).toHaveLength(1);
    reopened.dispose();
    f.handle.dispose();
  });

  it('keeps a queued prompt that runs last after newer prompts were promoted ahead of it', async () => {
    const f = await fixture();
    const waiting = f.turn(24);
    const queued = { ...makeTask(waiting, TaskStatus.QUEUED), queue_position: 1 } as Task;
    f.opts.tasks.push(queued);
    f.emitServiceEvent('tasks', 'queued', queued);
    // Newer prompts are reordered ahead of it and run first.
    for (let n = 25; n < 61; n++) f.run(f.turn(n));
    f.run(waiting);
    expect(f.taskIds().at(-1)).toBe(waiting);
    expect(f.handle.trimOlderTasks(f.turn(40))).toBe(true);
    expect(f.taskIds()).toHaveLength(LEAN_TRANSCRIPT_TASK_WINDOW);
    expect(f.taskIds().at(-1)).toBe(waiting);
    await f.handle.resync();
    expect(f.taskIds().at(-1)).toBe(waiting);
    while (f.handle.state.hasOlderTasks) await f.handle.loadOlderTasks();
    expect(f.taskIds()).toEqual([
      ...Array.from({ length: 24 }, (_, n) => f.turn(n)),
      ...Array.from({ length: 36 }, (_, n) => f.turn(25 + n)),
      waiting,
    ]);
    f.handle.dispose();
  });

  it('does not place a settled event that arrives before the first page', async () => {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {}, deferSessionGet: true };
    for (let n = 0; n < 100; n++) {
      opts.tasks.push(makeTask(turn(n), TaskStatus.COMPLETED));
      opts.messagesByTask[turn(n)] = [answer(turn(n)) as Message];
    }
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await vi.waitFor(() => expect(mock.client.service('sessions').get).toHaveBeenCalled());
    mock.emitServiceEvent('tasks', 'patched', makeTask(turn(0), TaskStatus.COMPLETED));
    mock.releaseSessionGet();
    await handle.ready();
    expect(handle.state.tasks.map((task) => task.task_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => turn(90 + i))
    );
    handle.dispose();
  });
  it('reads older history by Session.tasks position in one session-scoped page', async () => {
    const f = await fixture();
    const find = vi.mocked(f.client.service('tasks').find);
    find.mockClear();
    await f.handle.loadOlderTasks();
    expect(find.mock.calls.map(([params]) => params?.query)).toEqual([
      {
        session_id: SESSION_ID,
        task_id: { $in: Array.from({ length: 10 }, (_, n) => f.turn(4 + n)) },
        status: { $ne: TaskStatus.QUEUED },
        $limit: 10,
      },
    ]);
    expect(f.taskIds()).toEqual(Array.from({ length: 20 }, (_, n) => f.turn(4 + n)));
    expect(vi.mocked(f.client.service('tasks').get)).not.toHaveBeenCalled();
    f.handle.dispose();
  });

  it('keeps a scrolled-up reader’s history through a resync after many live turns', async () => {
    const f = await fixture();
    while (f.handle.state.hasOlderTasks) await f.handle.loadOlderTasks();
    // Never trimmed while the reader is away from the bottom.
    f.runTurns(LEAN_TRANSCRIPT_TASK_WINDOW + 10);
    await f.handle.resync();
    expect(f.taskIds()).toEqual(Array.from({ length: 64 }, (_, n) => f.turn(n)));
    expect(f.handle.state.hasOlderTasks).toBe(false);
    f.handle.dispose();
  });

  it('admits a settled turn whose Session.tasks position arrives after its Task events', async () => {
    const f = await fixture();
    f.runTurns(30);
    expect(f.handle.trimOlderTasks()).toBe(true);
    const late = completionCallbackTaskId(earlierSource, SESSION_ID as SessionID);
    f.opts.tasks.push(makeTask(late, TaskStatus.COMPLETED));
    f.opts.messagesByTask[late] = [answer(late) as Message];
    // First seen settled, before the Session patch that lists it.
    f.emitServiceEvent('tasks', 'patched', makeTask(late, TaskStatus.COMPLETED));
    f.emitServiceEvent('messages', 'created', answer(late));
    expect(f.taskIds().at(-1)).toBe(late);
    expect(f.handle.getTaskMessages(late)).toHaveLength(1);
    f.emitServiceEvent('sessions', 'patched', {
      session_id: SESSION_ID,
      tasks: f.opts.tasks.map((task) => task.task_id),
    });
    expect(f.taskIds().at(-1)).toBe(late);
    expect(f.taskIds()).toHaveLength(LEAN_TRANSCRIPT_TASK_WINDOW + 1);
    // Traffic for a turn above the transcript's top is still refused.
    f.emitServiceEvent('tasks', 'patched', makeTask(f.turn(20), TaskStatus.COMPLETED));
    expect(f.taskIds()).not.toContain(f.turn(20));
    await f.handle.resync();
    expect(f.taskIds().at(-1)).toBe(late);
    expect(f.taskIds()).toHaveLength(LEAN_TRANSCRIPT_TASK_WINDOW + 1);
    f.handle.dispose();
  });

  it('pages a legacy Session by task ID, and never trims it, when Session.tasks misses turns', async () => {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    for (let n = 0; n < 45; n++) {
      opts.tasks.push(makeTask(turn(n), TaskStatus.COMPLETED));
      opts.messagesByTask[turn(n)] = [answer(turn(n)) as Message];
    }
    // A pre-atomic append or a whole-array overwrite lost dispatched Tasks.
    opts.sessionTaskIds = opts.tasks.map((task) => task.task_id).filter((_, n) => n % 7 !== 3);
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    expect(Reflect.get(handle, 'leanOrder')).toBe('legacy');
    while (handle.state.hasOlderTasks) await handle.loadOlderTasks();
    expect(new Set(handle.state.tasks.map((task) => task.task_id))).toEqual(
      new Set(opts.tasks.map((task) => task.task_id))
    );
    expect(handle.trimOlderTasks()).toBe(false);
    // No positional read: only the bounded membership counts use `$in`.
    const find = vi.mocked(mock.client.service('tasks').find);
    expect(
      find.mock.calls.filter(
        ([params]) => '$in' in Object(params?.query?.task_id) && params?.query?.$limit !== 0
      )
    ).toEqual([]);
    handle.dispose();

    // A Task created but never run has no position by design: the daemon never
    // lists it. Still display order, and it is not a placed turn.
    opts.tasks.push(makeTask(turn(45), TaskStatus.CREATED));
    opts.sessionTaskIds = opts.tasks.slice(0, 45).map((task) => task.task_id);
    expect(opts.sessionTaskIds).not.toContain(turn(45));
    const complete = new ReactiveSessionHandle(createMockClient(opts).client, SESSION_ID, {
      taskHydration: 'lean',
    });
    await complete.ready();
    expect(Reflect.get(complete, 'leanOrder')).toBe('display');
    expect(complete.state.tasks.map((task) => task.task_id)).toEqual(
      Array.from({ length: 10 }, (_, n) => turn(35 + n))
    );
    complete.dispose();
  });

  it('fails closed to task-ID paging when a dispatch lands between the task page and the Session read', async () => {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {}, deferSessionGet: true };
    const add = (n: number) => {
      opts.tasks.push(makeTask(turn(n), TaskStatus.COMPLETED));
      opts.messagesByTask[turn(n)] = [answer(turn(n)) as Message];
    };
    for (let n = 0; n < 40; n++) add(n);
    // A legacy row lost turn 5.
    opts.sessionTaskIds = opts.tasks.map((task) => task.task_id).filter((id) => id !== turn(5));
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    // The newest task page (40 nonqueued Tasks) is read first …
    await vi.waitFor(() => expect(mock.client.service('tasks').find).toHaveBeenCalled());
    // … then another prompt dispatches before the Session row is read: equal counts.
    add(40);
    opts.sessionTaskIds = [...opts.sessionTaskIds, turn(40)];
    mock.emitServiceEvent('tasks', 'patched', makeTask(turn(40), TaskStatus.RUNNING));
    mock.releaseSessionGet();
    await handle.ready();
    expect(Reflect.get(handle, 'leanOrder')).toBe('legacy');
    while (handle.state.hasOlderTasks) await handle.loadOlderTasks();
    expect(handle.state.tasks.map((task) => task.task_id)).toContain(turn(5));
    expect(handle.state.tasks).toHaveLength(41);
    expect(handle.trimOlderTasks()).toBe(false);
    handle.dispose();
  });

  it('proves Session.tasks lists every turn by membership, not by matching counts', async () => {
    const legacyWith = async (listed: (ids: string[]) => string[], newest: TaskStatus) => {
      const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
      for (let n = 0; n < 40; n++) {
        opts.tasks.push(makeTask(turn(n), n === 39 ? newest : TaskStatus.COMPLETED));
        opts.messagesByTask[turn(n)] = [answer(turn(n)) as Message];
      }
      opts.sessionTaskIds = listed(opts.tasks.map((task) => task.task_id));
      const handle = new ReactiveSessionHandle(createMockClient(opts).client, SESSION_ID, {
        taskHydration: 'lean',
      });
      await handle.ready();
      const order = Reflect.get(handle, 'leanOrder');
      handle.dispose();
      return order;
    };
    // Another Session's Task stands in for the lost turn 5: equal counts.
    const foreign = completionCallbackTaskId(earlierSource, SESSION_ID as SessionID);
    expect(
      await legacyWith(
        (ids) => ids.map((id) => (id === turn(5) ? foreign : id)),
        TaskStatus.COMPLETED
      )
    ).toBe('legacy');
    // A running turn missing from the list was dispatched; only CREATED is pending.
    expect(await legacyWith((ids) => ids.filter((id) => id !== turn(39)), TaskStatus.RUNNING)).toBe(
      'legacy'
    );
    expect(await legacyWith((ids) => ids, TaskStatus.RUNNING)).toBe('display');
    // A duplicated entry shifts every later position.
    expect(
      await legacyWith(
        (ids) => [...ids.slice(0, 20), ids[19], ...ids.slice(20)],
        TaskStatus.COMPLETED
      )
    ).toBe('legacy');
  });

  it('keeps a turn that settles, with its Session patch, while the first page hydrates', async () => {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    const add = (n: number) => {
      opts.tasks.push(makeTask(turn(n), TaskStatus.COMPLETED));
      opts.messagesByTask[turn(n)] = [answer(turn(n)) as Message];
    };
    for (let n = 0; n < 12; n++) add(n);
    opts.deferTaskMessageFetch = turn(11);
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await vi.waitFor(() =>
      expect(JSON.stringify(mock.messageFindAll.mock.calls)).toContain(turn(11))
    );
    // Turn 12 dispatches and settles while the first page's messages load.
    add(12);
    mock.emitServiceEvent('tasks', 'patched', makeTask(turn(12), TaskStatus.COMPLETED));
    mock.emitServiceEvent('sessions', 'patched', {
      session_id: SESSION_ID,
      tasks: opts.tasks.map((task) => task.task_id),
    });
    mock.emitServiceEvent('messages', 'created', answer(turn(12)));
    opts.deferTaskMessageFetch = undefined;
    mock.releaseMessageFetch();
    await handle.ready();
    expect(handle.state.tasks.map((task) => task.task_id)).toEqual(
      Array.from({ length: 10 }, (_, n) => turn(3 + n))
    );
    expect(handle.getTaskMessages(turn(12))).toHaveLength(1);
    while (handle.state.hasOlderTasks) await handle.loadOlderTasks();
    expect(handle.state.tasks).toHaveLength(13);
    handle.dispose();
  });

  /** 40 turns; the reader opens on turns 30 … 39 (start 30, reconciled 40). */
  async function fortyTurns() {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    const add = (n: number) => {
      opts.tasks.push(makeTask(turn(n), TaskStatus.COMPLETED));
      opts.messagesByTask[turn(n)] = [answer(turn(n)) as Message];
    };
    for (let n = 0; n < 40; n++) add(n);
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    const taskIds = () => handle.state.tasks.map((task): string => task.task_id);
    expect(taskIds()).toEqual(Array.from({ length: 10 }, (_, n) => turn(30 + n)));
    return { ...mock, opts, add, handle, taskIds };
  }
  const replaced = Array.from({ length: 20 }, (_, n) => turn(20 + n));

  it('falls back to task-ID paging when Session.tasks was replaced while offline', async () => {
    const f = await fortyTurns();
    f.fireIo('disconnect');
    // A caller replaced the list (older daemons allowed it), then 5 turns dispatched.
    for (let n = 40; n < 45; n++) f.add(n);
    f.opts.sessionTaskIds = [...replaced, ...Array.from({ length: 5 }, (_, n) => turn(40 + n))];
    f.fireIo('connect');
    await f.handle.ready();
    // Nothing shown is lost, the new turns arrive, and history stays reachable.
    expect(f.taskIds()).toEqual(
      expect.arrayContaining(Array.from({ length: 15 }, (_, n) => turn(30 + n)))
    );
    expect(f.handle.state.hasOlderTasks).toBe(true);
    while (f.handle.state.hasOlderTasks) await f.handle.loadOlderTasks();
    expect(new Set(f.taskIds())).toEqual(new Set(f.opts.tasks.map((task) => task.task_id)));
    expect(f.handle.trimOlderTasks()).toBe(false);
    f.handle.dispose();
  });

  it('reopens older history when it falls back from a fully loaded transcript', async () => {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    const add = (n: number) => {
      opts.tasks.push(makeTask(turn(n), TaskStatus.COMPLETED));
      opts.messagesByTask[turn(n)] = [answer(turn(n)) as Message];
    };
    for (let n = 0; n < 8; n++) add(n);
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    expect(handle.state.hasOlderTasks).toBe(false);
    mock.fireIo('disconnect');
    // The list was replaced, then 15 turns dispatched: more than one ID page.
    for (let n = 8; n < 23; n++) add(n);
    opts.sessionTaskIds = opts.tasks.slice(4).map((task) => task.task_id);
    mock.fireIo('connect');
    await handle.ready();
    expect(handle.state.hasOlderTasks).toBe(true);
    while (handle.state.hasOlderTasks) await handle.loadOlderTasks();
    expect(new Set(handle.state.tasks.map((task) => task.task_id))).toEqual(
      new Set(opts.tasks.map((task) => task.task_id))
    );
    handle.dispose();
  });

  it('falls back to task-ID paging when a live Session patch replaces Session.tasks', async () => {
    const f = await fortyTurns();
    f.opts.sessionTaskIds = replaced;
    f.emitServiceEvent('sessions', 'patched', { session_id: SESSION_ID, tasks: replaced });
    expect(Reflect.get(f.handle, 'leanOrder')).toBe('legacy');
    await f.handle.resync();
    expect(f.taskIds()).toEqual(
      expect.arrayContaining(Array.from({ length: 10 }, (_, n) => turn(30 + n)))
    );
    expect(f.handle.state.hasOlderTasks).toBe(true);
    while (f.handle.state.hasOlderTasks) await f.handle.loadOlderTasks();
    expect(f.taskIds()).toHaveLength(40);
    f.handle.dispose();
  });
  it('plans a reconnect past the window again when a turn it would drop is pinned meanwhile', async () => {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    const add = (n: number) => {
      opts.tasks.push(makeTask(turn(n), TaskStatus.COMPLETED));
      opts.messagesByTask[turn(n)] = [answer(turn(n)) as Message];
    };
    for (let n = 0; n < 12; n++) add(n);
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    mock.fireIo('disconnect');
    for (let n = 12; n < 52; n++) add(n);
    opts.deferTaskMessageFetch = turn(51);
    mock.fireIo('connect');
    await vi.waitFor(() =>
      expect(JSON.stringify(mock.messageFindAll.mock.calls)).toContain(turn(51))
    );
    // The reader expands an old turn while the rebased read is in flight.
    const release = handle.retainTaskDetails(turn(3));
    opts.deferTaskMessageFetch = undefined;
    mock.releaseMessageFetch();
    await handle.ready();
    expect(handle.state.tasks.map((task) => task.task_id)).toEqual(
      Array.from({ length: 49 }, (_, i) => turn(3 + i))
    );
    release();
    handle.dispose();
  });

  it('reads no trimmed turn on reconnect, even one dispatched after the last history read', async () => {
    const f = await fixture();
    f.runTurns(36);
    expect(f.handle.trimOlderTasks()).toBe(true);
    expect(f.taskIds()[0]).toBe(f.turn(30));
    const find = vi.mocked(f.client.service('tasks').find);
    find.mockClear();
    await f.handle.resync();
    const read = find.mock.calls.flatMap(
      ([params]) => (params?.query?.task_id as { $in?: string[] } | undefined)?.$in ?? []
    );
    expect(read).toEqual(f.taskIds());
    expect(f.taskIds()).toEqual(Array.from({ length: 30 }, (_, n) => f.turn(30 + n)));
    f.handle.dispose();
  });
});

describe('lean session context-window projection', () => {
  const turn = (n: number) => `0199d000-0000-7000-8000-${String(n).padStart(12, '0')}` as TaskID;
  const withSnapshot = (task: Task, used: number) =>
    ({
      ...task,
      model: 'synthetic-model',
      duration_ms: 1200,
      computed_context_window: used,
      normalized_sdk_response: {
        tokenUsage: { inputTokens: used, outputTokens: 1, totalTokens: used + 1 },
        contextWindowLimit: 200_000,
      },
      raw_sdk_response: { canary: 'RAW_SDK_CANARY' },
    }) as Task;

  it('keeps the latest snapshot after its turn is trimmed, and never regresses to an older one', async () => {
    const opts: MockClientOptions = { tasks: [], messagesByTask: {} };
    for (let n = 0; n < 10; n++)
      opts.tasks.push(withSnapshot(makeTask(turn(n), TaskStatus.COMPLETED), 1000 + n));
    const mock = createMockClient(opts);
    const handle = new ReactiveSessionHandle(mock.client, SESSION_ID, { taskHydration: 'lean' });
    await handle.ready();
    expect(handle.state.latestContextWindow).toMatchObject({
      task_id: turn(9),
      computed_context_window: 1009,
      model: 'synthetic-model',
      duration_ms: 1200,
    });
    expect(JSON.stringify(handle.state.latestContextWindow)).not.toContain('RAW_SDK_CANARY');
    // Forty turns that report no snapshot push turn 9 out of the transcript.
    for (let n = 10; n < 50; n++) {
      const task = makeTask(turn(n), TaskStatus.COMPLETED);
      opts.tasks.push(task);
      mock.emitServiceEvent('tasks', 'created', makeTask(turn(n), TaskStatus.RUNNING));
      mock.emitServiceEvent('sessions', 'patched', {
        session_id: SESSION_ID,
        tasks: opts.tasks.map((row) => row.task_id),
      });
      mock.emitServiceEvent('tasks', 'patched', task);
    }
    expect(handle.trimOlderTasks()).toBe(true);
    expect(handle.getTask(turn(9))).toBeUndefined();
    expect(handle.state.latestContextWindow?.task_id).toBe(turn(9));
    // Paging back an older snapshot does not replace the newer one.
    while (handle.state.hasOlderTasks) await handle.loadOlderTasks();
    expect(handle.state.latestContextWindow?.task_id).toBe(turn(9));
    // A newer reported snapshot replaces it.
    const latest = withSnapshot(makeTask(turn(49), TaskStatus.COMPLETED), 4242);
    mock.emitServiceEvent('tasks', 'patched', latest);
    expect(handle.state.latestContextWindow).toMatchObject({
      task_id: turn(49),
      computed_context_window: 4242,
    });
    // Another Session's handle starts without it; removal and disposal clear it.
    const other = new ReactiveSessionHandle(
      createMockClient({ tasks: [], messagesByTask: {} }).client,
      SESSION_ID,
      { taskHydration: 'lean' }
    );
    await other.ready();
    expect(other.state.latestContextWindow).toBeUndefined();
    other.dispose();
    mock.emitServiceEvent('sessions', 'removed', { session_id: SESSION_ID });
    expect(handle.state.latestContextWindow).toBeUndefined();
    handle.dispose();
    expect(handle.state.latestContextWindow).toBeUndefined();
  });
});
