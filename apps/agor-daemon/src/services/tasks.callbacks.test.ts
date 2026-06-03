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

function makeService() {
  let storedTask = makeTask();
  const childSession = makeSession();
  const parentSession = makeSession({
    session_id: parentSessionId,
    status: 'idle',
    title: 'Parent session',
    tasks: [],
    ready_for_prompt: true,
    genealogy: { children: [childSessionId] },
    callback_config: undefined,
  });

  const repository = {
    findById: vi.fn(async () => storedTask),
    update: vi.fn(async (_id: string, updates: Partial<Task>) => {
      storedTask = { ...storedTask, ...updates } as Task;
      return storedTask;
    }),
    create: vi.fn(),
    findAll: vi.fn(async () => [storedTask]),
    delete: vi.fn(),
  };

  const callbackTask = makeTask({
    task_id: callbackTaskId,
    session_id: parentSessionId,
    status: TaskStatus.QUEUED,
  });
  const createPending = vi.fn(async (data: Partial<Task>) => ({ ...callbackTask, ...data }));

  const sessionsPatch = vi.fn(async (_id: string, updates: Partial<Session>) => updates);
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
    completionCallbackDispatches: Map<string, Promise<void>>;
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
    getStoredTask: () => storedTask,
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

    expect(createPending).toHaveBeenCalledTimes(1);
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
});
