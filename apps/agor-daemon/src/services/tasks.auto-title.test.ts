import { type Session, type Task, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

const sessionId = '018f0000-0000-7000-8000-000000000101';
const taskId = '018f0000-0000-7000-8000-000000000201';
const userId = '018f0000-0000-7000-8000-000000000401';

const DERIVED_TITLE = 'Add a JWT-based authentication system with refresh token…';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: taskId,
    session_id: sessionId,
    created_by: userId,
    full_prompt: 'Add a JWT-based authentication system with refresh token rotation',
    status: TaskStatus.RUNNING,
    message_range: {
      start_index: 0,
      end_index: 2,
      start_timestamp: '2026-01-01T00:00:00.000Z',
    },
    tool_use_count: 1,
    git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: sessionId,
    branch_id: undefined,
    created_by: userId,
    agentic_tool: 'claude-code',
    status: 'running',
    tasks: [taskId],
    ready_for_prompt: false,
    archived: false,
    genealogy: { children: [] },
    git_state: {},
    contextFiles: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function makeService(options: { task?: Partial<Task>; session?: Partial<Session> } = {}) {
  const initialTask = makeTask(options.task);
  const tasksById = new Map<string, Task>([[initialTask.task_id, initialTask]]);
  const session = makeSession(options.session);

  const repository = {
    findById: vi.fn(async (id: string) => tasksById.get(id) ?? null),
    update: vi.fn(async (id: string, updates: Partial<Task>) => {
      const current = tasksById.get(id) ?? makeTask({ task_id: id as Task['task_id'] });
      const updated = { ...current, ...updates } as Task;
      tasksById.set(id, updated);
      return updated;
    }),
    create: vi.fn(async (data: Partial<Task>) => {
      const created = makeTask(data);
      tasksById.set(created.task_id, created);
      return created;
    }),
    findAll: vi.fn(async () => [...tasksById.values()]),
    delete: vi.fn(),
  };

  const sessionsPatch = vi.fn(async (id: string, updates: Partial<Session>) => {
    Object.assign(session, updates);
    return { ...session };
  });
  // Returns a fresh snapshot each call so a test can script a concurrent
  // rename between the terminal status read and the auto-title compare-and-set.
  const sessionsGet = vi.fn(async () => ({ ...session }));
  const triggerQueueProcessing = vi.fn(async () => undefined);

  const service = Object.create(TasksService.prototype) as TasksService & {
    repository: typeof repository;
    taskRepo: typeof repository & { createPending: ReturnType<typeof vi.fn> };
    id: string;
    emit: ReturnType<typeof vi.fn>;
    app: { service: ReturnType<typeof vi.fn> };
    completionCallbackDispatches: Map<string, Promise<unknown>>;
  };
  service.repository = repository;
  service.taskRepo = { ...repository, createPending: vi.fn() };
  service.id = 'task_id';
  service.emit = vi.fn();
  service.completionCallbackDispatches = new Map();
  service.app = {
    service: vi.fn((name: string) => {
      if (name === 'sessions') {
        return { get: sessionsGet, patch: sessionsPatch, triggerQueueProcessing };
      }
      if (name === 'messages') return { find: vi.fn(async () => []) };
      if (name === 'branches') return { get: vi.fn() };
      throw new Error(`unexpected service ${name}`);
    }),
  };

  return { service, sessionsPatch, sessionsGet, session };
}

/** Find the separate, title-only patch (undefined if auto-title never wrote). */
function titlePatchCall(sessionsPatch: ReturnType<typeof vi.fn>) {
  return sessionsPatch.mock.calls.find(
    ([, updates]) => (updates as Partial<Session>).title !== undefined
  );
}

describe('TasksService auto-title', () => {
  it.each([TaskStatus.QUEUED, TaskStatus.RUNNING])(
    'auto-titles an untitled session when a %s task is created',
    async (status) => {
      const { service, sessionsPatch } = makeService({ session: { title: undefined } });

      await service.create(makeTask({ status }), { provider: 'rest' });

      const titleCall = titlePatchCall(sessionsPatch);
      expect(titleCall?.[1]).toEqual({ title: DERIVED_TITLE });
      expect(titleCall?.[2]).toMatchObject({ provider: undefined });
    }
  );

  it('does not rewrite the repository-owned terminal Session projection', async () => {
    const { service, sessionsPatch } = makeService({ session: { title: undefined } });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    // The Task repository already committed the minimal status projection in
    // the Task transaction. A second Session write here could race and clobber
    // a newer Task's RUNNING/ready=false claim.
    expect(
      sessionsPatch.mock.calls.some(
        ([, updates]) =>
          Object.hasOwn(updates as object, 'status') ||
          Object.hasOwn(updates as object, 'ready_for_prompt')
      )
    ).toBe(false);
  });

  it('auto-titles an untitled session via a separate trusted (provider-less) patch', async () => {
    const { service, sessionsPatch } = makeService({ session: { title: undefined } });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    const titleCall = titlePatchCall(sessionsPatch);
    expect(titleCall).toBeDefined();
    const [, titleUpdates, titleParams] = titleCall as [string, Partial<Session>, unknown];
    expect(titleUpdates).toEqual({ title: DERIVED_TITLE });
    // Written with no provider so it bypasses the collaborator-metadata gate.
    expect(titleParams).toMatchObject({ provider: undefined });
  });

  it('does not overwrite an explicit title', async () => {
    const { service, sessionsPatch } = makeService({ session: { title: 'My session' } });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    expect(titlePatchCall(sessionsPatch)).toBeUndefined();
  });

  it('treats an explicitly-cleared empty-string title as set (does not re-arm auto-title)', async () => {
    const { service, sessionsPatch } = makeService({ session: { title: '' } });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    // '' is a deliberate user choice, not "unset" — never re-derive over it.
    expect(titlePatchCall(sessionsPatch)).toBeUndefined();
  });

  it('does not clobber a rename that lands while the task is running (compare-and-set)', async () => {
    const { service, sessionsPatch, sessionsGet } = makeService({ session: { title: undefined } });

    // Terminal read sees no title; by the compare-and-set re-read a user rename
    // has landed, so the derived title must be dropped rather than overwrite it.
    sessionsGet
      .mockResolvedValueOnce(makeSession({ title: undefined }))
      .mockResolvedValueOnce(makeSession({ title: 'User typed this while it ran' }));

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    expect(titlePatchCall(sessionsPatch)).toBeUndefined();
  });

  it('still derives a title from a later task when the session has none yet', async () => {
    const earlierTaskId = '018f0000-0000-7000-8000-000000000202';
    const { service, sessionsPatch } = makeService({
      session: { title: undefined, tasks: [earlierTaskId, taskId] },
    });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    const titleCall = titlePatchCall(sessionsPatch);
    expect(titleCall?.[1]).toEqual({ title: DERIVED_TITLE });
  });

  it('derives a create-time title from user text after the attachment preamble', async () => {
    const { service, sessionsPatch } = makeService({ session: { title: undefined } });

    await service.create(
      makeTask({
        status: TaskStatus.QUEUED,
        full_prompt: 'Attached files:\n- .agor/uploads/chart.png\n\nExplain the anomaly',
      })
    );

    expect(titlePatchCall(sessionsPatch)?.[1]).toEqual({ title: 'Explain the anomaly' });
  });

  it('excludes a trailing attachment block from a slash-command title', async () => {
    const { service, sessionsPatch } = makeService({ session: { title: undefined } });

    await service.create(
      makeTask({
        status: TaskStatus.QUEUED,
        full_prompt: '/compact focus on this chart\n\nAttached files:\n- /tmp/chart.png',
      })
    );

    expect(titlePatchCall(sessionsPatch)?.[1]).toEqual({ title: '/compact focus on this chart' });
  });

  it('does not derive a title from an attachment-only prompt', async () => {
    const { service, sessionsPatch } = makeService({
      session: { title: undefined },
    });

    await service.create(
      makeTask({
        status: TaskStatus.QUEUED,
        full_prompt: 'Attached files:\n- .agor/uploads/chart.png',
      })
    );

    expect(titlePatchCall(sessionsPatch)).toBeUndefined();
  });

  it.each([TaskStatus.FAILED, TaskStatus.STOPPED])(
    'keeps the create-time title when execution ends %s',
    async (status) => {
      const { service, sessionsPatch, session } = makeService({
        session: { title: undefined },
      });

      await service.create(makeTask({ status: TaskStatus.RUNNING }));
      await service.patch(taskId, {
        status,
        completed_at: '2026-01-01T00:00:05.000Z',
      });

      expect(session.title).toBe(DERIVED_TITLE);
      expect(sessionsPatch.mock.calls.filter((call) => call[1]?.title !== undefined)).toHaveLength(
        1
      );
    }
  );
});
