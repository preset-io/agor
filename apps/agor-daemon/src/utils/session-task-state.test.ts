import { type Session, SessionStatus, type Task, TaskStatus } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { sessionCanStartTask, shouldReconcileSessionPromptState } from './session-task-state';

const baseSession = {
  session_id: '018f0000-0000-7000-8000-000000000001',
  status: SessionStatus.FAILED,
  ready_for_prompt: false,
} as Session;

function task(status: Task['status']): Task {
  return {
    task_id: `018f0000-0000-7000-8000-0000000000${status.length}`,
    session_id: baseSession.session_id,
    status,
  } as Task;
}

describe('session task state reconciliation', () => {
  it('allows failed sessions explicitly marked ready to start a task', () => {
    expect(sessionCanStartTask(SessionStatus.FAILED, true)).toBe(true);
    expect(sessionCanStartTask(SessionStatus.FAILED, false)).toBe(false);
  });

  it('repairs failed/not-ready sessions when all non-queued tasks are terminal', () => {
    expect(
      shouldReconcileSessionPromptState(baseSession, [
        task(TaskStatus.COMPLETED),
        task(TaskStatus.STOPPED),
        task(TaskStatus.QUEUED),
      ])
    ).toBe(true);
  });

  it('does not repair while a non-terminal task still owns the session turn', () => {
    expect(
      shouldReconcileSessionPromptState(baseSession, [
        task(TaskStatus.COMPLETED),
        task(TaskStatus.RUNNING),
        task(TaskStatus.QUEUED),
      ])
    ).toBe(false);
  });

  it('can ignore a just-created task that is about to own the session turn', () => {
    const createdTask = task(TaskStatus.CREATED);

    expect(shouldReconcileSessionPromptState(baseSession, [createdTask])).toBe(false);
    expect(
      shouldReconcileSessionPromptState(baseSession, [createdTask], {
        ignoredTaskIds: [createdTask.task_id],
      })
    ).toBe(true);
  });
});
