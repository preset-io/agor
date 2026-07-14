import { SessionStatus } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { sessionCanStartTask } from './session-task-state';

describe('session task state reconciliation', () => {
  it('allows failed sessions explicitly marked ready to start a task', () => {
    expect(sessionCanStartTask(SessionStatus.FAILED, true)).toBe(true);
    expect(sessionCanStartTask(SessionStatus.FAILED, false)).toBe(false);
  });

  it('keeps failed sessions fenced until an explicit finalizer releases them', () => {
    expect(sessionCanStartTask(SessionStatus.FAILED, false)).toBe(false);
  });
});
