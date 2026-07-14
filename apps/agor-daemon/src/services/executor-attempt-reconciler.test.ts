import { EXECUTOR_TERMINAL_CAUSE, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  EXECUTOR_DISPATCH_TIMEOUT_MESSAGE,
  EXECUTOR_HEARTBEAT_LOST_MESSAGE,
  ExecutorAttemptReconciler,
} from './executor-attempt-reconciler';

const NOW = '2026-01-01T00:00:05.000Z';
const config = {
  enabled: true,
  interval_ms: 1_000,
  stale_after_ms: 3_000,
  connection_timeout_ms: 4_000,
  callback: { command_template: null, timeout_ms: 3_000 },
};

function task(overrides: Record<string, unknown> = {}) {
  return {
    task_id: '018f0000-0000-7000-8000-000000000001',
    session_id: '018f0000-0000-7000-8000-000000000002',
    status: TaskStatus.RUNNING,
    executor_attempt_id: '018f0000-0000-7000-8000-000000000003',
    last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function harness(currentTask: ReturnType<typeof task>, options = config) {
  const failExpiredExecutorAttempt = vi.fn().mockResolvedValue({
    task: { ...currentTask, status: TaskStatus.FAILED },
    transitioned: true,
  });
  const reconcile = vi.fn().mockResolvedValue({
    finalized: true,
    released: true,
    cleanupVerified: true,
    statePersistenceSucceeded: true,
  });
  const get = vi.fn().mockResolvedValue(currentTask);
  const reconciler = new ExecutorAttemptReconciler({
    app: { service: () => ({ get, failExpiredExecutorAttempt }) } as never,
    config: options,
    now: () => new Date(NOW),
    coordinator: { reconcile },
    discoverActiveAttemptRefs: async () => [{ task_id: currentTask.task_id as never }],
  });
  return { reconciler, failExpiredExecutorAttempt, reconcile, get };
}

describe('ExecutorAttemptReconciler', () => {
  it.each([
    {
      name: 'heartbeat',
      task: task(),
      cause: EXECUTOR_TERMINAL_CAUSE.HEARTBEAT_LOST,
      staleBefore: '2026-01-01T00:00:02.000Z',
      message: EXECUTOR_HEARTBEAT_LOST_MESSAGE,
      options: config,
    },
    {
      name: 'dispatch',
      task: task({
        status: TaskStatus.DISPATCHING,
        started_at: '2026-01-01T00:00:00.000Z',
        last_executor_heartbeat_at: undefined,
      }),
      cause: EXECUTOR_TERMINAL_CAUSE.DISPATCH_TIMEOUT,
      staleBefore: '2026-01-01T00:00:01.000Z',
      message: EXECUTOR_DISPATCH_TIMEOUT_MESSAGE,
      options: { ...config, enabled: false },
    },
    {
      name: 'first heartbeat',
      task: task({
        executor_connected_at: '2026-01-01T00:00:00.000Z',
        last_executor_heartbeat_at: undefined,
      }),
      cause: EXECUTOR_TERMINAL_CAUSE.HEARTBEAT_LOST,
      staleBefore: '2026-01-01T00:00:02.000Z',
      message: EXECUTOR_HEARTBEAT_LOST_MESSAGE,
      options: config,
    },
  ])('expires a stale $name lease and settles its winner', async (scenario) => {
    const { reconciler, failExpiredExecutorAttempt, reconcile } = harness(
      scenario.task,
      scenario.options
    );

    await reconciler.checkOnce();

    expect(failExpiredExecutorAttempt).toHaveBeenCalledWith(
      scenario.task.task_id,
      {
        executor_attempt_id: scenario.task.executor_attempt_id,
        stale_before: scenario.staleBefore,
        completed_at: NOW,
        error_message: scenario.message,
        terminal_cause: scenario.cause,
      },
      undefined
    );
    expect(reconcile).toHaveBeenCalledWith({
      taskId: scenario.task.task_id,
      executorAttemptId: scenario.task.executor_attempt_id,
      params: undefined,
    });
  });

  it('ignores a fresh heartbeat', async () => {
    const { reconciler, failExpiredExecutorAttempt } = harness(
      task({ last_executor_heartbeat_at: '2026-01-01T00:00:04.500Z' })
    );

    await reconciler.checkOnce();

    expect(failExpiredExecutorAttempt).not.toHaveBeenCalled();
  });

  it('carries discovered tenant identity into background service calls', async () => {
    const currentTask = task({ last_executor_heartbeat_at: '2026-01-01T00:00:04.500Z' });
    const get = vi.fn().mockResolvedValue(currentTask);
    const reconciler = new ExecutorAttemptReconciler({
      app: { service: () => ({ get }) } as never,
      config,
      now: () => new Date(NOW),
      discoverActiveAttemptRefs: async () => [
        { task_id: currentTask.task_id as never, tenant_id: 'tenant-a' },
      ],
    });

    await reconciler.checkOnce();

    expect(get).toHaveBeenCalledWith(
      currentTask.task_id,
      expect.objectContaining({ tenant: { tenant_id: 'tenant-a', source: 'explicit' } })
    );
  });

  it('delegates an already-terminal attempt directly to settlement', async () => {
    const currentTask = task({ status: TaskStatus.COMPLETED });
    const { reconciler, failExpiredExecutorAttempt, reconcile } = harness(currentTask);

    await reconciler.checkOnce();

    expect(failExpiredExecutorAttempt).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith({
      taskId: currentTask.task_id,
      executorAttemptId: currentTask.executor_attempt_id,
      params: undefined,
    });
  });
});
