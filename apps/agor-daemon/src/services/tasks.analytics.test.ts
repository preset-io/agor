import { resetAnalyticsLoggerForTests, setAnalyticsLoggerForTests } from '@agor/core/analytics';
import { type Task, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: '018f0000-0000-7000-8000-000000000001',
    session_id: '018f0000-0000-7000-8000-000000000002',
    created_by: '018f0000-0000-7000-8000-000000000003',
    full_prompt: 'do not emit this prompt',
    status: TaskStatus.CREATED,
    message_range: {
      start_index: 0,
      end_index: 0,
      start_timestamp: '2026-01-01T00:00:00.000Z',
    },
    tool_use_count: 0,
    git_state: {
      ref_at_start: 'main',
      sha_at_start: 'abc123',
    },
    model: 'test-model',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function makeService(repository: {
  create?: ReturnType<typeof vi.fn>;
  findById?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
}) {
  const sessionsService = {
    get: vi.fn().mockResolvedValue({
      session_id: '018f0000-0000-7000-8000-000000000002',
      tasks: ['018f0000-0000-7000-8000-000000000001'],
    }),
    patch: vi.fn().mockResolvedValue({}),
  };
  const service = Object.create(TasksService.prototype) as TasksService & {
    repository: typeof repository;
    id: string;
    emit: ReturnType<typeof vi.fn>;
    app: { service: ReturnType<typeof vi.fn> };
  };
  service.repository = repository;
  service.id = 'task_id';
  service.emit = vi.fn();
  service.app = { service: vi.fn(() => sessionsService) };
  return { service, sessionsService };
}

describe('TasksService analytics lifecycle events', () => {
  afterEach(() => {
    resetAnalyticsLoggerForTests();
  });

  it('emits a curated task.created event when a task is created', async () => {
    const track = vi.fn();
    setAnalyticsLoggerForTests({
      isEnabled: () => true,
      track,
    });

    const task = makeTask();
    const { service } = makeService({ create: vi.fn().mockResolvedValue(task) });

    await service.create({ session_id: task.session_id, full_prompt: task.full_prompt });

    expect(track).toHaveBeenCalledWith(
      'task.created',
      expect.objectContaining({
        task_id: task.task_id,
        session_id: task.session_id,
        status: TaskStatus.CREATED,
        model: 'test-model',
      }),
      { userId: task.created_by }
    );
    expect(track.mock.calls[0][1]).not.toHaveProperty('full_prompt');
  });

  it('emits task.started once when transitioning into running', async () => {
    const track = vi.fn();
    setAnalyticsLoggerForTests({ isEnabled: () => true, track });

    const currentTask = makeTask({ status: TaskStatus.CREATED });
    const runningTask = makeTask({
      status: TaskStatus.RUNNING,
      started_at: '2026-01-01T00:00:01.000Z',
    });
    const { service } = makeService({
      findById: vi.fn().mockResolvedValueOnce(currentTask).mockResolvedValueOnce(currentTask),
      update: vi.fn().mockResolvedValue(runningTask),
    });

    await service.patch(currentTask.task_id, { status: TaskStatus.RUNNING });

    expect(track).toHaveBeenCalledWith(
      'task.started',
      expect.objectContaining({ task_id: currentTask.task_id, status: TaskStatus.RUNNING }),
      { userId: currentTask.created_by }
    );

    track.mockClear();
    service.repository.findById = vi
      .fn()
      .mockResolvedValueOnce(runningTask)
      .mockResolvedValueOnce(runningTask);
    await service.patch(currentTask.task_id, { status: TaskStatus.RUNNING });

    expect(track).not.toHaveBeenCalledWith('task.started', expect.anything(), expect.anything());
  });

  it('emits task.completed once when transitioning to a terminal status, including timed_out', async () => {
    const track = vi.fn();
    setAnalyticsLoggerForTests({ isEnabled: () => true, track });

    const runningTask = makeTask({
      status: TaskStatus.RUNNING,
      started_at: '2026-01-01T00:00:00.000Z',
    });
    const timedOutTask = makeTask({
      status: TaskStatus.TIMED_OUT,
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:05.000Z',
      duration_ms: 5000,
    });
    const { service, sessionsService } = makeService({
      findById: vi.fn().mockResolvedValueOnce(runningTask).mockResolvedValueOnce(runningTask),
      update: vi.fn().mockResolvedValue(timedOutTask),
    });

    await service.patch(runningTask.task_id, { status: TaskStatus.TIMED_OUT });

    expect(track).toHaveBeenCalledWith(
      'task.completed',
      expect.objectContaining({
        task_id: runningTask.task_id,
        status: TaskStatus.TIMED_OUT,
        duration_ms: 5000,
      }),
      { userId: runningTask.created_by }
    );
    expect(sessionsService.patch).not.toHaveBeenCalled();

    track.mockClear();
    service.repository.findById = vi
      .fn()
      .mockResolvedValueOnce(timedOutTask)
      .mockResolvedValueOnce(timedOutTask);
    await service.patch(runningTask.task_id, { status: TaskStatus.TIMED_OUT });

    expect(track).not.toHaveBeenCalledWith('task.completed', expect.anything(), expect.anything());
  });
});
