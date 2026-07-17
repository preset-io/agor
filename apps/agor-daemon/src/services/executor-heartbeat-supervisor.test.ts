import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestExecutorTermination = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: 'terminal', task: {} })
);
vi.mock('../termination-coordinator.js', () => ({ requestExecutorTermination }));

import {
  EXECUTOR_HEARTBEAT_LOST_MESSAGE,
  ExecutorHeartbeatSupervisor,
} from './executor-heartbeat-supervisor';

describe('ExecutorHeartbeatSupervisor', () => {
  beforeEach(() => requestExecutorTermination.mockClear());

  it('marks active tasks failed when latest heartbeat is stale', async () => {
    const staleTask = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: 'running',
      last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
    };
    const app = {
      service: (name: string) => {
        if (name === 'tasks') {
          return {
            getActiveWithExecutorHeartbeat: vi.fn().mockResolvedValue([staleTask]),
            getOrphaned: vi.fn().mockResolvedValue([]),
            get: vi.fn().mockResolvedValue(staleTask),
          };
        }
        if (name === 'sessions') {
          return { get: vi.fn().mockResolvedValue({ agentic_tool: 'codex' }) };
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

    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: staleTask.task_id,
        cause: 'heartbeat_lost',
        errorMessage: EXECUTOR_HEARTBEAT_LOST_MESSAGE,
      })
    );
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
        getOrphaned: vi.fn().mockResolvedValue([]),
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
    expect(requestExecutorTermination).not.toHaveBeenCalled();
  });

  it('contains a local dispatch that never connects', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000011',
      session_id: '018f0000-0000-7000-8000-000000000012',
      status: 'dispatching',
      executor_mode: 'local',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const app = {
      service: (name: string) => {
        if (name === 'tasks') {
          return {
            getOrphaned: vi.fn().mockResolvedValue([task]),
            getActiveWithExecutorHeartbeat: vi.fn().mockResolvedValue([]),
            get: vi.fn().mockResolvedValue(task),
          };
        }
        return { get: vi.fn().mockResolvedValue({ agentic_tool: 'codex' }) };
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
      dispatchConnectTimeoutMs: 3000,
      now: () => new Date('2026-01-01T00:00:05.000Z'),
    });

    await supervisor.checkOnce();
    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.task_id, cause: 'startup_timeout' })
    );
  });

  it('warns but does not stop a slow templated dispatch', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000021',
      session_id: '018f0000-0000-7000-8000-000000000022',
      status: 'dispatching',
      executor_mode: 'templated',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const patch = vi.fn().mockResolvedValue(task);
    const app = {
      service: () => ({
        getOrphaned: vi.fn().mockResolvedValue([task]),
        getActiveWithExecutorHeartbeat: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(task),
        patch,
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
      dispatchConnectTimeoutMs: 3000,
      now: () => new Date('2026-01-01T00:00:05.000Z'),
    });

    await supervisor.checkOnce();
    expect(patch).toHaveBeenCalledWith(
      task.task_id,
      expect.objectContaining({ error_message: expect.stringContaining('still waiting') }),
      { provider: undefined }
    );
    expect(requestExecutorTermination).not.toHaveBeenCalled();
  });
});
