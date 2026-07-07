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
  /** When true, `session-streams.create` blocks until releaseCreate() is called. */
  deferCreate?: boolean;
}

function createMockClient(opts: MockClientOptions) {
  // Records the relative order of subscribe vs. hydrate vs. unsubscribe so
  // tests can assert the subscribe-before-hydrate ordering and dispose races.
  const order: string[] = [];

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
    removeListener: vi.fn(),
  });
  const emitServiceEvent = (svc: string, event: string, payload: unknown) => {
    for (const handler of serviceHandlers[svc]?.[event] ?? []) handler(payload);
  };

  let releaseCreate: (() => void) | null = null;
  const sessionStreams = {
    create: vi.fn(async () => {
      order.push('subscribe');
      if (opts.deferCreate) {
        await new Promise<void>((resolve) => {
          releaseCreate = resolve;
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
        return { session_id: SESSION_ID } as Session;
      }),
      ...listener('sessions'),
    },
    tasks: { findAll: vi.fn(async () => opts.tasks), ...listener('tasks') },
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
      off: vi.fn(),
    },
    service: vi.fn((name: string) =>
      name.includes('/tasks/queue') ? queueService : services[name]
    ),
  } as unknown as AgorClient;

  const fireIo = (event: string) => {
    for (const handler of ioHandlers[event] ?? []) handler();
  };

  const releaseCreateFn = () => releaseCreate?.();

  return {
    client,
    messageFindAll,
    sessionStreams,
    fireIo,
    emitServiceEvent,
    order,
    releaseCreate: releaseCreateFn,
  };
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

  it('re-subscribes after a socket reconnect (new connection has no room membership)', async () => {
    const { client, sessionStreams, fireIo } = createMockClient(opts);
    const handle = new ReactiveSessionHandle(client, SESSION_ID, { taskHydration: 'none' });
    await handle.ready();
    expect(sessionStreams.create).toHaveBeenCalledTimes(1);

    fireIo('connect');
    await handle.ready();

    expect(sessionStreams.create).toHaveBeenCalledTimes(2);
    handle.dispose();
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
});
