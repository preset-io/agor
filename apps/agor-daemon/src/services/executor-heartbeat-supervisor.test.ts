import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestExecutorTermination = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: 'terminal', task: {} })
);
vi.mock('../termination-coordinator.js', () => ({ requestExecutorTermination }));

import {
  EXECUTOR_HEARTBEAT_LOST_MESSAGE,
  ExecutorHeartbeatSupervisor,
} from './executor-heartbeat-supervisor';

const now = () => new Date('2026-01-01T00:00:05.000Z');
const config = {
  enabled: true,
  interval_ms: 1000,
  stale_after_ms: 3000,
  callback: { command_template: null, timeout_ms: 3000 },
};

function supervisorFor(input: {
  active?: unknown[];
  orphaned?: unknown[];
  dispatchConnectTimeoutMs?: number;
  warningError?: Error;
}) {
  const recordExecutorStartupWarning = input.warningError
    ? vi.fn().mockRejectedValue(input.warningError)
    : vi.fn().mockResolvedValue(input.orphaned?.[0]);
  const app = {
    service: (name: string) => {
      if (name === 'tasks') {
        return {
          getActiveWithExecutorHeartbeat: vi.fn().mockResolvedValue(input.active ?? []),
          getOrphaned: vi.fn().mockResolvedValue(input.orphaned ?? []),
          recordExecutorStartupWarning,
        };
      }
      if (name === 'sessions') {
        return { get: vi.fn().mockResolvedValue({ agentic_tool: 'codex' }) };
      }
      throw new Error(`unknown service ${name}`);
    },
  } as any;
  return {
    recordExecutorStartupWarning,
    supervisor: new ExecutorHeartbeatSupervisor({
      app,
      config,
      now,
      dispatchConnectTimeoutMs: input.dispatchConnectTimeoutMs,
    }),
  };
}

describe('ExecutorHeartbeatSupervisor', () => {
  beforeEach(() => requestExecutorTermination.mockClear());

  it('marks active tasks failed when latest heartbeat is stale', async () => {
    const staleTask = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: 'running',
      last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
    };
    const { supervisor } = supervisorFor({ active: [staleTask] });

    await supervisor.checkOnce();

    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: staleTask.task_id,
        cause: 'heartbeat_lost',
        errorMessage: EXECUTOR_HEARTBEAT_LOST_MESSAGE,
        expectedStatus: staleTask.status,
        expectedHeartbeatAt: staleTask.last_executor_heartbeat_at,
        heartbeatStaleBefore: '2026-01-01T00:00:02.000Z',
      })
    );
  });

  it('treats an atomically rejected stale claim as a normal skip', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: 'running',
      last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
    };
    requestExecutorTermination.mockResolvedValueOnce({ status: 'condition_changed', task });
    const { supervisor } = supervisorFor({ active: [task] });

    await supervisor.checkOnce();

    expect(requestExecutorTermination).toHaveBeenCalledOnce();
  });

  it('contains a local dispatch that never connects', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000011',
      session_id: '018f0000-0000-7000-8000-000000000012',
      status: 'dispatching',
      executor_mode: 'local',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const { supervisor } = supervisorFor({ orphaned: [task], dispatchConnectTimeoutMs: 3000 });

    await supervisor.checkOnce();

    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.task_id,
        cause: 'startup_timeout',
        expectedStatus: 'dispatching',
        requireExecutorDisconnected: true,
      })
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
    const { supervisor, recordExecutorStartupWarning } = supervisorFor({
      orphaned: [task],
      dispatchConnectTimeoutMs: 3000,
    });

    await supervisor.checkOnce();

    expect(recordExecutorStartupWarning).toHaveBeenCalledWith(
      task.task_id,
      expect.stringContaining('still waiting'),
      { provider: undefined }
    );
    expect(requestExecutorTermination).not.toHaveBeenCalled();
  });

  it('keeps checking heartbeats when one dispatch warning fails', async () => {
    const dispatching = {
      task_id: '018f0000-0000-7000-8000-000000000021',
      status: 'dispatching',
      executor_mode: 'templated',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const stale = {
      task_id: '018f0000-0000-7000-8000-000000000031',
      session_id: '018f0000-0000-7000-8000-000000000032',
      status: 'running',
      last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
    };
    const { supervisor } = supervisorFor({
      orphaned: [dispatching],
      active: [stale],
      dispatchConnectTimeoutMs: 3000,
      warningError: new Error('write failed'),
    });

    await supervisor.checkOnce();

    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: stale.task_id, cause: 'heartbeat_lost' })
    );
  });
});
