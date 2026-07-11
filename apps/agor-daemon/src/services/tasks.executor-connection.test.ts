import type { Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

describe('TasksService executor connection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs successful executor connection latency', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      created_by: '018f0000-0000-7000-8000-000000000003',
      full_prompt: 'test',
      status: TaskStatus.RUNNING,
      message_range: {
        start_index: 0,
        end_index: 0,
        start_timestamp: '2026-01-01T00:00:00.000Z',
      },
      git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
      tool_use_count: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:01.000Z',
      executor_connected_at: '2026-01-01T00:00:01.125Z',
    } as Task;
    const service = Object.create(TasksService.prototype) as TasksService & {
      emit: ReturnType<typeof vi.fn>;
    };
    Reflect.set(service, 'taskRepo', {
      connectExecutor: vi.fn().mockResolvedValue({ task, transitioned: true }),
    });
    service.emit = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await service.connectExecutor({ task_id: task.task_id });

    expect(log).toHaveBeenCalledWith(
      '🔌 [TasksService] Executor connected for task 018f00000000700080000000 in 125ms'
    );
    expect(service.emit).toHaveBeenCalledWith('patched', task);
  });
});
