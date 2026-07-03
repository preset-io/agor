import { describe, expect, it, vi } from 'vitest';
import {
  EXECUTOR_HEARTBEAT_LOST_MESSAGE,
  ExecutorHeartbeatSupervisor,
} from './executor-heartbeat-supervisor';

const BASE_CONFIG = {
  enabled: true,
  interval_ms: 1000,
  stale_after_ms: 3000,
  callback: { command_template: null, timeout_ms: 3000 },
} as const;

function makeStaleTask(overrides: Record<string, unknown> = {}) {
  return {
    task_id: '018f0000-0000-7000-8000-000000000001',
    session_id: '018f0000-0000-7000-8000-000000000002',
    status: 'running',
    last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeApp(
  task: Record<string, unknown>,
  failForLostHeartbeat = vi.fn().mockResolvedValue({})
) {
  return {
    app: {
      service: (name: string) => {
        if (name === 'tasks') {
          return {
            getActiveWithExecutorHeartbeat: vi.fn().mockResolvedValue([task]),
            get: vi.fn().mockResolvedValue(task),
            failForLostHeartbeat,
          };
        }
        throw new Error(`unknown service ${name}`);
      },
    } as any,
    failForLostHeartbeat,
  };
}

describe('ExecutorHeartbeatSupervisor', () => {
  it('fails a stale task when the executor process is confirmed dead', async () => {
    const staleTask = makeStaleTask();
    const { app, failForLostHeartbeat } = makeApp(staleTask);

    const supervisor = new ExecutorHeartbeatSupervisor({
      app,
      config: { ...BASE_CONFIG },
      now: () => new Date('2026-01-01T00:00:05.000Z'),
      checkExecutorLiveness: () => 'dead',
    });

    await supervisor.checkOnce();

    expect(failForLostHeartbeat).toHaveBeenCalledWith(staleTask.task_id, {
      completed_at: '2026-01-01T00:00:05.000Z',
      error_message: EXECUTOR_HEARTBEAT_LOST_MESSAGE,
    });
  });

  it('fails a stale task when the executor PID is unknown (preserves reaping of orphans)', async () => {
    const staleTask = makeStaleTask();
    const { app, failForLostHeartbeat } = makeApp(staleTask);

    const supervisor = new ExecutorHeartbeatSupervisor({
      app,
      config: { ...BASE_CONFIG },
      now: () => new Date('2026-01-01T00:00:05.000Z'),
      checkExecutorLiveness: () => 'unknown',
    });

    await supervisor.checkOnce();

    expect(failForLostHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('does NOT fail a stale task while the executor process is still alive', async () => {
    const staleTask = makeStaleTask();
    const { app, failForLostHeartbeat } = makeApp(staleTask);

    const supervisor = new ExecutorHeartbeatSupervisor({
      app,
      config: { ...BASE_CONFIG },
      now: () => new Date('2026-01-01T00:00:05.000Z'),
      checkExecutorLiveness: () => 'alive',
    });

    await supervisor.checkOnce();

    expect(failForLostHeartbeat).not.toHaveBeenCalled();
  });

  it('does NOT fail when a long synchronous tool call starves the heartbeat but the process is alive', async () => {
    // Heartbeat is extremely stale (executor was busy in a long tool call and
    // could not emit) yet the OS reports the process alive — must not be reaped.
    const staleTask = makeStaleTask({ last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z' });
    const { app, failForLostHeartbeat } = makeApp(staleTask);

    const supervisor = new ExecutorHeartbeatSupervisor({
      app,
      config: { ...BASE_CONFIG },
      now: () => new Date('2026-01-01T00:10:00.000Z'), // 10 minutes later
      checkExecutorLiveness: () => 'alive',
    });

    await supervisor.checkOnce();

    expect(failForLostHeartbeat).not.toHaveBeenCalled();
  });

  it('skips tasks that refreshed before failure', async () => {
    const task = makeStaleTask();
    const tasksPatch = vi.fn();
    const failForLostHeartbeat = vi.fn();
    const app = {
      service: (name: string) => ({
        getActiveWithExecutorHeartbeat: vi.fn().mockResolvedValue([task]),
        get: vi.fn().mockResolvedValue({
          ...task,
          last_executor_heartbeat_at: '2026-01-01T00:00:04.500Z',
        }),
        patch: name === 'tasks' ? tasksPatch : vi.fn(),
        failForLostHeartbeat,
      }),
    } as any;

    const supervisor = new ExecutorHeartbeatSupervisor({
      app,
      config: { ...BASE_CONFIG },
      now: () => new Date('2026-01-01T00:00:05.000Z'),
      checkExecutorLiveness: () => 'dead',
    });

    await supervisor.checkOnce();
    expect(tasksPatch).not.toHaveBeenCalled();
    expect(failForLostHeartbeat).not.toHaveBeenCalled();
  });
});
