import { BadRequest, Forbidden } from '@agor/core/feathers';
import { type Task, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeForceFailRoute,
  authorizeTaskTerminalRoute,
  findMatchingUnverifiedTerminationTask,
  rejectRemovedClaudeCliRestart,
} from './register-routes.js';
import { REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE } from './utils/agentic-tool-runtime.js';

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

it('does not apply a stale force-fail target to a later unverified Task', () => {
  const taskA = {
    task_id: 'task-a',
    status: TaskStatus.FAILED,
    termination_request: { requested_at: '2026-01-01T00:00:00.000Z' },
  } as Task;
  const taskB = {
    task_id: 'task-b',
    status: TaskStatus.STOPPING,
    sdk_failure: { termination: 'unverified' },
    termination_request: { requested_at: '2026-01-01T00:01:00.000Z' },
  } as Task;

  expect(
    findMatchingUnverifiedTerminationTask([taskA, taskB], {
      taskId: taskA.task_id,
      terminationRequestedAt: taskA.termination_request!.requested_at,
    })
  ).toBeUndefined();
  expect(
    findMatchingUnverifiedTerminationTask([taskB], {
      taskId: taskB.task_id,
      terminationRequestedAt: '2026-01-01T00:00:59.000Z',
    })
  ).toBeUndefined();
});

describe('force-fail route authorization and request fencing', () => {
  const stopping = {
    task_id: 'task-a',
    status: TaskStatus.STOPPING,
    sdk_failure: { termination: 'unverified' },
    termination_request: { requested_at: '2026-01-01T00:00:00.000Z' },
  } as Task;
  const body = {
    confirmation: 'STOP',
    task_id: stopping.task_id,
    termination_requested_at: stopping.termination_request!.requested_at,
  };

  it('authorizes a branch owner and returns the exact Task epoch', async () => {
    await expect(
      authorizeForceFailRoute({
        session: { branch_id: 'branch-a' as never },
        params: { user: { user_id: 'user-a', role: 'member' } } as never,
        body,
        findActiveTasks: async () => [stopping],
        isBranchOwner: async () => true,
      })
    ).resolves.toMatchObject({
      task: stopping,
      confirmation: 'STOP',
      terminationRequestedAt: stopping.termination_request!.requested_at,
    });
  });

  it('rejects non-owners before loading active Task state', async () => {
    const findActiveTasks = vi.fn().mockResolvedValue([stopping]);
    await expect(
      authorizeForceFailRoute({
        session: { branch_id: 'branch-a' as never },
        params: { user: { user_id: 'user-b', role: 'member' } } as never,
        body,
        findActiveTasks,
        isBranchOwner: async () => false,
      })
    ).rejects.toBeInstanceOf(Forbidden);
    expect(findActiveTasks).not.toHaveBeenCalled();
  });

  it('rejects a stale Task epoch instead of selecting a later unverified Task', async () => {
    const later = {
      ...stopping,
      task_id: 'task-b',
      termination_request: { requested_at: '2026-01-01T00:01:00.000Z' },
    } as Task;
    await expect(
      authorizeForceFailRoute({
        session: { branch_id: 'branch-a' as never },
        params: { user: { user_id: 'admin-a', role: 'admin' } } as never,
        body,
        findActiveTasks: async () => [later],
        isBranchOwner: async () => false,
      })
    ).rejects.toThrow('termination state changed');
  });
});

it('keeps the stale restart endpoint as an explicit removed-runtime tombstone', () => {
  expect(rejectRemovedClaudeCliRestart).toThrow(BadRequest);
  expect(rejectRemovedClaudeCliRestart).toThrow(REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE);
});
