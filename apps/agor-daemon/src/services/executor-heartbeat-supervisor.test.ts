import { describe, expect, it, vi } from 'vitest';
import {
  EXECUTOR_HEARTBEAT_LOST_MESSAGE,
  ExecutorHeartbeatSupervisor,
} from './executor-heartbeat-supervisor';

describe('ExecutorHeartbeatSupervisor', () => {
  it('marks active tasks failed when latest heartbeat is stale', async () => {
    const staleTask = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: 'running',
      last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
    };
    const failForLostHeartbeat = vi.fn().mockResolvedValue({});
    const app = {
      service: (name: string) => {
        if (name === 'tasks') {
          return {
            getActiveWithExecutorHeartbeat: vi.fn().mockResolvedValue([staleTask]),
            get: vi.fn().mockResolvedValue(staleTask),
            failForLostHeartbeat,
          };
        }
        throw new Error(`unknown service ${name}`);
      },
    } as any;

    const supervisor = new ExecutorHeartbeatSupervisor({
      app,
      config: {
        enabled: true,
        interval_ms: 1000,
        stale_after_ms: 3000,
        callback: { command_template: null, timeout_ms: 3000 },
      },
      now: () => new Date('2026-01-01T00:00:05.000Z'),
    });

    await supervisor.checkOnce();

    expect(failForLostHeartbeat).toHaveBeenCalledWith(staleTask.task_id, {
      completed_at: '2026-01-01T00:00:05.000Z',
      error_message: EXECUTOR_HEARTBEAT_LOST_MESSAGE,
    });
  });

  it('skips tasks that refreshed before failure', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: 'running',
      last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
    };
    const tasksPatch = vi.fn();
    const app = {
      service: (name: string) => ({
        getActiveWithExecutorHeartbeat: vi.fn().mockResolvedValue([task]),
        get: vi.fn().mockResolvedValue({
          ...task,
          last_executor_heartbeat_at: '2026-01-01T00:00:04.500Z',
        }),
        patch: name === 'tasks' ? tasksPatch : vi.fn(),
      }),
    } as any;

    const supervisor = new ExecutorHeartbeatSupervisor({
      app,
      config: {
        enabled: true,
        interval_ms: 1000,
        stale_after_ms: 3000,
        callback: { command_template: null, timeout_ms: 3000 },
      },
      now: () => new Date('2026-01-01T00:00:05.000Z'),
    });

    await supervisor.checkOnce();
    expect(tasksPatch).not.toHaveBeenCalled();
  });
});
