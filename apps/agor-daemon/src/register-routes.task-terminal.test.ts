import { readFileSync } from 'node:fs';
import { Forbidden } from '@agor/core/feathers';
import { describe, expect, it, vi } from 'vitest';
import { authorizeTaskTerminalRoute } from './register-routes.js';

function harness(permission: 'view' | 'session' | 'prompt', createdBy = 'user-1') {
  const branch = { branch_id: 'branch-1', others_can: permission };
  return {
    id: 'task-1',
    params: { provider: 'rest', user: { user_id: 'user-1', role: 'member' } } as never,
    branchRbacEnabled: true,
    allowSuperadmin: true,
    tasksService: {
      get: vi.fn().mockResolvedValue({ task_id: 'task-1', session_id: 'session-1' }),
    } as never,
    sessionsService: {
      get: vi.fn().mockResolvedValue({
        session_id: 'session-1',
        branch_id: branch.branch_id,
        created_by: createdBy,
      }),
    } as never,
    branchRepository: {
      findById: vi.fn().mockResolvedValue(branch),
      isOwner: vi.fn().mockResolvedValue(false),
      resolveUserPermission: vi.fn().mockResolvedValue(permission),
    } as never,
  };
}

describe('task complete/fail route authorization', () => {
  it.each([
    ['prompt', 'other-user'],
    ['session', 'user-1'],
  ] as const)('allows %s access for the applicable session', async (permission, createdBy) => {
    await expect(
      authorizeTaskTerminalRoute(harness(permission, createdBy))
    ).resolves.toBeUndefined();
  });

  it.each([
    ['view', 'user-1'],
    ['session', 'other-user'],
  ] as const)('rejects %s access for an unauthorized session', async (permission, createdBy) => {
    await expect(authorizeTaskTerminalRoute(harness(permission, createdBy))).rejects.toBeInstanceOf(
      Forbidden
    );
  });

  it('does not add branch machinery when RBAC is disabled', async () => {
    const input = harness('view');
    input.branchRbacEnabled = false;
    await expect(authorizeTaskTerminalRoute(input)).resolves.toBeUndefined();
    expect(input.tasksService.get).not.toHaveBeenCalled();
  });

  it('internalizes only the authorized complete and fail route writes', () => {
    const source = readFileSync(new URL('./register-routes.ts', import.meta.url), 'utf8');
    expect(source).toContain('tasksService.complete(id, data, { ...params, provider: undefined })');
    expect(source).toContain('tasksService.fail(id, data, { ...params, provider: undefined })');
  });
});
