import type { BranchRepository } from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeBranchArchiveDelete,
  consumeBranchArchiveDeleteAuthorization,
} from './branch-archive-delete-authorization';

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
      findRealtimeViewUserIds: vi.fn(),
    } as unknown as BranchRepository;
    const hook = context();

    await expect(
      authorizeBranchArchiveDelete(hook, {
        branchRepository,
      })
    ).rejects.toBeInstanceOf(Forbidden);

    expect(findRealtimeVisibilityBranch).not.toHaveBeenCalled();
    expect(() =>
      consumeBranchArchiveDeleteAuthorization(hook.params, branch.branch_id as never, 'delete')
    ).toThrow(Forbidden);
  });

  it('canonicalizes a short route ID before granting authority without capturing visibility', async () => {
    const branch = {
      branch_id: '018f0000-0000-7000-8000-000000000001',
      others_can: 'none',
    };
    const findRealtimeVisibilityBranch = vi.fn();
    const findRealtimeViewUserIds = vi.fn();
    const branchRepository = {
      findById: vi.fn(async () => branch),
      isOwner: vi.fn(async () => true),
      resolveUserPermission: vi.fn(async () => 'all'),
      findRealtimeVisibilityBranch,
      findRealtimeViewUserIds,
    } as unknown as BranchRepository;
    const hook = context();
    hook.params.route = { id: '018F0000' };

    await expect(
      authorizeBranchArchiveDelete(hook, {
        branchRepository,
      })
    ).resolves.toBe(hook);

    expect(branchRepository.findById).toHaveBeenCalledWith('018F0000');
    expect(hook.params.route?.id).toBe(branch.branch_id);
    expect(findRealtimeVisibilityBranch).not.toHaveBeenCalled();
    expect(findRealtimeViewUserIds).not.toHaveBeenCalled();
    expect(() =>
      consumeBranchArchiveDeleteAuthorization(hook.params, branch.branch_id as never, 'delete')
    ).not.toThrow();
  });
});
