import type { Application, BoardID, BranchID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { BranchesService } from './branches';

function createRenderEnvHarness(opts: {
  current: string | null;
  status: 'running' | 'starting' | 'stopped';
}) {
  const reposGet = vi.fn(async () => ({
    repo_id: 'repo-1',
    slug: 'org/repo',
    environment: {
      version: 2,
      default: 'dev',
      variants: {
        dev: { start: 'echo dev', stop: 'echo stop' },
        e2e: { start: 'echo e2e', stop: 'echo stop' },
      },
    },
  }));
  const app = {
    service(path: string) {
      if (path === 'repos') return { get: reposGet };
      throw new Error(`Unknown service: ${path}`);
    },
  } as unknown as Application;
  const service = new BranchesService({} as never, app);
  // Bypass the auth gate (it would otherwise call loadConfig); the running
  // guard fires after auth and is what we're testing here.
  vi.spyOn(service as never, 'ensureCanTriggerEnv').mockResolvedValue(undefined as never);
  vi.spyOn(service, 'get').mockResolvedValue({
    branch_id: 'wt-1',
    repo_id: 'repo-1',
    name: 'wt-1',
    path: '/tmp/wt-1',
    branch_unique_id: 1,
    environment_variant: opts.current,
    environment_instance: { status: opts.status },
  } as never);
  // patch should NEVER be reached when the guard fires; spying lets the test
  // assert that.
  const patchSpy = vi.spyOn(service, 'patch').mockResolvedValue({} as never);
  return { service, reposGet, patchSpy };
}

function createPatchHarness(opts: {
  current: Record<string, unknown>;
  updated: Record<string, unknown>;
}) {
  const boardObjectsService = {
    find: vi.fn(async () => ({ data: [] })),
    findByBranchId: vi.fn(async () => null),
    create: vi.fn(async () => ({ object_id: 'obj-1' })),
    remove: vi.fn(async () => ({})),
  };
  const boardsService = {
    get: vi.fn(async () => ({ objects: {} })),
    emit: vi.fn(),
  };
  const branchesFindService = {
    find: vi.fn(async () => []),
  };
  const app = {
    service(path: string) {
      if (path === 'board-objects') return boardObjectsService;
      if (path === 'boards') return boardsService;
      if (path === 'branches') return branchesFindService;
      throw new Error(`Unknown service: ${path}`);
    },
  } as unknown as Application;

  const branchId = opts.current.branch_id as BranchID;
  const repository = {
    findById: vi.fn(async () => opts.current),
    update: vi.fn(async () => opts.updated),
    create: vi.fn(),
    findAll: vi.fn(async () => []),
    delete: vi.fn(),
  };
  const boardRepo = {
    clearPrimaryAssistantIfMatches: vi.fn(async () => ({
      board_id: opts.current.board_id,
      primary_assistant_id: undefined,
    })),
    setPrimaryAssistantIfUnset: vi.fn(async () => ({
      board_id: opts.updated.board_id,
      primary_assistant_id: branchId,
    })),
  };
  const service = new BranchesService({} as never, app);
  (service as unknown as { repository: typeof repository }).repository = repository;
  (service as unknown as { boardRepo: typeof boardRepo }).boardRepo = boardRepo;
  (service as unknown as { branchRepo: { enrichWithZoneInfo: typeof vi.fn } }).branchRepo = {
    enrichWithZoneInfo: vi.fn(async (branch) => branch),
  } as never;
  vi.spyOn(service as never, 'computeDefaultBoardPositionForBranch').mockResolvedValue({
    x: 10,
    y: 20,
  });

  return { service, repository, boardRepo, boardObjectsService, boardsService, branchId };
}

const assistantContext = {
  assistant: {
    kind: 'assistant',
    displayName: 'Assistant',
  },
};

function createServiceHarness() {
  const boardObjectsService = {
    find: vi.fn(async () => ({ data: [] })),
    findByBranchId: vi.fn(async () => null),
    create: vi.fn(async () => ({ object_id: 'obj-1' })),
    remove: vi.fn(async () => ({})),
  };

  const sessionsService = {
    find: vi.fn(async () => []),
    patch: vi.fn(async () => ({})),
  };

  const reposService = {
    get: vi.fn(async () => ({ repo_id: 'repo-1', local_path: '/tmp/repo', unix_group: null })),
  };

  const app = {
    service(path: string) {
      if (path === 'board-objects') return boardObjectsService;
      if (path === 'sessions') return sessionsService;
      if (path === 'boards') return { get: vi.fn(async () => ({ objects: {} })) };
      if (path === 'branches') return { find: vi.fn(async () => []) };
      if (path === 'repos') return reposService;
      throw new Error(`Unknown service: ${path}`);
    },
  } as unknown as Application;

  const service = new BranchesService({} as never, app);
  return { service, boardObjectsService, sessionsService };
}

describe('BranchesService.patch primary assistant invariants', () => {
  it('clears the old primary and sets the new board primary when an assistant moves boards', async () => {
    const boardA = 'board-a' as BoardID;
    const boardB = 'board-b' as BoardID;
    const branchId = 'assistant-1' as BranchID;
    const { service, boardRepo, boardObjectsService, boardsService } = createPatchHarness({
      current: {
        branch_id: branchId,
        board_id: boardA,
        custom_context: assistantContext,
      },
      updated: {
        branch_id: branchId,
        board_id: boardB,
        custom_context: assistantContext,
      },
    });

    await service.patch(branchId, { board_id: boardB });

    expect(boardRepo.clearPrimaryAssistantIfMatches).toHaveBeenCalledWith(boardA, branchId);
    expect(boardRepo.setPrimaryAssistantIfUnset).toHaveBeenCalledWith(boardB, branchId);
    expect(boardsService.emit).toHaveBeenCalledWith(
      'patched',
      expect.objectContaining({ board_id: boardA })
    );
    expect(boardsService.emit).toHaveBeenCalledWith(
      'patched',
      expect.objectContaining({ board_id: boardB })
    );
    expect(boardObjectsService.create).toHaveBeenCalledWith({
      board_id: boardB,
      branch_id: branchId,
      position: { x: 10, y: 20 },
    });
  });

  it('clears the primary pointer when an assistant is archived in place', async () => {
    const boardId = 'board-a' as BoardID;
    const branchId = 'assistant-archive' as BranchID;
    const { service, boardRepo } = createPatchHarness({
      current: {
        branch_id: branchId,
        board_id: boardId,
        archived: false,
        custom_context: assistantContext,
      },
      updated: {
        branch_id: branchId,
        board_id: boardId,
        archived: true,
        custom_context: assistantContext,
      },
    });

    await service.patch(branchId, { archived: true });

    expect(boardRepo.clearPrimaryAssistantIfMatches).toHaveBeenCalledWith(boardId, branchId);
    expect(boardRepo.setPrimaryAssistantIfUnset).not.toHaveBeenCalled();
  });

  it('rejects converting a normal branch into an assistant', async () => {
    const boardId = 'board-a' as BoardID;
    const branchId = 'branch-1' as BranchID;
    const { service, repository } = createPatchHarness({
      current: {
        branch_id: branchId,
        board_id: boardId,
        custom_context: {},
      },
      updated: {
        branch_id: branchId,
        board_id: boardId,
        custom_context: assistantContext,
      },
    });

    await expect(service.patch(branchId, { custom_context: assistantContext })).rejects.toThrow(
      /cannot be converted/i
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('rejects converting an assistant into a normal branch', async () => {
    const boardId = 'board-a' as BoardID;
    const branchId = 'assistant-2' as BranchID;
    const { service, repository } = createPatchHarness({
      current: {
        branch_id: branchId,
        board_id: boardId,
        custom_context: assistantContext,
      },
      updated: {
        branch_id: branchId,
        board_id: boardId,
        custom_context: { assistant: null },
      },
    });

    await expect(service.patch(branchId, { custom_context: { assistant: null } })).rejects.toThrow(
      /cannot be converted/i
    );
    expect(repository.update).not.toHaveBeenCalled();
  });
});

describe('BranchesService.unarchive', () => {
  it('preserves existing board_id when options.boardId is not provided', async () => {
    const { service, boardObjectsService, sessionsService } = createServiceHarness();
    const branchId = 'wt-1' as BranchID;
    const existingBoardId = 'board-a' as BoardID;

    vi.spyOn(service, 'get').mockResolvedValue({
      branch_id: branchId,
      name: 'WT 1',
      path: '/tmp',
      archived: true,
      board_id: existingBoardId,
    } as never);
    const patchSpy = vi.spyOn(service, 'patch').mockResolvedValue({
      branch_id: branchId,
      name: 'WT 1',
      path: '/tmp',
      archived: false,
      board_id: existingBoardId,
    } as never);
    vi.spyOn(service as never, 'computeDefaultBoardPositionForBranch').mockResolvedValue({
      x: 111,
      y: 222,
    });

    await service.unarchive(branchId);

    expect(patchSpy).toHaveBeenCalledWith(
      branchId,
      expect.objectContaining({
        archived: false,
        archived_at: undefined,
        archived_by: undefined,
        filesystem_status: undefined,
      }),
      undefined
    );
    expect(patchSpy.mock.calls[0][1]).not.toHaveProperty('board_id');

    expect(boardObjectsService.findByBranchId).toHaveBeenCalledWith(branchId);
    expect(boardObjectsService.create).toHaveBeenCalledWith({
      board_id: existingBoardId,
      branch_id: branchId,
      position: { x: 111, y: 222 },
    });

    expect(sessionsService.find).toHaveBeenCalledTimes(1);
    expect(sessionsService.patch).not.toHaveBeenCalled();
  });

  it('does not create a new board object when one already exists', async () => {
    const { service, boardObjectsService } = createServiceHarness();
    const branchId = 'wt-2' as BranchID;
    const boardId = 'board-b' as BoardID;

    vi.spyOn(service, 'get').mockResolvedValue({
      branch_id: branchId,
      name: 'WT 2',
      path: '/tmp',
      archived: true,
      board_id: boardId,
    } as never);
    vi.spyOn(service, 'patch').mockResolvedValue({
      branch_id: branchId,
      name: 'WT 2',
      path: '/tmp',
      archived: false,
      board_id: boardId,
    } as never);
    boardObjectsService.findByBranchId.mockResolvedValue({ object_id: 'existing' });

    await service.unarchive(branchId);

    expect(boardObjectsService.findByBranchId).toHaveBeenCalledWith(branchId);
    expect(boardObjectsService.create).not.toHaveBeenCalled();
  });

  it('uses explicit options.boardId override for patch and placement', async () => {
    const { service, boardObjectsService } = createServiceHarness();
    const branchId = 'wt-3' as BranchID;
    const oldBoardId = 'board-old' as BoardID;
    const newBoardId = 'board-new' as BoardID;

    vi.spyOn(service, 'get').mockResolvedValue({
      branch_id: branchId,
      name: 'WT 3',
      path: '/tmp',
      archived: true,
      board_id: oldBoardId,
    } as never);
    const patchSpy = vi.spyOn(service, 'patch').mockResolvedValue({
      branch_id: branchId,
      name: 'WT 3',
      path: '/tmp',
      archived: false,
      board_id: newBoardId,
    } as never);
    vi.spyOn(service as never, 'computeDefaultBoardPositionForBranch').mockResolvedValue({
      x: 7,
      y: 8,
    });

    await service.unarchive(branchId, { boardId: newBoardId });

    expect(patchSpy).toHaveBeenCalledWith(
      branchId,
      expect.objectContaining({
        archived: false,
        board_id: newBoardId,
      }),
      undefined
    );
    expect(boardObjectsService.create).toHaveBeenCalledWith({
      board_id: newBoardId,
      branch_id: branchId,
      position: { x: 7, y: 8 },
    });
  });
});

describe('BranchesService.renderEnvironment running-guard', () => {
  it('throws when caller requests a different variant while env is running', async () => {
    const { service, patchSpy } = createRenderEnvHarness({
      current: 'dev',
      status: 'running',
    });

    await expect(service.renderEnvironment('wt-1' as BranchID, { variant: 'e2e' })).rejects.toThrow(
      /Cannot change environment variant to "e2e" while the environment is running/
    );
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('throws when caller requests a different variant while env is starting', async () => {
    const { service, patchSpy } = createRenderEnvHarness({
      current: 'dev',
      status: 'starting',
    });

    await expect(service.renderEnvironment('wt-1' as BranchID, { variant: 'e2e' })).rejects.toThrow(
      /Cannot change environment variant to "e2e" while the environment is starting/
    );
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('error message includes the currently-configured variant for debuggability', async () => {
    const { service } = createRenderEnvHarness({
      current: 'dev',
      status: 'running',
    });

    await expect(service.renderEnvironment('wt-1' as BranchID, { variant: 'e2e' })).rejects.toThrow(
      /currently configured for "dev"/
    );
  });
});
