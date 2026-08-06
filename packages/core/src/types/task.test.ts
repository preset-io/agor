import { describe, expect, it } from 'vitest';
import {
  isTaskExecuting,
  isTaskPendingDispatch,
  NONTERMINAL_TASK_STATUSES,
  TaskStatus,
  TERMINAL_TASK_STATUSES,
} from './task';

describe('task execution helpers', () => {
  it('identifies only states that still need a daemon dispatch claim', () => {
    expect(isTaskPendingDispatch({ status: TaskStatus.CREATED })).toBe(true);
    expect(isTaskPendingDispatch({ status: TaskStatus.QUEUED })).toBe(true);
    expect(isTaskPendingDispatch({ status: TaskStatus.DISPATCHING })).toBe(false);
    expect(isTaskPendingDispatch({ status: TaskStatus.RUNNING })).toBe(false);
    expect(isTaskPendingDispatch({ status: TaskStatus.COMPLETED })).toBe(false);
    expect(isTaskPendingDispatch({ status: TaskStatus.FAILED })).toBe(false);
  });

  it('keeps terminal and nonterminal status collections exhaustive and disjoint', () => {
    expect(
      [...NONTERMINAL_TASK_STATUSES].filter((status) => TERMINAL_TASK_STATUSES.has(status))
    ).toEqual([]);
    expect([...NONTERMINAL_TASK_STATUSES, ...TERMINAL_TASK_STATUSES].sort()).toEqual(
      Object.values(TaskStatus).sort()
    );
  });

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
});
