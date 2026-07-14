import {
  EXECUTOR_CLEANUP_STATUS,
  EXECUTOR_STATE_PERSISTENCE_REQUIREMENT,
  EXECUTOR_STATE_PERSISTENCE_STATUS,
  EXECUTOR_TERMINAL_CAUSE,
  type Task,
  TaskStatus,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { EXECUTOR_TERMINATION_REASONS } from '../utils/executor-workload.js';
import { ExecutorAttemptCoordinator } from './executor-attempt-coordinator.js';

const TASK_ID = '018f0000-0000-7000-8000-000000000601';
const SESSION_ID = '018f0000-0000-7000-8000-000000000602';
const ATTEMPT_ID = '018f0000-0000-7000-8000-000000000603';

function makeHarness(overrides: Partial<Task> = {}) {
  const task = {
    task_id: TASK_ID,
    session_id: SESSION_ID,
    executor_attempt_id: ATTEMPT_ID,
    executor_terminal_cause: EXECUTOR_TERMINAL_CAUSE.EXECUTOR_REPORTED,
    executor_finalization: {
      cleanup_status: EXECUTOR_CLEANUP_STATUS.UNRESOLVED,
      state_persistence_status: EXECUTOR_STATE_PERSISTENCE_STATUS.PENDING,
      state_persistence_requirement: EXECUTOR_STATE_PERSISTENCE_REQUIREMENT.NOT_REQUIRED,
      cleanup_error: null,
      state_persistence_error: null,
      cleanup_verified_at: null,
    },
    status: TaskStatus.COMPLETED,
    ...overrides,
  } as Task;
  const finalizeExecutorAttempt = vi.fn(async () => ({ finalized: true, released: true }));
  const tasks = { get: vi.fn(async () => task), finalizeExecutorAttempt };
  return {
    task,
    tasks,
    app: {
      service: (name: string) =>
        name === 'tasks' ? tasks : { get: vi.fn(async () => ({ branch_id: 'branch-1' })) },
    },
  };
}

function evidenceFrom(tasks: ReturnType<typeof makeHarness>['tasks']) {
  return tasks.finalizeExecutorAttempt.mock.calls[0]?.[2].evidence;
}

describe('ExecutorAttemptCoordinator', () => {
  it('does nothing until a terminal head owns the attempt', async () => {
    const { app, task, tasks } = makeHarness({ status: TaskStatus.RUNNING });
    const terminateAttempt = vi.fn();
    const coordinator = new ExecutorAttemptCoordinator(app as never, { terminateAttempt });

    await expect(
      coordinator.reconcile({ taskId: TASK_ID, executorAttemptId: ATTEMPT_ID })
    ).resolves.toEqual({ finalized: false, released: false });
    expect(terminateAttempt).not.toHaveBeenCalled();
    expect(tasks.finalizeExecutorAttempt).not.toHaveBeenCalled();
    expect(task.status).toBe(TaskStatus.RUNNING);
  });

  it.each([
    {
      name: 'normal completion',
      overrides: {},
      expected: 'finish',
    },
    {
      name: 'unexpected exit',
      overrides: {
        status: TaskStatus.FAILED,
        executor_terminal_cause: EXECUTOR_TERMINAL_CAUSE.UNEXPECTED_EXIT,
      },
      expected: 'finish',
    },
    {
      name: 'user stop',
      overrides: {
        status: TaskStatus.STOPPED,
        executor_terminal_cause: EXECUTOR_TERMINAL_CAUSE.USER_STOP,
      },
      expected: 'terminate',
      expectedReason: EXECUTOR_TERMINATION_REASONS.USER_STOP,
    },
    {
      name: 'dispatch timeout',
      overrides: {
        status: TaskStatus.FAILED,
        executor_terminal_cause: EXECUTOR_TERMINAL_CAUSE.DISPATCH_TIMEOUT,
      },
      expected: 'terminate',
      expectedReason: EXECUTOR_TERMINATION_REASONS.DISPATCH_TIMEOUT,
    },
    {
      name: 'heartbeat loss',
      overrides: {
        status: TaskStatus.FAILED,
        executor_terminal_cause: EXECUTOR_TERMINAL_CAUSE.HEARTBEAT_LOST,
      },
      expected: 'terminate',
      expectedReason: EXECUTOR_TERMINATION_REASONS.HEARTBEAT_LOST,
    },
    {
      name: 'permission timeout',
      overrides: {
        status: TaskStatus.TIMED_OUT,
        executor_terminal_cause: EXECUTOR_TERMINAL_CAUSE.PERMISSION_TIMEOUT,
      },
      expected: 'finish',
    },
    {
      name: 'proven absent launch',
      overrides: {
        status: TaskStatus.FAILED,
        executor_terminal_cause: EXECUTOR_TERMINAL_CAUSE.LAUNCH_FAILED_ABSENT,
      },
      expected: 'skip',
    },
    {
      name: 'unknown launch failure',
      overrides: {
        status: TaskStatus.FAILED,
        executor_terminal_cause: EXECUTOR_TERMINAL_CAUSE.LAUNCH_FAILED_UNKNOWN,
      },
      expected: 'terminate',
      expectedReason: EXECUTOR_TERMINATION_REASONS.RECONCILIATION,
    },
    {
      name: 'daemon restart',
      overrides: {
        status: TaskStatus.STOPPED,
        executor_terminal_cause: EXECUTOR_TERMINAL_CAUSE.DAEMON_RESTART,
      },
      expected: 'terminate',
      expectedReason: EXECUTOR_TERMINATION_REASONS.RECONCILIATION,
    },
  ])('applies state-driven cleanup for $name', async ({ overrides, expected, expectedReason }) => {
    const { app, tasks } = makeHarness(overrides as Partial<Task>);
    const finishAttempt = vi.fn(async () => EXECUTOR_CLEANUP_STATUS.VERIFIED);
    const terminateAttempt = vi.fn(async () => EXECUTOR_CLEANUP_STATUS.VERIFIED);
    const recoverAttempt = vi.fn(async () => false);
    const coordinator = new ExecutorAttemptCoordinator(app as never, {
      finishAttempt,
      terminateAttempt,
      recoverAttempt,
      now: () => new Date('2026-07-14T10:00:00.000Z'),
    });

    await coordinator.reconcile({ taskId: TASK_ID, executorAttemptId: ATTEMPT_ID });

    expect(finishAttempt).toHaveBeenCalledTimes(expected === 'finish' ? 1 : 0);
    expect(terminateAttempt).toHaveBeenCalledTimes(expected === 'terminate' ? 1 : 0);
    if (expectedReason) {
      expect(terminateAttempt).toHaveBeenCalledWith(SESSION_ID, ATTEMPT_ID, expectedReason);
    }
    expect(recoverAttempt).not.toHaveBeenCalled();
    expect(evidenceFrom(tasks)).toMatchObject({
      cleanup_status: EXECUTOR_CLEANUP_STATUS.VERIFIED,
      state_persistence_status: EXECUTOR_STATE_PERSISTENCE_STATUS.SKIPPED,
      cleanup_verified_at: '2026-07-14T10:00:00.000Z',
    });
  });

  it('recovers an untracked workload by durable attempt identity', async () => {
    const { app, tasks } = makeHarness({
      status: TaskStatus.STOPPED,
      executor_terminal_cause: EXECUTOR_TERMINAL_CAUSE.USER_STOP,
    });
    const recoverAttempt = vi.fn(async () => true);
    const coordinator = new ExecutorAttemptCoordinator(app as never, {
      terminateAttempt: vi.fn(async () => EXECUTOR_CLEANUP_STATUS.UNRESOLVED),
      recoverAttempt,
    });

    await coordinator.reconcile({ taskId: TASK_ID, executorAttemptId: ATTEMPT_ID });

    expect(recoverAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ executorAttemptId: ATTEMPT_ID })
    );
    expect(evidenceFrom(tasks).cleanup_status).toBe(EXECUTOR_CLEANUP_STATUS.VERIFIED);
  });

  it('keeps required persistence pending until cleanup is verified', async () => {
    const { app, tasks } = makeHarness({
      executor_connected_at: '2026-07-14T09:59:00.000Z',
      executor_finalization: {
        cleanup_status: EXECUTOR_CLEANUP_STATUS.UNRESOLVED,
        state_persistence_status: EXECUTOR_STATE_PERSISTENCE_STATUS.PENDING,
        state_persistence_requirement: EXECUTOR_STATE_PERSISTENCE_REQUIREMENT.REQUIRED,
        cleanup_error: null,
        state_persistence_error: null,
        cleanup_verified_at: null,
      },
    });
    tasks.finalizeExecutorAttempt.mockResolvedValueOnce({ finalized: true, released: false });
    const persistState = vi.fn(async () => true);
    const coordinator = new ExecutorAttemptCoordinator(app as never, {
      db: {} as never,
      finishAttempt: vi.fn(async () => EXECUTOR_CLEANUP_STATUS.UNRESOLVED),
      recoverAttempt: vi.fn(async () => false),
      persistState,
    });

    await expect(
      coordinator.reconcile({ taskId: TASK_ID, executorAttemptId: ATTEMPT_ID })
    ).resolves.toEqual({ finalized: true, released: false });
    expect(persistState).not.toHaveBeenCalled();
    expect(evidenceFrom(tasks)).toMatchObject({
      cleanup_status: EXECUTOR_CLEANUP_STATUS.UNRESOLVED,
      state_persistence_status: EXECUTOR_STATE_PERSISTENCE_STATUS.PENDING,
    });
  });

  it('reuses durable cleanup proof when retrying persistence', async () => {
    const { app, tasks } = makeHarness({
      executor_connected_at: '2026-07-14T09:59:00.000Z',
      executor_finalization: {
        cleanup_status: EXECUTOR_CLEANUP_STATUS.VERIFIED,
        state_persistence_status: EXECUTOR_STATE_PERSISTENCE_STATUS.FAILED,
        state_persistence_requirement: EXECUTOR_STATE_PERSISTENCE_REQUIREMENT.REQUIRED,
        cleanup_error: null,
        state_persistence_error: 'previous failure',
        cleanup_verified_at: '2026-07-14T10:00:00.000Z',
      },
    });
    const finishAttempt = vi.fn();
    const persistState = vi.fn(async () => true);
    const coordinator = new ExecutorAttemptCoordinator(app as never, {
      db: {} as never,
      finishAttempt,
      persistState,
    });

    await coordinator.reconcile({ taskId: TASK_ID, executorAttemptId: ATTEMPT_ID });

    expect(finishAttempt).not.toHaveBeenCalled();
    expect(persistState).toHaveBeenCalledOnce();
    expect(evidenceFrom(tasks)).toMatchObject({
      cleanup_verified_at: '2026-07-14T10:00:00.000Z',
      state_persistence_status: EXECUTOR_STATE_PERSISTENCE_STATUS.VERIFIED,
    });
  });

  it('joins concurrent lifecycle heads into one settlement', async () => {
    const { app, tasks } = makeHarness();
    let finishCleanup!: () => void;
    const finishAttempt = vi.fn(
      () =>
        new Promise<typeof EXECUTOR_CLEANUP_STATUS.VERIFIED>((resolve) => {
          finishCleanup = () => resolve(EXECUTOR_CLEANUP_STATUS.VERIFIED);
        })
    );
    const coordinator = new ExecutorAttemptCoordinator(app as never, { finishAttempt });
    const options = { taskId: TASK_ID, executorAttemptId: ATTEMPT_ID };

    const settlements = [coordinator.reconcile(options), coordinator.reconcile(options)];
    await vi.waitFor(() => expect(finishAttempt).toHaveBeenCalledOnce());
    finishCleanup();

    await expect(Promise.all(settlements)).resolves.toHaveLength(2);
    expect(tasks.finalizeExecutorAttempt).toHaveBeenCalledOnce();
  });
});
