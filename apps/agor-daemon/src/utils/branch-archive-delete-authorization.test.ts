import type { BranchRepository } from '@agor/core/db';
import { BadRequest, Forbidden } from '@agor/core/feathers';
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

const defaultBoardRepository = {
  canManage: vi.fn(async () => false),
  findById: vi.fn(async () => null),
};

describe('authorizeBranchArchiveDelete', () => {
  it.each(['preserved', 'cleaned'])(
    'rejects metadata deletion with %s files before authorization',
    async (filesystemAction) => {
      const hook = context();
      hook.data = { metadataAction: 'delete', filesystemAction };
      const findById = vi.fn();
      await expect(
        authorizeBranchArchiveDelete(hook, {
          branchRepository: { findById } as unknown as BranchRepository,
          boardRepository: defaultBoardRepository,
        })
      ).rejects.toThrow(BadRequest);
      expect(findById).not.toHaveBeenCalled();
    }
  );

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
        boardRepository: defaultBoardRepository,
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
        boardRepository: defaultBoardRepository,
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

  it('allows branch owner to archive their own branch', async () => {
    const branch = {
      branch_id: '018f0000-0000-7000-8000-000000000001',
      primary_owner_user_id: '00000000-0000-7000-8000-0000000000ff',
      board_id: 'board-1',
      others_can: 'none',
    };
    const branchRepository = {
      findById: vi.fn(async () => branch),
      isOwner: vi.fn(async () => true),
      resolveUserPermission: vi.fn(async () => 'all'),
    } as unknown as BranchRepository;
    const hook = context();
    hook.data = { metadataAction: 'archive', filesystemAction: 'preserved' };

    await expect(
      authorizeBranchArchiveDelete(hook, {
        branchRepository,
        boardRepository: defaultBoardRepository,
      })
    ).resolves.toBe(hook);

    expect(() =>
      consumeBranchArchiveDeleteAuthorization(hook.params, branch.branch_id as never, 'archive')
    ).not.toThrow();
  });

  it("allows Board Manager to archive another member's branch on the same board", async () => {
    const branch = {
      branch_id: '018f0000-0000-7000-8000-000000000002',
      primary_owner_user_id: '00000000-0000-7000-8000-000000000001',
      board_id: 'board-1',
      others_can: 'none',
    };
    const branchRepository = {
      findById: vi.fn(async () => branch),
      isOwner: vi.fn(async () => false),
      resolveUserPermission: vi.fn(async () => 'none'),
    } as unknown as BranchRepository;
    const boardRepository = {
      canManage: vi.fn(async (boardId: string, userId: string) => boardId === 'board-1'),
      findById: vi.fn(async () => ({ board_id: 'board-1' })),
    };
    const hook = context();
    hook.data = { metadataAction: 'archive', filesystemAction: 'preserved' };

    await expect(
      authorizeBranchArchiveDelete(hook, {
        branchRepository,
        boardRepository: boardRepository as never,
      })
    ).resolves.toBe(hook);

    expect(boardRepository.canManage).toHaveBeenCalledWith(
      'board-1',
      '00000000-0000-7000-8000-0000000000ff'
    );
    expect(() =>
      consumeBranchArchiveDeleteAuthorization(hook.params, branch.branch_id as never, 'archive')
    ).not.toThrow();
  });

  it("rejects regular member without branch permission from archiving another member's branch on the same board", async () => {
    const branch = {
      branch_id: '018f0000-0000-7000-8000-000000000002',
      primary_owner_user_id: '00000000-0000-7000-8000-000000000001',
      board_id: 'board-1',
      others_can: 'none',
    };
    const branchRepository = {
      findById: vi.fn(async () => branch),
      isOwner: vi.fn(async () => false),
      resolveUserPermission: vi.fn(async () => 'none'),
    } as unknown as BranchRepository;
    const boardRepository = {
      canManage: vi.fn(async () => false),
      findById: vi.fn(async () => ({ board_id: 'board-1' })),
    };
    const hook = context();
    hook.data = { metadataAction: 'archive', filesystemAction: 'preserved' };

    await expect(
      authorizeBranchArchiveDelete(hook, {
        branchRepository,
        boardRepository: boardRepository as never,
      })
    ).rejects.toBeInstanceOf(Forbidden);

    expect(() =>
      consumeBranchArchiveDeleteAuthorization(hook.params, branch.branch_id as never, 'archive')
    ).toThrow(Forbidden);
  });

  it('rejects Board Manager of Board A from archiving a branch on Board B', async () => {
    const branch = {
      branch_id: '018f0000-0000-7000-8000-000000000002',
      primary_owner_user_id: '00000000-0000-7000-8000-000000000001',
      board_id: 'board-b',
      others_can: 'none',
    };
    const branchRepository = {
      findById: vi.fn(async () => branch),
      isOwner: vi.fn(async () => false),
      resolveUserPermission: vi.fn(async () => 'none'),
    } as unknown as BranchRepository;
    const boardRepository = {
      canManage: vi.fn(async (boardId: string) => boardId === 'board-a'),
      findById: vi.fn(async () => ({ board_id: 'board-b' })),
    };
    const hook = context();
    hook.data = { metadataAction: 'archive', filesystemAction: 'preserved' };

    await expect(
      authorizeBranchArchiveDelete(hook, {
        branchRepository,
        boardRepository: boardRepository as never,
      })
    ).rejects.toBeInstanceOf(Forbidden);

    expect(boardRepository.canManage).toHaveBeenCalledWith(
      'board-b',
      '00000000-0000-7000-8000-0000000000ff'
    );
  });

  it('rejects Board Manager from archiving an unattached branch (board_id: null)', async () => {
    const branch = {
      branch_id: '018f0000-0000-7000-8000-000000000002',
      primary_owner_user_id: '00000000-0000-7000-8000-000000000001',
      board_id: null,
      others_can: 'none',
    };
    const branchRepository = {
      findById: vi.fn(async () => branch),
      isOwner: vi.fn(async () => false),
      resolveUserPermission: vi.fn(async () => 'none'),
    } as unknown as BranchRepository;
    const boardRepository = {
      canManage: vi.fn(async () => true),
      findById: vi.fn(async () => ({ board_id: 'board-1' })),
    };
    const hook = context();
    hook.data = { metadataAction: 'archive', filesystemAction: 'preserved' };

    await expect(
      authorizeBranchArchiveDelete(hook, {
        branchRepository,
        boardRepository: boardRepository as never,
      })
    ).rejects.toBeInstanceOf(Forbidden);

    expect(boardRepository.canManage).not.toHaveBeenCalled();
  });

  it("strictly rejects Board Manager from permanently deleting another member's branch", async () => {
    const branch = {
      branch_id: '018f0000-0000-7000-8000-000000000002',
      primary_owner_user_id: '00000000-0000-7000-8000-000000000001',
      board_id: 'board-1',
      others_can: 'none',
    };
    const branchRepository = {
      findById: vi.fn(async () => branch),
      isOwner: vi.fn(async () => false),
      resolveUserPermission: vi.fn(async () => 'none'),
    } as unknown as BranchRepository;
    const boardRepository = {
      canManage: vi.fn(async () => true),
      findById: vi.fn(async () => ({ board_id: 'board-1' })),
    };
    const hook = context();
    hook.data = { metadataAction: 'delete', filesystemAction: 'deleted' };

    await expect(
      authorizeBranchArchiveDelete(hook, {
        branchRepository,
        boardRepository: boardRepository as never,
      })
    ).rejects.toBeInstanceOf(Forbidden);

    // Board admin bypass is NEVER evaluated for permanent deletion
    expect(boardRepository.canManage).not.toHaveBeenCalled();
  });
});
