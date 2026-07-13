import type { Application } from '@agor/core/feathers';
import type { Message, Params, Task } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { ensureInitialUserMessage } from './ensure-initial-user-message';

/**
 * Test double for a task carrying a user prompt. Only the fields
 * `ensureInitialUserMessage` reads matter.
 */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'task-1',
    session_id: 'session-1',
    full_prompt: 'why did the agent not start?',
    metadata: undefined,
    ...overrides,
  } as unknown as Task;
}

interface MakeAppOptions {
  existingUserMessages?: Message[];
  findThrows?: Error;
  createThrows?: Error;
}

function makeApp(opts: MakeAppOptions = {}) {
  const find = vi.fn(async () => {
    if (opts.findThrows) throw opts.findThrows;
    return opts.existingUserMessages ?? [];
  });
  const create = vi.fn(async (message: Message) => {
    if (opts.createThrows) throw opts.createThrows;
    return message;
  });
  const app = {
    service: vi.fn((name: string) => {
      if (name === 'messages') return { find, create };
      throw new Error(`unexpected service: ${name}`);
    }),
  } as unknown as Application;
  return { app, find, create };
}

const params: Params = { user: { user_id: 'u1' } } as unknown as Params;
const db = {} as never;

describe('ensureInitialUserMessage', () => {
  it('writes the user-message row when none exists yet', async () => {
    const { app, create } = makeApp({ existingUserMessages: [] });
    const wrote = await ensureInitialUserMessage({
      app,
      db,
      task: makeTask(),
      timestamp: '2026-07-13T00:00:00.000Z',
      params,
      countMessagesForSession: async () => 0,
    });
    expect(wrote).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const [written] = create.mock.calls[0] as unknown as [Message, Params];
    expect(written.role).toBe(MessageRole.USER);
    expect(written.content).toBe('why did the agent not start?');
    expect(written.task_id).toBe('task-1');
    expect(written.index).toBe(0);
  });

  it('skips the write when a user-role row already exists for the task', async () => {
    // Regression for the executor-failure path (invalid preset kills the
    // agent process at startup): if the pre-spawn write already landed, the
    // error-path safety-net call must NOT double-insert.
    const existing: Message = {
      message_id: 'm1',
      session_id: 'session-1',
      task_id: 'task-1',
      role: MessageRole.USER,
      type: 'user',
      index: 0,
      timestamp: '2026-07-13T00:00:00.000Z',
      content_preview: '',
      content: 'why did the agent not start?',
    };
    const { app, create } = makeApp({ existingUserMessages: [existing] });
    const wrote = await ensureInitialUserMessage({
      app,
      db,
      task: makeTask(),
      timestamp: '2026-07-13T00:00:00.000Z',
      params,
      countMessagesForSession: async () => 1,
    });
    expect(wrote).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('recomputes the row index from countMessages, not a caller-scoped constant', async () => {
    // The executor may write some rows before dying (system_status, etc.).
    // Using a stale `messageStartIndex` would collide or leave a gap; we
    // must anchor on the live count.
    const { app, create } = makeApp({ existingUserMessages: [] });
    await ensureInitialUserMessage({
      app,
      db,
      task: makeTask(),
      timestamp: '2026-07-13T00:00:00.000Z',
      params,
      countMessagesForSession: async () => 3,
    });
    const [written] = create.mock.calls[0] as unknown as [Message, Params];
    expect(written.index).toBe(3);
  });

  it('surfaces task.metadata.source and callback flags on the written row', async () => {
    const { app, create } = makeApp({ existingUserMessages: [] });
    await ensureInitialUserMessage({
      app,
      db,
      task: makeTask({
        metadata: {
          source: 'gateway',
          is_agor_callback: true,
        } as Task['metadata'],
      }),
      timestamp: '2026-07-13T00:00:00.000Z',
      params,
      countMessagesForSession: async () => 0,
    });
    const [written] = create.mock.calls[0] as unknown as [Message, Params];
    // Callback rows are typed 'system' so the UI applies its callback
    // styling, but role stays 'user'.
    expect(written.type).toBe('system');
    expect(written.role).toBe(MessageRole.USER);
    expect(written.metadata?.source).toBe('gateway');
    expect(written.metadata?.is_agor_callback).toBe(true);
  });

  it('never throws: a failed create logs and returns false', async () => {
    // The executor-failure caller is inside its OWN error-handler catch;
    // throwing here would abort the subsequent system-error-message write
    // and leave the user with no signal at all.
    const { app } = makeApp({
      existingUserMessages: [],
      createThrows: new Error('rbac denied'),
    });
    const wrote = await ensureInitialUserMessage({
      app,
      db,
      task: makeTask(),
      timestamp: '2026-07-13T00:00:00.000Z',
      params,
      countMessagesForSession: async () => 0,
    });
    expect(wrote).toBe(false);
  });

  it('never throws: a failed find logs and returns false', async () => {
    const { app, create } = makeApp({
      findThrows: new Error('db down'),
    });
    const wrote = await ensureInitialUserMessage({
      app,
      db,
      task: makeTask(),
      timestamp: '2026-07-13T00:00:00.000Z',
      params,
      countMessagesForSession: async () => 0,
    });
    expect(wrote).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('handles a paginated find response shape', async () => {
    // Feathers services with pagination configured return {data} even when
    // the caller asks for `paginate: false`; the helper must not misread
    // that as "no existing row".
    const existing: Message = {
      message_id: 'm1',
      session_id: 'session-1',
      task_id: 'task-1',
      role: MessageRole.USER,
      type: 'user',
      index: 0,
      timestamp: '2026-07-13T00:00:00.000Z',
      content_preview: '',
      content: 'x',
    };
    const find = vi.fn(async () => ({ data: [existing], total: 1, limit: 1, skip: 0 }));
    const create = vi.fn();
    const app = {
      service: vi.fn(() => ({ find, create })),
    } as unknown as Application;

    const wrote = await ensureInitialUserMessage({
      app,
      db,
      task: makeTask(),
      timestamp: '2026-07-13T00:00:00.000Z',
      params,
      countMessagesForSession: async () => 1,
    });
    expect(wrote).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
