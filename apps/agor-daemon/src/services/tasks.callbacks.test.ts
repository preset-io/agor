import { type Session, type Task, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

const childSessionId = '018f0000-0000-7000-8000-000000000101';
const parentSessionId = '018f0000-0000-7000-8000-000000000102';
const taskId = '018f0000-0000-7000-8000-000000000201';
const callbackTaskId = '018f0000-0000-7000-8000-000000000301';
const userId = '018f0000-0000-7000-8000-000000000401';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: taskId,
    session_id: childSessionId,
    created_by: userId,
    full_prompt: 'investigate duplicate callbacks',
    status: TaskStatus.RUNNING,
    message_range: {
      start_index: 0,
      end_index: 2,
      start_timestamp: '2026-01-01T00:00:00.000Z',
    },
    tool_use_count: 3,
    git_state: {
      ref_at_start: 'main',
      sha_at_start: 'abc123',
    },
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: childSessionId,
    branch_id: undefined,
    created_by: userId,
    agentic_tool: 'claude-code',
    status: 'running',
    title: 'Child session',
    description: 'Child session',
    tasks: [taskId],
    ready_for_prompt: false,
    archived: false,
    genealogy: {
      parent_session_id: parentSessionId,
      children: [],
    },
    callback_config: {
      enabled: true,
      callback_session_id: parentSessionId,
      callback_created_by: userId,
      callback_mode: 'once',
      include_last_message: true,
    },
    git_state: {},
    contextFiles: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function makeService(
  options: {
    task?: Partial<Task>;
    childSession?: Partial<Session>;
    parentSession?: Partial<Session>;
  } = {}
) {
  const initialTask = makeTask(options.task);
  const tasksById = new Map<string, Task>([[initialTask.task_id, initialTask]]);
  const childSession = makeSession(options.childSession);
  const parentSession = makeSession({
    session_id: parentSessionId,
    status: 'idle',
    title: 'Parent session',
    tasks: [],
    ready_for_prompt: true,
    genealogy: { children: [childSessionId] },
    callback_config: undefined,
    ...options.parentSession,
  });

  const repository = {
    findById: vi.fn(async (id: string) => tasksById.get(id) ?? null),
    update: vi.fn(async (id: string, updates: Partial<Task>) => {
      const current = tasksById.get(id) ?? makeTask({ task_id: id as Task['task_id'] });
      const updated = { ...current, ...updates } as Task;
      tasksById.set(id, updated);
      return updated;
    }),
    create: vi.fn(),
    findAll: vi.fn(async () => [...tasksById.values()]),
    delete: vi.fn(),
  };

  const callbackTask = makeTask({
    task_id: callbackTaskId,
    session_id: parentSessionId,
    status: TaskStatus.QUEUED,
  });
  const createPending = vi.fn(async (data: Partial<Task>) => ({ ...callbackTask, ...data }));

  const sessionsPatch = vi.fn(async (id: string, updates: Partial<Session>) => {
    const target = id === parentSessionId ? parentSession : childSession;
    Object.assign(target, updates);
    return { ...target };
  });
  const triggerQueueProcessing = vi.fn(async () => undefined);
  const messagesFind = vi.fn(async () => [
    {
      role: 'assistant',
      index: 2,
      content: [{ type: 'text', text: 'Final child result' }],
    },
  ]);

  const service = Object.create(TasksService.prototype) as TasksService & {
    repository: typeof repository;
    taskRepo: typeof repository & { createPending: typeof createPending };
    id: string;
    emit: ReturnType<typeof vi.fn>;
    app: { service: ReturnType<typeof vi.fn> };
    completionCallbackDispatches: Map<string, Promise<unknown>>;
  };
  service.repository = repository;
  service.taskRepo = { ...repository, createPending };
  service.id = 'task_id';
  service.emit = vi.fn();
  service.completionCallbackDispatches = new Map();
  service.app = {
    service: vi.fn((name: string) => {
      if (name === 'sessions') {
        return {
          get: vi.fn(async (id: string) => (id === parentSessionId ? parentSession : childSession)),
          patch: sessionsPatch,
          triggerQueueProcessing,
        };
      }
      if (name === 'messages') return { find: messagesFind };
      if (name === 'branches') return { get: vi.fn() };
      throw new Error(`unexpected service ${name}`);
    }),
  };

  return {
    service,
    repository,
    createPending,
    sessionsPatch,
    triggerQueueProcessing,
    messagesFind,
    getStoredTask: (id = taskId) => tasksById.get(id),
    childSession,
  };
}

describe('TasksService completion callbacks', () => {
  it('queues exactly one templated callback with last-message metadata for a completed subsession task', async () => {
    const {
      service,
      createPending,
      sessionsPatch,
      triggerQueueProcessing,
      messagesFind,
      getStoredTask,
    } = makeService();

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: parentSessionId,
        status: TaskStatus.QUEUED,
        metadata: expect.objectContaining({
          is_agor_callback: true,
          source: 'agor',
          child_session_id: childSessionId,
          child_task_id: taskId,
          queued_by_user_id: userId,
        }),
      })
    );
    const callbackPrompt = createPending.mock.calls[0][0].full_prompt as string;
    expect(callbackPrompt).toContain('[Agor] Child session');
    expect(callbackPrompt).toContain('**Result:**');
    expect(callbackPrompt).toContain('Final child result');
    expect(callbackPrompt).toContain(taskId);
    expect(callbackPrompt).not.toContain('## Original Prompt');
    expect(callbackPrompt).not.toContain('investigate duplicate callbacks');
    expect(messagesFind).toHaveBeenCalledTimes(1);
    expect(triggerQueueProcessing).toHaveBeenCalledWith(parentSessionId, {});
    expect(sessionsPatch).toHaveBeenCalledWith(
      childSessionId,
      expect.objectContaining({ callback_config: expect.objectContaining({ enabled: false }) })
    );
    expect(getStoredTask().metadata?.callback_dispatches).toEqual([
      expect.objectContaining({
        event: 'session_completion',
        target_session_id: parentSessionId,
        queued_task_id: callbackTaskId,
      }),
    ]);
  });

  it('includeOriginalPrompt=false queues one templated callback without an original prompt section', async () => {
    const { service, createPending } = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'once',
          include_original_prompt: false,
          include_last_message: true,
        },
      },
      task: {
        full_prompt: 'original prompt should not appear when disabled',
      },
    });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    const callbackPrompt = createPending.mock.calls[0][0].full_prompt as string;
    expect(callbackPrompt).toContain('[Agor] Child session');
    expect(callbackPrompt).toContain('**Result:**');
    expect(callbackPrompt).toContain('Final child result');
    expect(callbackPrompt).not.toContain('## Original Prompt');
    expect(callbackPrompt).not.toContain('original prompt should not appear when disabled');
  });

  it('includeOriginalPrompt=true queues one templated callback with an explicit original prompt section', async () => {
    const originalPrompt = [
      'Investigate callback duplication.',
      'Keep this second line in the callback body.',
    ].join('\n');
    const { service, createPending } = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'once',
          include_original_prompt: true,
          include_last_message: true,
        },
      },
      task: { full_prompt: originalPrompt },
    });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    const callbackPrompt = createPending.mock.calls[0][0].full_prompt as string;
    expect(callbackPrompt).toContain('[Agor] Child session');
    expect(callbackPrompt).toContain('## Original Prompt');
    expect(callbackPrompt).toContain(originalPrompt);
    expect(callbackPrompt).toContain('**Result:**');
    expect(callbackPrompt).toContain('Final child result');
  });

  it('uses the same single templated patch completion path for sessions.create callbacks without spawn genealogy', async () => {
    const { service, createPending, sessionsPatch } = makeService({
      childSession: {
        genealogy: { children: [] },
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'once',
          include_original_prompt: true,
          include_last_message: true,
        },
      },
      task: { full_prompt: 'remote session initial prompt' },
    });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    const callbackPrompt = createPending.mock.calls[0][0].full_prompt as string;
    expect(callbackPrompt).toContain('[Agor] Child session');
    expect(callbackPrompt).toContain('## Original Prompt');
    expect(callbackPrompt).toContain('remote session initial prompt');
    expect(callbackPrompt).toContain('Final child result');
    expect(sessionsPatch).toHaveBeenCalledWith(
      childSessionId,
      expect.objectContaining({ callback_config: expect.objectContaining({ enabled: false }) })
    );
  });

  it('dedupes concurrent completion callback dispatch for the same task target', async () => {
    const { service, createPending, childSession } = makeService();
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await Promise.all([
      (service as any).dispatchCompletionCallbacks(completedTask, childSession, {}),
      (service as any).dispatchCompletionCallbacks(completedTask, childSession, {}),
    ]);

    expect(createPending).toHaveBeenCalledTimes(1);
  });

  it('still triggers target queue processing if dispatch marker persistence fails after queueing', async () => {
    const { service, repository, createPending, triggerQueueProcessing } = makeService();
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });
    const originalUpdate = repository.update.getMockImplementation();
    repository.update.mockImplementation(async (id: string, updates: Partial<Task>) => {
      if (updates.metadata?.callback_dispatches) {
        throw new Error('metadata write failed');
      }
      if (!originalUpdate) throw new Error('missing original update');
      return originalUpdate(id, updates);
    });

    await (service as any).dispatchCompletionCallbacks(completedTask, makeSession(), {});

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(triggerQueueProcessing).toHaveBeenCalledWith(parentSessionId, {});
  });

  it('runs once-mode cleanup only for the caller that actually attempts dispatch', async () => {
    const { service, createPending, sessionsPatch, childSession } = makeService();
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await Promise.all([
      (service as any).dispatchCompletionCallbacks(completedTask, childSession, {}),
      (service as any).dispatchCompletionCallbacks(completedTask, childSession, {}),
    ]);

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(
      sessionsPatch.mock.calls.filter(
        ([id, updates]) =>
          id === childSessionId && (updates as Partial<Session>).callback_config?.enabled === false
      )
    ).toHaveLength(1);
  });

  it("callbackMode='once' prevents a repeat callback after the first firing", async () => {
    const { service, createPending, childSession } = makeService();
    const firstTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await (service as any).dispatchCompletionCallbacks(firstTask, childSession, {});

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(childSession.callback_config?.enabled).toBe(false);

    createPending.mockClear();

    const secondTask = makeTask({
      task_id: '018f0000-0000-7000-8000-000000000202' as Task['task_id'],
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:01:05.000Z',
      metadata: undefined,
    });

    await (service as any).dispatchCompletionCallbacks(secondTask, childSession, {});

    expect(createPending).not.toHaveBeenCalled();
  });

  it("callbackMode='once' does not disable when callback queueing fails before firing", async () => {
    const { service, createPending, sessionsPatch, childSession } = makeService();
    createPending.mockRejectedValueOnce(new Error('queue failed'));
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await (service as any).dispatchCompletionCallbacks(completedTask, childSession, {});

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(
      sessionsPatch.mock.calls.filter(
        ([id, updates]) =>
          id === childSessionId && (updates as Partial<Session>).callback_config?.enabled === false
      )
    ).toHaveLength(0);
    expect(childSession.callback_config?.enabled).toBe(true);
  });

  it('does not queue or trigger when callback dispatch metadata already exists', async () => {
    const { service, createPending, triggerQueueProcessing, childSession } = makeService({
      task: {
        metadata: {
          callback_dispatches: [
            {
              event: 'session_completion',
              target_session_id: parentSessionId,
              queued_task_id: callbackTaskId,
              dispatched_at: '2026-01-01T00:00:06.000Z',
            },
          ],
        },
      },
    });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
      metadata: {
        callback_dispatches: [
          {
            event: 'session_completion',
            target_session_id: parentSessionId,
            queued_task_id: callbackTaskId,
            dispatched_at: '2026-01-01T00:00:06.000Z',
          },
        ],
      },
    });

    await (service as any).dispatchCompletionCallbacks(completedTask, childSession, {});

    expect(createPending).not.toHaveBeenCalled();
    expect(triggerQueueProcessing).not.toHaveBeenCalledWith(parentSessionId, {});
  });

  it('does not queue or trigger target processing when callbacks are disabled', async () => {
    const { service, createPending, triggerQueueProcessing, childSession } = makeService({
      childSession: {
        callback_config: {
          enabled: false,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'once',
        },
      },
    });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await (service as any).dispatchCompletionCallbacks(completedTask, childSession, {});

    expect(createPending).not.toHaveBeenCalled();
    expect(triggerQueueProcessing).not.toHaveBeenCalledWith(parentSessionId, {});
  });

  it('uses legacy genealogy parent fallback when callback_session_id is absent', async () => {
    const { service, createPending, childSession } = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_created_by: userId,
          callback_mode: 'persistent',
        },
      },
    });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await (service as any).dispatchCompletionCallbacks(completedTask, childSession, {});

    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: parentSessionId })
    );
  });
});
