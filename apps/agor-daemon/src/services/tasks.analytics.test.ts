import { resetAnalyticsLoggerForTests, setAnalyticsLoggerForTests } from '@agor/core/analytics';
import { type Task, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

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

    const task: Task = {
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
    } as Task;

    const service = Object.create(TasksService.prototype) as TasksService & {
      repository: { create: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
      app: unknown;
    };
    service.repository = { create: vi.fn().mockResolvedValue(task) };
    service.id = 'task_id';
    service.emit = vi.fn();
    service.app = { service: vi.fn() };

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
});
