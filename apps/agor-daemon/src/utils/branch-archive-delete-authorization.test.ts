import type { BranchRepository } from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeBranchArchiveDelete,
  consumeBranchArchiveDeleteAuthorization,
} from './branch-archive-delete-authorization';
import { BRANCH_REMOVAL_VISIBILITY_PARAM } from './realtime-publish';

function context(): HookContext {
  return {
    path: '/branches/:id/archive-or-delete',
    method: 'create',
    data: { metadataAction: 'delete', filesystemAction: 'deleted' },
    params: {
      provider: 'mcp',
      route: { id: '00000000-0000-7000-8000-000000000001' },
      user: {
        user_id: '00000000-0000-7000-8000-0000000000ff',
        role: 'member',
      },
    },
  } as unknown as HookContext;
}

describe('authorizeBranchArchiveDelete', () => {
  it('rejects a view-only MCP caller before granting destructive authority', async () => {
    const branch = {
      branch_id: '00000000-0000-7000-8000-000000000001',
      others_can: 'view',
    };
    const findRealtimeVisibilityBranch = vi.fn();
    const branchRepository = {
      findById: vi.fn(async () => branch),
      isOwner: vi.fn(async () => false),
      resolveUserPermission: vi.fn(async () => 'view'),
      findRealtimeVisibilityBranch,
      findExplicitViewUserIds: vi.fn(),
    } as unknown as BranchRepository;
    const hook = context();

    await expect(
      authorizeBranchArchiveDelete(hook, {
        branchRepository,
        branchRbacEnabled: true,
      })
    ).rejects.toBeInstanceOf(Forbidden);

    expect(findRealtimeVisibilityBranch).not.toHaveBeenCalled();
    expect(() =>
      consumeBranchArchiveDeleteAuthorization(hook.params, branch.branch_id as never, 'delete')
    ).toThrow(Forbidden);
  });

  it('captures hard-delete visibility before granting the route capability', async () => {
    const branch = {
      branch_id: '00000000-0000-7000-8000-000000000001',
      others_can: 'none',
    };
    const branchRepository = {
      findById: vi.fn(async () => branch),
      isOwner: vi.fn(async () => true),
      resolveUserPermission: vi.fn(async () => 'all'),
      findRealtimeVisibilityBranch: vi.fn(async () => branch),
      findExplicitViewUserIds: vi.fn(async () => ['00000000-0000-7000-8000-0000000000ff']),
    } as unknown as BranchRepository;
    const hook = context();

    await expect(
      authorizeBranchArchiveDelete(hook, {
        branchRepository,
        branchRbacEnabled: true,
      })
    ).resolves.toBe(hook);

    expect((hook.params as Record<string, unknown>)[BRANCH_REMOVAL_VISIBILITY_PARAM]).toEqual({
      branchId: branch.branch_id,
      mode: 'explicitUsers',
      userIds: ['00000000-0000-7000-8000-0000000000ff'],
    });
    expect(() =>
      consumeBranchArchiveDeleteAuthorization(hook.params, branch.branch_id as never, 'delete')
    ).not.toThrow();
  });
});
