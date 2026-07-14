import type { Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

function makeTask(taskId: string, status: Task['status'] = TaskStatus.CREATED): Task {
  return {
    task_id: taskId,
    session_id: '018f0000-0000-7000-8000-000000000010',
    created_by: '018f0000-0000-7000-8000-000000000020',
    full_prompt: `prompt for ${taskId}`,
    status,
    message_range: {
      start_index: 0,
      end_index: 0,
      start_timestamp: '2026-01-01T00:00:00.000Z',
    },
    git_state: {
      ref_at_start: 'main',
      sha_at_start: 'abc123',
    },
    tool_use_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
  } as Task;
}

describe('TasksService.find', () => {
  it('preserves a task_id filter when session_id is also present', async () => {
    const scopedTask = makeTask('018f0000-0000-7000-8000-000000000001');
    const otherTask = makeTask('018f0000-0000-7000-8000-000000000002');
    const findAll = vi.fn().mockResolvedValue([scopedTask, otherTask]);
    const findBySession = vi.fn().mockResolvedValue([scopedTask, otherTask]);
    const repository = { findAll };
    const service = Object.create(TasksService.prototype) as TasksService;

    Reflect.set(service, 'repository', repository);
    Reflect.set(service, 'taskRepo', { findAll, findBySession });
    Reflect.set(service, 'paginate', { default: 50, max: 1000 });

    const result = await service.find({
      query: {
        session_id: scopedTask.session_id,
        task_id: scopedTask.task_id,
      },
    });

    expect(result).toMatchObject({
      total: 1,
      data: [scopedTask],
    });
    expect(findBySession).not.toHaveBeenCalled();
  });

  it('filters session tasks by status before pagination', async () => {
    const dispatching = makeTask('018f0000-0000-7000-8000-000000000001', TaskStatus.DISPATCHING);
    const completed = makeTask('018f0000-0000-7000-8000-000000000002', TaskStatus.COMPLETED);
    const running = makeTask('018f0000-0000-7000-8000-000000000003', TaskStatus.RUNNING);
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', {
      findBySession: vi.fn().mockResolvedValue([completed, dispatching, running]),
    });
    Reflect.set(service, 'paginate', { default: 50, max: 1000 });

    const result = await service.find({
      query: {
        session_id: dispatching.session_id,
        status: { $in: [TaskStatus.DISPATCHING, TaskStatus.RUNNING] },
        $limit: 1,
      } as never,
    });

    expect(result).toMatchObject({ total: 2, data: [dispatching] });
  });
});
