import {
  EXECUTOR_CLEANUP_STATUS,
  EXECUTOR_STATE_PERSISTENCE_STATUS,
  EXECUTOR_WORKLOAD_KIND,
  TaskStatus,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { persistExecutorSessionState } from './executor-session-state.js';

function makeHarness(ownsFence = true) {
  const task = {
    task_id: 'task-1',
    session_id: 'session-1',
    executor_attempt_id: 'attempt-1',
    status: TaskStatus.COMPLETED,
    executor_finalization: {
      cleanup_status: EXECUTOR_CLEANUP_STATUS.VERIFIED,
      state_persistence_status: EXECUTOR_STATE_PERSISTENCE_STATUS.PENDING,
      cleanup_error: null,
      state_persistence_error: null,
      cleanup_verified_at: '2026-07-14T00:00:00.000Z',
      workload: { kind: EXECUTOR_WORKLOAD_KIND.LOCAL, unix_user: 'executor-user' },
    },
  };
  const tasks = {
    get: vi.fn(async () => task),
    patch: vi.fn(async () => task),
    ownsExecutorFinalizationFence: vi.fn(async () => ownsFence),
  };
  const sessions = {
    get: vi.fn(async () => ({
      session_id: task.session_id,
      branch_id: 'branch-1',
      sdk_session_id: 'sdk-session-1',
      agentic_tool: 'codex',
    })),
  };
  return {
    app: { service: (name: string) => (name === 'tasks' ? tasks : sessions) },
    task,
    tasks,
  };
}

describe('persistExecutorSessionState', () => {
  it('persists and stamps state through the shared ownership-guarded path', async () => {
    const { app, task, tasks } = makeHarness();
    const pushState = vi.fn(async () => 'state-md5');

    await expect(
      persistExecutorSessionState(
        {
          app: app as never,
          db: {} as never,
          taskId: task.task_id,
          executorAttemptId: task.executor_attempt_id,
        },
        {
          pushState,
          resolveBranchPath: vi.fn(async () => '/worktree'),
          resolveExecutorHome: vi.fn(() => '/home/executor-user'),
        }
      )
    ).resolves.toBe(true);

    expect(pushState).toHaveBeenCalledWith(
      expect.objectContaining({
        branchPath: '/worktree',
        executorHomeDir: '/home/executor-user',
        sdkSessionId: 'sdk-session-1',
      })
    );
    expect(tasks.patch).toHaveBeenCalledWith(task.task_id, { session_md5: 'state-md5' }, undefined);
  });

  it('does no persistence after the attempt loses its release fence', async () => {
    const { app, task, tasks } = makeHarness(false);
    const pushState = vi.fn();

    await expect(
      persistExecutorSessionState(
        {
          app: app as never,
          db: {} as never,
          taskId: task.task_id,
          executorAttemptId: task.executor_attempt_id,
        },
        { pushState }
      )
    ).resolves.toBe(false);

    expect(pushState).not.toHaveBeenCalled();
    expect(tasks.patch).not.toHaveBeenCalled();
  });
});
