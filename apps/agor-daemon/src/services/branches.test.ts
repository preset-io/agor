import { BranchRepository, GroupRepository, RepoRepository, UsersRepository } from '@agor/core/db';
import type { Application, BoardID, BranchID, UUID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
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

function createFindHarness(opts: {
  branches: Array<Record<string, unknown>>;
  branchIdsInZone: BranchID[];
}) {
  const app = {
    service(path: string) {
      throw new Error(`Unknown service: ${path}`);
    },
  } as unknown as Application;
  const repository = {
    findAll: vi.fn(async () => opts.branches),
    findById: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };
  const branchRepo = {
    findBranchIdsByZone: vi.fn(async () => opts.branchIdsInZone),
    enrichManyWithZoneInfo: vi.fn(async (branches: Array<Record<string, unknown>>) =>
      branches.map((branch: Record<string, unknown>) => ({
        ...branch,
        zone_id: opts.branchIdsInZone.includes(branch.branch_id as BranchID)
          ? 'zone-review'
          : undefined,
      }))
    ),
  };
  const service = new BranchesService({} as never, app);
  (service as unknown as { repository: typeof repository }).repository = repository;
  (service as unknown as { branchRepo: typeof branchRepo }).branchRepo = branchRepo;

  return { service, repository, branchRepo };
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

describe('BranchesService.find zone filtering', () => {
  it('applies zone_id before pagination', async () => {
    const branch1 = { branch_id: 'branch-1', name: 'outside', board_id: 'board-1' };
    const branch2 = { branch_id: 'branch-2', name: 'inside-a', board_id: 'board-1' };
    const branch3 = { branch_id: 'branch-3', name: 'inside-b', board_id: 'board-1' };
    const { service, branchRepo } = createFindHarness({
      branches: [branch1, branch2, branch3],
      branchIdsInZone: ['branch-2' as BranchID, 'branch-3' as BranchID],
    });

    const result = (await service.find({
      query: { zone_id: 'zone-review', $limit: 1 },
    })) as { data: Array<Record<string, unknown>>; total: number; limit: number; skip: number };

    expect(branchRepo.findBranchIdsByZone).toHaveBeenCalledWith('zone-review');
    expect(result.total).toBe(2);
    expect(result.limit).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].branch_id).toBe('branch-2');
    expect(result.data[0].zone_id).toBe('zone-review');
  });

  it('intersects zone_id filtering with existing branch_id scoping', async () => {
    const branch1 = { branch_id: 'branch-1', name: 'outside', board_id: 'board-1' };
    const branch2 = { branch_id: 'branch-2', name: 'inside-a', board_id: 'board-1' };
    const branch3 = { branch_id: 'branch-3', name: 'inside-b', board_id: 'board-1' };
    const { service } = createFindHarness({
      branches: [branch1, branch2, branch3],
      branchIdsInZone: ['branch-2' as BranchID, 'branch-3' as BranchID],
    });

    const result = (await service.find({
      query: {
        zone_id: 'zone-review',
        branch_id: { $in: ['branch-3' as BranchID] },
      },
    })) as { data: Array<Record<string, unknown>>; total: number };

    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].branch_id).toBe('branch-3');
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

describe('BranchesService managed environment control authorization', () => {
  const branchId = 'wt-auth' as BranchID;
  const allUserId = 'user-all';
  const otherId = 'user-other';

  function paramsFor(
    user_id: string,
    role: 'viewer' | 'member' | 'admin' | 'superadmin' = 'member'
  ) {
    return {
      provider: 'rest',
      user: { user_id, role },
    } as never;
  }

  function createAuthHarness(
    effectivePermission: 'all' | 'prompt' | 'session' | 'view' = 'session'
  ) {
    const { service } = createServiceHarness();
    const branch = {
      branch_id: branchId,
      repo_id: 'repo-1',
      name: 'wt-auth',
      path: '/tmp/wt-auth',
      branch_unique_id: 1,
      environment_instance: { status: 'stopped' },
    };
    const branchRepo = {
      findById: vi.fn(async () => branch),
      resolveUserPermission: vi.fn(async () => effectivePermission),
    };
    (service as unknown as { branchRepo: typeof branchRepo }).branchRepo = branchRepo;
    const getSpy = vi.spyOn(service, 'get').mockResolvedValue(branch as never);
    return { service, branchRepo, getSpy };
  }

  it('denies non-owner members before starting an environment', async () => {
    const { service, getSpy } = createAuthHarness('session');

    await expect(service.startEnvironment(branchId, paramsFor(otherId, 'member'))).rejects.toThrow(
      /'all' branch permission or admin access/
    );
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('allows users with effective all permission through the control gate', async () => {
    const { service } = createAuthHarness('all');

    await expect(
      service.startEnvironment(branchId, paramsFor(allUserId, 'member'))
    ).rejects.toThrow(/No start command configured/);
  });

  it('allows admins and superadmins through the control gate', async () => {
    const adminHarness = createAuthHarness('session');
    await expect(
      adminHarness.service.startEnvironment(branchId, paramsFor(otherId, 'admin'))
    ).rejects.toThrow(/No start command configured/);
    expect(adminHarness.branchRepo.findById).not.toHaveBeenCalled();

    const superHarness = createAuthHarness('session');
    await expect(
      superHarness.service.startEnvironment(branchId, paramsFor(otherId, 'superadmin'))
    ).rejects.toThrow(/No start command configured/);
    expect(superHarness.branchRepo.findById).not.toHaveBeenCalled();
  });

  it('denies non-owner members before rendering environment commands', async () => {
    const { service, getSpy } = createAuthHarness('session');

    await expect(
      service.renderEnvironment(branchId, { variant: 'dev' }, paramsFor(otherId, 'member'))
    ).rejects.toThrow(/'all' branch permission or admin access/);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('allows users with effective all permission through the render control gate', async () => {
    const { service } = createAuthHarness('all');

    await expect(
      service.renderEnvironment(branchId, { variant: 'dev' }, paramsFor(allUserId, 'member'))
    ).rejects.toThrow(/Repo has no v2 environment config/);
  });

  it('keeps health checks available without the control gate', async () => {
    const { service, branchRepo } = createAuthHarness('session');

    await expect(
      service.checkHealth(branchId, paramsFor(otherId, 'viewer'))
    ).resolves.toMatchObject({
      branch_id: branchId,
    });
    expect(branchRepo.findById).not.toHaveBeenCalled();
  });

  dbTest('allows a group grant with effective all to start/stop environments', async ({ db }) => {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const branches = new BranchRepository(db);
    const groups = new GroupRepository(db);

    const owner = await users.create({
      email: 'env-owner@example.com',
      name: 'Env Owner',
      role: 'member',
    });
    const member = await users.create({
      email: 'env-group-all@example.com',
      name: 'Env Group All',
      role: 'member',
    });
    const repo = await repos.create({
      name: 'env-rbac-repo',
      slug: 'env-rbac-repo',
      repo_type: 'local',
      local_path: '/tmp/env-rbac-repo',
      default_branch: 'main',
    });
    const branch = await branches.create({
      branch_id: '019f0000-0000-7000-8000-00000000e001' as BranchID,
      repo_id: repo.repo_id,
      name: 'env-group-all',
      ref: 'env-group-all',
      path: '/tmp/env-rbac-repo/env-group-all',
      created_by: owner.user_id as UUID,
      branch_unique_id: 9001,
      new_branch: true,
      others_can: 'none',
    });
    const group = await groups.create({ name: 'Env Controllers', created_by: owner.user_id });
    await groups.addMember(group.group_id, member.user_id, owner.user_id);
    await groups.upsertBranchGrant({
      branch_id: branch.branch_id,
      group_id: group.group_id,
      can: 'all',
      created_by: owner.user_id,
    });

    const service = new BranchesService(db, { service: vi.fn() } as unknown as Application);
    const getSpy = vi.spyOn(service, 'get').mockResolvedValue(branch as never);
    const updateEnvironmentSpy = vi
      .spyOn(service, 'updateEnvironment')
      .mockResolvedValue(branch as never);

    await expect(
      service.startEnvironment(branch.branch_id, paramsFor(member.user_id, 'member'))
    ).rejects.toThrow(/No start command configured/);
    expect(getSpy).toHaveBeenCalled();

    getSpy.mockClear();
    await expect(
      service.stopEnvironment(branch.branch_id, paramsFor(member.user_id, 'member'))
    ).resolves.toMatchObject({ branch_id: branch.branch_id });
    expect(getSpy).toHaveBeenCalled();
    expect(updateEnvironmentSpy).toHaveBeenCalled();
  });

  dbTest('allows direct owners to start environments', async ({ db }) => {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const branches = new BranchRepository(db);

    const owner = await users.create({
      email: 'env-direct-owner@example.com',
      name: 'Env Direct Owner',
      role: 'member',
    });
    const repo = await repos.create({
      name: 'env-direct-owner-repo',
      slug: 'env-direct-owner-repo',
      repo_type: 'local',
      local_path: '/tmp/env-direct-owner-repo',
      default_branch: 'main',
    });
    const branch = await branches.create({
      branch_id: '019f0000-0000-7000-8000-00000000e002' as BranchID,
      repo_id: repo.repo_id,
      name: 'env-direct-owner',
      ref: 'env-direct-owner',
      path: '/tmp/env-direct-owner-repo/env-direct-owner',
      created_by: owner.user_id as UUID,
      branch_unique_id: 9002,
      new_branch: true,
      others_can: 'none',
    });
    await branches.addOwner(branch.branch_id, owner.user_id as UUID);

    const service = new BranchesService(db, { service: vi.fn() } as unknown as Application);
    vi.spyOn(service, 'get').mockResolvedValue(branch as never);

    await expect(
      service.startEnvironment(branch.branch_id, paramsFor(owner.user_id, 'member'))
    ).rejects.toThrow(/No start command configured/);
  });

  dbTest('rejects insufficient group grants before environment actions run', async ({ db }) => {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const branches = new BranchRepository(db);
    const groups = new GroupRepository(db);

    const owner = await users.create({
      email: 'env-owner-view@example.com',
      name: 'Env Owner View',
      role: 'member',
    });
    const member = await users.create({
      email: 'env-group-view@example.com',
      name: 'Env Group View',
      role: 'member',
    });
    const repo = await repos.create({
      name: 'env-rbac-view-repo',
      slug: 'env-rbac-view-repo',
      repo_type: 'local',
      local_path: '/tmp/env-rbac-view-repo',
      default_branch: 'main',
    });
    const branch = await branches.create({
      branch_id: '019f0000-0000-7000-8000-00000000e003' as BranchID,
      repo_id: repo.repo_id,
      name: 'env-group-view',
      ref: 'env-group-view',
      path: '/tmp/env-rbac-view-repo/env-group-view',
      created_by: owner.user_id as UUID,
      branch_unique_id: 9003,
      new_branch: true,
      others_can: 'none',
    });
    const group = await groups.create({ name: 'Env Viewers', created_by: owner.user_id });
    await groups.addMember(group.group_id, member.user_id, owner.user_id);
    await groups.upsertBranchGrant({
      branch_id: branch.branch_id,
      group_id: group.group_id,
      can: 'prompt',
      created_by: owner.user_id,
    });

    const service = new BranchesService(db, { service: vi.fn() } as unknown as Application);
    const getSpy = vi.spyOn(service, 'get').mockResolvedValue(branch as never);

    await expect(
      service.startEnvironment(branch.branch_id, paramsFor(member.user_id, 'member'))
    ).rejects.toThrow(/'all' branch permission or admin access/);
    expect(getSpy).not.toHaveBeenCalled();
  });
});
