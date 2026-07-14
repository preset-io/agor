import { describe, expect, it } from 'vitest';
import {
  EXECUTOR_CLEANUP_STATUS,
  EXECUTOR_FINALIZABLE_TASK_STATUSES,
  EXECUTOR_STATE_PERSISTENCE_STATUS,
  isExecutorFinalizationReleasable,
  isTaskExecuting,
  normalizeTerminalTaskPatch,
  TaskStatus,
} from './task';

describe('task execution helpers', () => {
  it('identifies executor-owned task states', () => {
    expect(isTaskExecuting({ status: TaskStatus.DISPATCHING })).toBe(true);
    expect(isTaskExecuting({ status: TaskStatus.RUNNING })).toBe(true);
    expect(isTaskExecuting({ status: TaskStatus.STOPPING })).toBe(true);
    expect(isTaskExecuting({ status: TaskStatus.AWAITING_PERMISSION })).toBe(true);
    expect(isTaskExecuting({ status: TaskStatus.AWAITING_INPUT })).toBe(true);
  });

  it('excludes queued, pre-dispatch, and terminal task states', () => {
    expect(isTaskExecuting({ status: TaskStatus.QUEUED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.CREATED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.COMPLETED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.FAILED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.STOPPED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.TIMED_OUT })).toBe(false);
  });

  it('requires cleanup for every executor terminal outcome, including timeouts', () => {
    for (const status of [
      TaskStatus.COMPLETED,
      TaskStatus.FAILED,
      TaskStatus.STOPPED,
      TaskStatus.TIMED_OUT,
    ]) {
      expect(EXECUTOR_FINALIZABLE_TASK_STATUSES.has(status)).toBe(true);
    }
  });
});

describe('executor finalization evidence', () => {
  it.each([
    [EXECUTOR_CLEANUP_STATUS.VERIFIED, EXECUTOR_STATE_PERSISTENCE_STATUS.VERIFIED, true],
    [EXECUTOR_CLEANUP_STATUS.VERIFIED, EXECUTOR_STATE_PERSISTENCE_STATUS.SKIPPED, true],
    [EXECUTOR_CLEANUP_STATUS.VERIFIED, EXECUTOR_STATE_PERSISTENCE_STATUS.PENDING, false],
    [EXECUTOR_CLEANUP_STATUS.VERIFIED, EXECUTOR_STATE_PERSISTENCE_STATUS.FAILED, false],
    [EXECUTOR_CLEANUP_STATUS.UNRESOLVED, EXECUTOR_STATE_PERSISTENCE_STATUS.SKIPPED, false],
  ] as const)('cleanup=%s state=%s releases=%s', (cleanup_status, state_persistence_status, expected) => {
    expect(isExecutorFinalizationReleasable({ cleanup_status, state_persistence_status })).toBe(
      expected
    );
  });
});

describe('normalizeTerminalTaskPatch', () => {
  const current = {
    status: TaskStatus.RUNNING,
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: '2026-01-01T00:00:01.000Z',
    message_range: {
      start_index: 0,
      end_index: 1,
      start_timestamp: '2026-01-01T00:00:01.000Z',
      end_timestamp: '2026-01-01T00:00:01.000Z',
    },
  } as Parameters<typeof normalizeTerminalTaskPatch>[0];

  it('adds terminal timing without overwriting a meaningful message end', () => {
    const completedAt = '2026-01-01T00:00:05.000Z';
    expect(
      normalizeTerminalTaskPatch(current, {
        status: TaskStatus.COMPLETED,
        completed_at: completedAt,
      })
    ).toMatchObject({
      completed_at: completedAt,
      duration_ms: 4000,
      message_range: { end_timestamp: completedAt },
    });

    expect(
      normalizeTerminalTaskPatch(
        {
          ...current,
          message_range: { ...current.message_range!, end_timestamp: '2026-01-01T00:00:04.000Z' },
        },
        { status: TaskStatus.COMPLETED, completed_at: completedAt }
      )
    ).not.toHaveProperty('message_range');
  });
});
