import { Forbidden } from '@agor/core/feathers';
import { type Task, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { authorizeTaskTerminalRoute, findUnverifiedTerminationTask } from './register-routes.js';

function harness(createdBy = 'user-1', role = 'member') {
  return {
    id: 'task-1',
    params: { provider: 'rest', user: { user_id: 'user-1', role } } as never,
    tasksService: {
      get: vi.fn().mockResolvedValue({
        task_id: 'task-1',
        session_id: 'session-1',
        created_by: createdBy,
      }),
    } as never,
  };
}

describe('task complete/fail route authorization', () => {
  it('allows the task creator', async () => {
    await expect(authorizeTaskTerminalRoute(harness())).resolves.toMatchObject({
      provider: undefined,
    });
  });

  it('rejects another member', async () => {
    await expect(authorizeTaskTerminalRoute(harness('other-user'))).rejects.toBeInstanceOf(
      Forbidden
    );
  });

  it("allows admins to settle another user's task", async () => {
    await expect(authorizeTaskTerminalRoute(harness('other-user', 'admin'))).resolves.toMatchObject(
      {
        provider: undefined,
      }
    );
  });
});

it('selects the unverified active task even when newer queued work exists', () => {
  const stopping = {
    task_id: 'task-stopping',
    status: TaskStatus.STOPPING,
    sdk_failure: { termination: 'unverified' },
  } as Task;
  const queued = { task_id: 'task-queued', status: TaskStatus.QUEUED } as Task;

  expect(findUnverifiedTerminationTask([queued, stopping])).toBe(stopping);
});
