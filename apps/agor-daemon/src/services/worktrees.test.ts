import type { Application, BoardID, WorktreeID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { WorktreesService } from './worktrees';

function createServiceHarness() {
  const boardObjectsService = {
    find: vi.fn(async () => ({ data: [] })),
    findByWorktreeId: vi.fn(async () => null),
    create: vi.fn(async () => ({ object_id: 'obj-1' })),
    remove: vi.fn(async () => ({})),
  };

  const sessionsService = {
    find: vi.fn(async () => []),
    patch: vi.fn(async () => ({})),
  };

  const app = {
    service(path: string) {
      if (path === 'board-objects') return boardObjectsService;
      if (path === 'sessions') return sessionsService;
      if (path === 'boards') return { get: vi.fn(async () => ({ objects: {} })) };
      if (path === 'worktrees') return { find: vi.fn(async () => []) };
      throw new Error(`Unknown service: ${path}`);
    },
  } as unknown as Application;

  const service = new WorktreesService({} as never, app);
  return { service, boardObjectsService, sessionsService };
}

describe('WorktreesService.unarchive', () => {
  it('preserves existing board_id when options.boardId is not provided', async () => {
    const { service, boardObjectsService, sessionsService } = createServiceHarness();
    const worktreeId = 'wt-1' as WorktreeID;
    const existingBoardId = 'board-a' as BoardID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: worktreeId,
      name: 'WT 1',
      archived: true,
      board_id: existingBoardId,
    } as never);
    const patchSpy = vi.spyOn(service, 'patch').mockResolvedValue({
      worktree_id: worktreeId,
      name: 'WT 1',
      archived: false,
      board_id: existingBoardId,
    } as never);
    vi.spyOn(service as never, 'computeDefaultBoardPositionForWorktree').mockResolvedValue({
      x: 111,
      y: 222,
    });

    await service.unarchive(worktreeId);

    expect(patchSpy).toHaveBeenCalledWith(
      worktreeId,
      expect.objectContaining({
        archived: false,
        archived_at: undefined,
        archived_by: undefined,
        filesystem_status: undefined,
      }),
      undefined
    );
    expect(patchSpy.mock.calls[0][1]).not.toHaveProperty('board_id');

    expect(boardObjectsService.findByWorktreeId).toHaveBeenCalledWith(worktreeId);
    expect(boardObjectsService.create).toHaveBeenCalledWith({
      board_id: existingBoardId,
      worktree_id: worktreeId,
      position: { x: 111, y: 222 },
    });

    expect(sessionsService.find).toHaveBeenCalledTimes(1);
    expect(sessionsService.patch).not.toHaveBeenCalled();
  });

  it('does not create a new board object when one already exists', async () => {
    const { service, boardObjectsService } = createServiceHarness();
    const worktreeId = 'wt-2' as WorktreeID;
    const boardId = 'board-b' as BoardID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: worktreeId,
      name: 'WT 2',
      archived: true,
      board_id: boardId,
    } as never);
    vi.spyOn(service, 'patch').mockResolvedValue({
      worktree_id: worktreeId,
      name: 'WT 2',
      archived: false,
      board_id: boardId,
    } as never);
    boardObjectsService.findByWorktreeId.mockResolvedValue({ object_id: 'existing' });

    await service.unarchive(worktreeId);

    expect(boardObjectsService.findByWorktreeId).toHaveBeenCalledWith(worktreeId);
    expect(boardObjectsService.create).not.toHaveBeenCalled();
  });

  it('uses explicit options.boardId override for patch and placement', async () => {
    const { service, boardObjectsService } = createServiceHarness();
    const worktreeId = 'wt-3' as WorktreeID;
    const oldBoardId = 'board-old' as BoardID;
    const newBoardId = 'board-new' as BoardID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: worktreeId,
      name: 'WT 3',
      archived: true,
      board_id: oldBoardId,
    } as never);
    const patchSpy = vi.spyOn(service, 'patch').mockResolvedValue({
      worktree_id: worktreeId,
      name: 'WT 3',
      archived: false,
      board_id: newBoardId,
    } as never);
    vi.spyOn(service as never, 'computeDefaultBoardPositionForWorktree').mockResolvedValue({
      x: 7,
      y: 8,
    });

    await service.unarchive(worktreeId, { boardId: newBoardId });

    expect(patchSpy).toHaveBeenCalledWith(
      worktreeId,
      expect.objectContaining({
        archived: false,
        board_id: newBoardId,
      }),
      undefined
    );
    expect(boardObjectsService.create).toHaveBeenCalledWith({
      board_id: newBoardId,
      worktree_id: worktreeId,
      position: { x: 7, y: 8 },
    });
  });
});
