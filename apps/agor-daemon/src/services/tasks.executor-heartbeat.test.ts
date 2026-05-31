import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

describe('TasksService executor heartbeat helpers', () => {
  it('fails lost heartbeat tasks without idling the session or draining its queue', async () => {
    const service = Object.create(TasksService.prototype) as TasksService & {
      patch: ReturnType<typeof vi.fn>;
    };
    service.patch = vi.fn().mockResolvedValue({
      task_id: '018f0000-0000-7000-8000-000000000001',
      status: TaskStatus.FAILED,
    });

    await service.failForLostHeartbeat(
      '018f0000-0000-7000-8000-000000000001',
      {
        completed_at: '2026-01-01T00:00:05.000Z',
        error_message: 'Executor heartbeat lost',
      },
      { query: { session_id: '018f0000-0000-7000-8000-000000000002' } }
    );

    expect(service.patch).toHaveBeenCalledWith(
      '018f0000-0000-7000-8000-000000000001',
      {
        status: TaskStatus.FAILED,
        completed_at: '2026-01-01T00:00:05.000Z',
        error_message: 'Executor heartbeat lost',
      },
      {
        query: { session_id: '018f0000-0000-7000-8000-000000000002' },
        suppressTerminalSessionIdle: true,
        suppressTerminalQueueProcessing: true,
      }
    );
  });
});
