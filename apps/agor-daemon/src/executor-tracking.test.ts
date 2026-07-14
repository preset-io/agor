import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXECUTOR_CLEANUP_STATUS,
  finishExecutorAttempt,
  hasTrackedExecutorAttempt,
  isExecutorAttemptOwner,
  terminateExecutorAttempt,
  trackExecutorAttempt,
  untrackExecutorAttempt,
} from './executor-tracking.js';
import { EXECUTOR_TERMINATION_REASONS } from './utils/executor-workload.js';

function workload(pid: number) {
  return {
    pid,
    finish: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

describe('executor attempt tracking', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not let an older process exit untrack the current attempt', async () => {
    const sessionId = 'session-1';
    const current = workload(202);

    trackExecutorAttempt(sessionId, workload(101), 'attempt-1');
    trackExecutorAttempt(sessionId, current, 'attempt-2');
    untrackExecutorAttempt(sessionId, 'attempt-1');

    await expect(
      terminateExecutorAttempt(sessionId, 'attempt-2', EXECUTOR_TERMINATION_REASONS.USER_STOP)
    ).resolves.toBe(EXECUTOR_CLEANUP_STATUS.VERIFIED);
    expect(current.terminate).toHaveBeenCalledWith(EXECUTOR_TERMINATION_REASONS.USER_STOP);

    untrackExecutorAttempt(sessionId, 'attempt-2');
  });

  it('does not let a late stale spawn replace the current attempt', async () => {
    const sessionId = 'session-reverse-order';
    const current = workload(202);

    trackExecutorAttempt(sessionId, current, 'attempt-current');
    trackExecutorAttempt(sessionId, workload(101), 'attempt-stale');
    untrackExecutorAttempt(sessionId, 'attempt-stale');

    await expect(
      terminateExecutorAttempt(
        sessionId,
        'attempt-current',
        EXECUTOR_TERMINATION_REASONS.HEARTBEAT_LOST
      )
    ).resolves.toBe(EXECUTOR_CLEANUP_STATUS.VERIFIED);
    expect(current.terminate).toHaveBeenCalledWith(EXECUTOR_TERMINATION_REASONS.HEARTBEAT_LOST);

    untrackExecutorAttempt(sessionId, 'attempt-current');
  });

  it('retains verified cleanup evidence until durable finalization', async () => {
    const current = workload(303);
    trackExecutorAttempt('session-finish', current, 'attempt-finish');

    await expect(finishExecutorAttempt('session-finish', 'attempt-finish')).resolves.toBe(
      EXECUTOR_CLEANUP_STATUS.VERIFIED
    );
    expect(current.finish).toHaveBeenCalledOnce();
    expect(hasTrackedExecutorAttempt('session-finish', 'attempt-finish')).toBe(true);
    await expect(finishExecutorAttempt('session-finish', 'attempt-finish')).resolves.toBe(
      EXECUTOR_CLEANUP_STATUS.VERIFIED
    );
    untrackExecutorAttempt('session-finish', 'attempt-finish');
  });

  it('retains a failed cleanup so the reconciler can retry it', async () => {
    const current = workload(404);
    current.terminate
      .mockRejectedValueOnce(new Error('temporary cleanup failure'))
      .mockResolvedValueOnce(undefined);
    trackExecutorAttempt('session-retry', current, 'attempt-retry');

    await expect(
      terminateExecutorAttempt(
        'session-retry',
        'attempt-retry',
        EXECUTOR_TERMINATION_REASONS.RECONCILIATION
      )
    ).rejects.toThrow('temporary cleanup failure');
    await expect(
      terminateExecutorAttempt(
        'session-retry',
        'attempt-retry',
        EXECUTOR_TERMINATION_REASONS.RECONCILIATION
      )
    ).resolves.toBe(EXECUTOR_CLEANUP_STATUS.VERIFIED);
    expect(current.terminate).toHaveBeenCalledTimes(2);
    untrackExecutorAttempt('session-retry', 'attempt-retry');
  });

  it('matches exit safety-net work to the persisted task owner', () => {
    expect(isExecutorAttemptOwner({ executor_attempt_id: 'attempt-2' }, 'attempt-2')).toBe(true);
    expect(isExecutorAttemptOwner({ executor_attempt_id: 'attempt-2' }, 'attempt-1')).toBe(false);
  });
});
