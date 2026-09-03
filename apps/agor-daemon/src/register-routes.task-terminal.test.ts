import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import { type MCPRuntimeRecovery, type Session, type Task, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeForceFailRoute,
  authorizeMcpReconnectRoute,
  authorizeTaskTerminalRoute,
  findMatchingUnverifiedTerminationTask,
  projectMcpReconnectRecoveryForViewer,
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

describe('MCP reconnect route authorization', () => {
  it('does not distinguish a missing Task from a foreign Task', async () => {
    const foreign = authorizeMcpReconnectRoute(harness('other-user'));
    const missing = authorizeMcpReconnectRoute({
      ...harness(),
      tasksService: { get: vi.fn().mockRejectedValue(new NotFound('missing')) } as never,
    });

    await expect(foreign).rejects.toBeInstanceOf(Forbidden);
    await expect(missing).rejects.toBeInstanceOf(Forbidden);
  });

  it('redacts attached-server topology from a collaborator who created the prompted task', () => {
    const task = {
      task_id: 'task-1',
      session_id: 'session-1',
      created_by: 'collaborator',
    } as Task;
    const recovery = {
      generation: 4,
      message: 'Reconnect affected MCP authority.',
      mcp_server_id: 'private-server-id',
      mcp_server_name: 'Private CRM',
      server_states: [
        {
          mcp_server_id: 'private-server-id',
          name: 'Private CRM',
          code: 'oauth_reauth_required',
          action: 'reauthenticate',
          message: 'Sign in again.',
        },
      ],
    } as MCPRuntimeRecovery;
    const session = { session_id: 'session-1', created_by: 'owner' } as Session;

    const projected = projectMcpReconnectRecoveryForViewer({
      task,
      recovery,
      session,
      params: { user: { user_id: 'collaborator', role: 'member' } } as never,
    });
    expect(projected.mcp_server_id).toBeUndefined();
    expect(projected.mcp_server_name).toBeUndefined();
    expect(projected.server_states).toBeUndefined();
    expect(projected.message).not.toContain('Private CRM');

    expect(
      projectMcpReconnectRecoveryForViewer({
        task,
        recovery,
        session,
        params: { user: { user_id: 'owner', role: 'member' } } as never,
      })
    ).toBe(recovery);
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
    session_id: 'session-a',
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
        session: { session_id: 'session-a' as never, branch_id: 'branch-a' as never },
        params: { user: { user_id: 'user-a', role: 'member' } } as never,
        body,
        findTask: async () => stopping,
        isBranchOwner: async () => true,
      })
    ).resolves.toMatchObject({
      task: stopping,
      confirmation: 'STOP',
      terminationRequestedAt: stopping.termination_request!.requested_at,
    });
  });

  it('rejects non-owners before loading active Task state', async () => {
    const findTask = vi.fn().mockResolvedValue(stopping);
    await expect(
      authorizeForceFailRoute({
        session: { session_id: 'session-a' as never, branch_id: 'branch-a' as never },
        params: { user: { user_id: 'user-b', role: 'member' } } as never,
        body,
        findTask,
        isBranchOwner: async () => false,
      })
    ).rejects.toBeInstanceOf(Forbidden);
    expect(findTask).not.toHaveBeenCalled();
  });

  it('authorizes an administrator without requiring branch ownership', async () => {
    const isBranchOwner = vi.fn().mockResolvedValue(false);
    await expect(
      authorizeForceFailRoute({
        session: { session_id: 'session-a' as never, branch_id: 'branch-a' as never },
        params: { user: { user_id: 'admin-a', role: 'admin' } } as never,
        body,
        findTask: async () => stopping,
        isBranchOwner,
      })
    ).resolves.toMatchObject({ task: stopping });
    expect(isBranchOwner).not.toHaveBeenCalled();
  });

  it('rejects a stale Task epoch instead of selecting a later unverified Task', async () => {
    const later = {
      ...stopping,
      task_id: 'task-b',
      termination_request: { requested_at: '2026-01-01T00:01:00.000Z' },
    } as Task;
    const isBranchOwner = vi.fn().mockResolvedValue(false);
    await expect(
      authorizeForceFailRoute({
        session: { session_id: 'session-a' as never, branch_id: 'branch-a' as never },
        params: { user: { user_id: 'admin-a', role: 'admin' } } as never,
        body,
        findTask: async () => later,
        isBranchOwner,
      })
    ).rejects.toThrow('termination state changed');
    expect(isBranchOwner).not.toHaveBeenCalled();
  });
});

it('keeps the stale restart endpoint as an explicit removed-runtime tombstone', () => {
  expect(rejectRemovedClaudeCliRestart).toThrow(BadRequest);
  expect(rejectRemovedClaudeCliRestart).toThrow(REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE);
});
