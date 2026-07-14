import {
  EXECUTOR_CLEANUP_STATUS,
  EXECUTOR_STATE_PERSISTENCE_STATUS,
  EXECUTOR_TERMINAL_CAUSE,
  TaskStatus,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

const TASK_ID = '018f0000-0000-7000-8000-000000000001';
const SESSION_ID = '018f0000-0000-7000-8000-000000000002';
const ATTEMPT_ID = '018f0000-0000-7000-8000-000000000003';

function task(status: string, executor = true) {
  return {
    task_id: TASK_ID,
    session_id: SESSION_ID,
    status,
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: '2026-01-01T00:00:01.000Z',
    ...(executor ? { executor_attempt_id: ATTEMPT_ID } : {}),
  };
}

function serviceHarness(currentTask: ReturnType<typeof task>) {
  const sessionsGet = vi.fn().mockResolvedValue({
    session_id: SESSION_ID,
    status: 'running',
    ready_for_prompt: false,
    tasks: [TASK_ID],
  });
  const sessionsPatch = vi.fn(async (_id, data) => ({
    session_id: SESSION_ID,
    tasks: [TASK_ID],
    ...data,
  }));
  const repositoryUpdate = vi.fn(async (_id, patch) => ({ ...currentTask, ...patch }));
  const service = Object.create(TasksService.prototype) as TasksService & {
    app: unknown;
    get: ReturnType<typeof vi.fn>;
    repository: { update: ReturnType<typeof vi.fn> };
    taskRepo: { failExpiredExecutorAttempt: ReturnType<typeof vi.fn> };
    id: string;
    emit: ReturnType<typeof vi.fn>;
    ownsExecutorFinalizationFence: ReturnType<typeof vi.fn>;
    dispatchCompletionSideEffectsAfterCommit: ReturnType<typeof vi.fn>;
  };
  service.get = vi.fn().mockResolvedValue(currentTask);
  service.repository = { update: repositoryUpdate };
  service.taskRepo = { failExpiredExecutorAttempt: vi.fn() };
  service.id = 'task_id';
  service.emit = vi.fn();
  service.ownsExecutorFinalizationFence = vi.fn().mockResolvedValue(true);
  service.dispatchCompletionSideEffectsAfterCommit = vi.fn();
  service.app = {
    service: (name: string) => {
      if (name === 'sessions') return { get: sessionsGet, patch: sessionsPatch };
      if (name === 'tasks') return { emit: service.emit };
      if (name === 'branches') return { get: vi.fn() };
      throw new Error(`unexpected service ${name}`);
    },
  };
  return { service, sessionsPatch, repositoryUpdate };
}

describe('TasksService executor settlement boundary', () => {
  it.each([
    [EXECUTOR_TERMINAL_CAUSE.HEARTBEAT_LOST, 'heartbeat lost'],
    [EXECUTOR_TERMINAL_CAUSE.DISPATCH_TIMEOUT, 'dispatch timeout'],
  ] as const)('publishes the winning %s lease expiry', async (terminalCause, errorMessage) => {
    const failedTask = {
      ...task(TaskStatus.FAILED),
      executor_terminal_cause: terminalCause,
      error_message: errorMessage,
    };
    const { service, sessionsPatch } = serviceHarness(failedTask);
    service.taskRepo.failExpiredExecutorAttempt.mockResolvedValue({
      task: failedTask,
      transitioned: true,
    });

    await expect(
      service.failExpiredExecutorAttempt(TASK_ID, {
        executor_attempt_id: ATTEMPT_ID,
        stale_before: '2026-01-01T00:00:02.000Z',
        completed_at: '2026-01-01T00:00:05.000Z',
        error_message: errorMessage,
        terminal_cause: terminalCause,
      })
    ).resolves.toMatchObject({ transitioned: true, task: { status: TaskStatus.FAILED } });

    expect(service.taskRepo.failExpiredExecutorAttempt).toHaveBeenCalledWith(TASK_ID, {
      executorAttemptId: ATTEMPT_ID,
      staleBefore: '2026-01-01T00:00:02.000Z',
      completedAt: '2026-01-01T00:00:05.000Z',
      errorMessage,
      terminalCause,
    });
    expect(sessionsPatch).not.toHaveBeenCalled();
  });

  it('preserves timed-out session state when cleanup releases the turn', async () => {
    const timedOutTask = task(TaskStatus.TIMED_OUT);
    const { service, sessionsPatch } = serviceHarness(timedOutTask);

    await service.finalizeExecutorAttempt(TASK_ID, ATTEMPT_ID, {
      evidence: {
        cleanup_status: EXECUTOR_CLEANUP_STATUS.VERIFIED,
        state_persistence_status: EXECUTOR_STATE_PERSISTENCE_STATUS.SKIPPED,
        cleanup_error: null,
        state_persistence_error: null,
        cleanup_verified_at: '2026-01-01T00:00:05.000Z',
      },
    });

    expect(sessionsPatch).toHaveBeenCalledWith(
      SESSION_ID,
      { status: 'timed_out', ready_for_prompt: true },
      undefined
    );
  });

  it.each([
    [EXECUTOR_CLEANUP_STATUS.VERIFIED, true],
    [EXECUTOR_CLEANUP_STATUS.UNRESOLVED, false],
  ] as const)('releases only after cleanup is %s', async (cleanupStatus, released) => {
    const failedTask = task(TaskStatus.FAILED);
    const { service, sessionsPatch } = serviceHarness(failedTask);

    await expect(
      service.finalizeExecutorAttempt(TASK_ID, ATTEMPT_ID, {
        evidence: {
          cleanup_status: cleanupStatus,
          state_persistence_status: EXECUTOR_STATE_PERSISTENCE_STATUS.SKIPPED,
          cleanup_error: released ? null : 'cleanup unresolved',
          state_persistence_error: null,
          cleanup_verified_at: released ? '2026-01-01T00:00:05.000Z' : null,
        },
      })
    ).resolves.toEqual({ finalized: true, released });

    expect(sessionsPatch).toHaveBeenCalledWith(
      SESSION_ID,
      { status: 'failed', ready_for_prompt: released },
      undefined
    );
    expect(service.dispatchCompletionSideEffectsAfterCommit).toHaveBeenCalledTimes(
      released ? 1 : 0
    );
  });

  it.each([
    TaskStatus.COMPLETED,
    TaskStatus.STOPPED,
    TaskStatus.FAILED,
  ])('never rewrites terminal task %s', async (status) => {
    const terminalTask = task(status);
    const { service, repositoryUpdate } = serviceHarness(terminalTask);

    await expect(service.patch(TASK_ID, { status: TaskStatus.RUNNING })).resolves.toBe(
      terminalTask
    );
    expect(repositoryUpdate).not.toHaveBeenCalled();
  });

  it('cancels queued work without releasing the active session', async () => {
    const queuedTask = task(TaskStatus.QUEUED, false);
    const { service, sessionsPatch } = serviceHarness(queuedTask);
    service.repository.update.mockResolvedValue({ ...queuedTask, status: TaskStatus.STOPPED });

    await service.patch(TASK_ID, { status: TaskStatus.STOPPED });

    expect(sessionsPatch).not.toHaveBeenCalled();
  });

  it('releases a non-executor stop through the session transition only', async () => {
    const runningTask = task(TaskStatus.RUNNING, false);
    const { service, sessionsPatch } = serviceHarness(runningTask);
    service.repository.update.mockResolvedValue({ ...runningTask, status: TaskStatus.STOPPED });

    await service.patch(TASK_ID, { status: TaskStatus.STOPPED });

    expect(sessionsPatch).toHaveBeenCalledWith(
      SESSION_ID,
      { status: 'idle', ready_for_prompt: true },
      undefined
    );
  });

  it.each([
    [TaskStatus.COMPLETED, EXECUTOR_TERMINAL_CAUSE.EXECUTOR_REPORTED],
    [TaskStatus.TIMED_OUT, EXECUTOR_TERMINAL_CAUSE.PERMISSION_TIMEOUT],
  ] as const)('leaves executor %s release to the coordinator after claiming the terminal winner', async (status, terminalCause) => {
    const runningTask = task(TaskStatus.RUNNING);
    const { service, sessionsPatch } = serviceHarness(runningTask);
    const transitionOwnedExecutorAttemptToTerminal = vi.fn().mockResolvedValue({
      task: { ...runningTask, status },
      transitioned: true,
    });
    service.taskRepo = {
      failExpiredExecutorAttempt: vi.fn(),
      transitionOwnedExecutorAttemptToTerminal,
    } as never;

    await service.patch(TASK_ID, { status });

    expect(transitionOwnedExecutorAttemptToTerminal).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ terminalCause })
    );
    expect(sessionsPatch).not.toHaveBeenCalled();
  });
});
