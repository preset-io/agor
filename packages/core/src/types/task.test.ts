import { describe, expect, it } from 'vitest';
import { isTaskExecuting, TaskStatus } from './task';

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
});
