import { EnvironmentRetirementConflictError } from '@agor/core/db';
import type { Application } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReposService } from './repos';

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    ensureBranchStorageModeAllowed: vi.fn(),
    resolveBranchStorageConfig: vi.fn(() => ({
      defaultMode: 'worktree',
      allowedModes: ['worktree', 'clone'],
    })),
    resolveExecutionSecurityMode: vi.fn(() => ({
      appRbacEnabled: true,
      unixUserMode: 'simple',
      requiresExecutionHomeKey: false,
    })),
    resolveMultiTenancyConfig: vi.fn(() => ({ mode: 'disabled' })),
  };
});

const repositoryMocks = vi.hoisted(() => ({
  deleteRepo: vi.fn(),
  findAllBranchesByRepoId: vi.fn(),
  lockRepoForBranchInventory: vi.fn(),
  claimRepoDeletionAttempt: vi.fn(),
  requireRepoDeletionAttempt: vi.fn(),
  assertBranchRetirementReady: vi.fn(),
  hasNonterminalForBranch: vi.fn(),
  resolveBranchUserAccess: vi.fn(),
  resolveBoardAccess: vi.fn(),
}));

vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();

  return {
    ...actual,
    BranchRepository: vi.fn().mockImplementation(function BranchRepository() {
      return {
        findActiveByRepoAndName: vi.fn(async () => null),
        findAllByRepoId: repositoryMocks.findAllBranchesByRepoId,
        getAllUsedUniqueIds: vi.fn(async () => []),
        addOwner: vi.fn(async () => undefined),
        assertRetirementReadyInTransaction: repositoryMocks.assertBranchRetirementReady,
        resolveUserAccess: repositoryMocks.resolveBranchUserAccess,
      };
    }),
    RepoRepository: vi.fn().mockImplementation(function RepoRepository() {
      return {
        create: vi.fn(),
        findById: vi.fn(),
        findAll: vi.fn(async () => []),
        update: vi.fn(),
        delete: repositoryMocks.deleteRepo,
        findBySlug: vi.fn(),
        lockForBranchInventory: repositoryMocks.lockRepoForBranchInventory,
        claimDeletionAttemptLocked: repositoryMocks.claimRepoDeletionAttempt,
        requireDeletionAttemptLocked: repositoryMocks.requireRepoDeletionAttempt,
      };
    }),
    TaskRepository: vi.fn().mockImplementation(function TaskRepository() {
      return { hasNonterminalForBranch: repositoryMocks.hasNonterminalForBranch };
    }),
    CapabilityPolicyRepository: vi.fn().mockImplementation(function CapabilityPolicyRepository() {
      return { resolveBoardAccess: repositoryMocks.resolveBoardAccess };
    }),
  };
});

const executorMocks = vi.hoisted(() => ({
  requestExecutor: vi.fn(),
  spawnExecutorFireAndForget: vi.fn(),
}));
const delegatedHomeMocks = vi.hoisted(() => ({ resolve: vi.fn(async () => undefined) }));
const tenantScopeMocks = vi.hoisted(() => {
  const withFreshTenantWrite = vi.fn(
    async (_db: unknown, _tenantId: string, work: () => Promise<unknown>) => work()
  );
  return { withFreshTenantWrite };
});
vi.mock('../utils/executor-delegated-home.js', () => ({
  resolveDelegatedExecutionHomeKey: delegatedHomeMocks.resolve,
}));
vi.mock('../utils/tenant-db-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/tenant-db-scope.js')>()),
  withFreshTenantWrite: tenantScopeMocks.withFreshTenantWrite,
}));
vi.mock('../utils/spawn-executor.js', () => {
  return {
    requestExecutor: executorMocks.requestExecutor,
    getDaemonUrl: vi.fn(() => 'http://daemon'),
    spawnExecutorFireAndForget: executorMocks.spawnExecutorFireAndForget,
  };
});

beforeEach(() => {
  tenantScopeMocks.withFreshTenantWrite.mockClear();
  executorMocks.requestExecutor.mockReset();
  executorMocks.spawnExecutorFireAndForget.mockReset();
  delegatedHomeMocks.resolve.mockReset().mockResolvedValue(undefined);
  repositoryMocks.resolveBranchUserAccess.mockReset().mockResolvedValue({
    can: 'all',
    fs_access: 'write',
    is_owner: false,
    source: 'direct',
  });
  repositoryMocks.assertBranchRetirementReady.mockReset().mockResolvedValue(undefined);
  repositoryMocks.hasNonterminalForBranch.mockReset().mockResolvedValue(false);
  repositoryMocks.claimRepoDeletionAttempt.mockReset().mockResolvedValue(undefined);
  repositoryMocks.requireRepoDeletionAttempt.mockReset().mockResolvedValue(undefined);
  repositoryMocks.resolveBoardAccess.mockReset().mockResolvedValue({
    capabilities: ['board.view', 'board.attach_branch'],
  });
});

describe('ReposService .agor.yml normalized branch access', () => {
  const repo = {
    repo_id: '550e8400-e29b-41d4-a716-446655440001',
    slug: 'preset-io/agor',
  };
  const branch = {
    branch_id: '550e8400-e29b-41d4-a716-446655440002',
    repo_id: repo.repo_id,
    name: 'rbac-remodel',
    path: '/managed/worktrees/preset-io/agor/rbac-remodel',
  };
  const user = {
    user_id: '550e8400-e29b-41d4-a716-446655440004',
    role: 'admin' as const,
  };

  function service() {
    return new ReposService(
      {} as never,
      {
        get: () => ({}),
        service: vi.fn(),
        sessionTokenService: {
          generateCommandToken: vi.fn(async () => 'delegated-user-token'),
        },
      } as unknown as Application
    );
  }

  it.each([
    {
      command: 'branch.agor-yml.import' as const,
      access: { can: 'view' as const, fs_access: 'read' as const },
    },
    {
      command: 'branch.agor-yml.export' as const,
      access: { can: 'session' as const, fs_access: 'write' as const },
    },
  ])('passes normalized access to $command', async ({ command, access }) => {
    repositoryMocks.resolveBranchUserAccess.mockResolvedValue({
      ...access,
      is_owner: false,
      source: 'direct',
    });
    executorMocks.requestExecutor.mockResolvedValue({ success: true, data: {} });
    const instance = service();

    await (
      instance as unknown as {
        runAgorYmlExecutorCommand(
          repo: typeof repo,
          branch: typeof branch,
          command: typeof command,
          params: Record<string, unknown>,
          serviceParams: unknown
        ): Promise<unknown>;
      }
    ).runAgorYmlExecutorCommand(repo, branch, command, {}, { user });

    expect(executorMocks.requestExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        command,
        params: expect.objectContaining({
          cwd: branch.path,
          principalBranchAccess: access.fs_access,
        }),
      }),
      expect.objectContaining({
        templateVariables: {
          branch_id: branch.branch_id,
          user_id: user.user_id,
          branch_fs_access: access.fs_access,
        },
      })
    );
  });

  it('fails export closed when write access is missing', async () => {
    repositoryMocks.resolveBranchUserAccess.mockResolvedValue({
      can: 'session',
      fs_access: 'read',
      is_owner: false,
      source: 'direct',
    });
    const instance = service();

    await expect(
      (
        instance as unknown as {
          runAgorYmlExecutorCommand(
            repo: typeof repo,
            branch: typeof branch,
            command: 'branch.agor-yml.export',
            params: Record<string, unknown>,
            serviceParams: unknown
          ): Promise<unknown>;
        }
      ).runAgorYmlExecutorCommand(repo, branch, 'branch.agor-yml.export', {}, { user })
    ).rejects.toThrow('branch filesystem write access required');
    expect(executorMocks.requestExecutor).not.toHaveBeenCalled();
  });

  it('rejects repository environment import/export for non-admin callers', async () => {
    const instance = service();
    const params = { user: { ...user, role: 'member' as const } } as never;

    await expect(
      instance.importFromAgorYml(repo.repo_id, { branch_id: branch.branch_id }, params)
    ).rejects.toThrow('Admin access is required');
    await expect(
      instance.exportToAgorYml(repo.repo_id, { branch_id: branch.branch_id }, params)
    ).rejects.toThrow('Admin access is required');
    expect(executorMocks.requestExecutor).not.toHaveBeenCalled();
  });
});

describe('ReposService.addLocalRepository executor boundary', () => {
  it('persists sanitized executor metadata with an explicit slug and no remote URL', async () => {
    executorMocks.requestExecutor.mockResolvedValueOnce({
      success: true,
      data: {
        path: '/trusted/repo',
        defaultBranch: 'main',
        credentialFindingCount: 0,
      },
    });
    const app = { get: () => ({}), service: vi.fn() } as unknown as Application;
    const service = new ReposService({} as never, app);
    const create = vi.spyOn(service, 'create').mockResolvedValue({
      repo_id: 'repo-id',
      slug: 'local/repo',
    } as never);

    await service.addLocalRepository({ path: '/submitted/repo', slug: 'local/repo' }, {
      user: { user_id: '550e8400-e29b-41d4-a716-446655440000' },
    } as never);

    expect(executorMocks.requestExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'git.repo.inspect',
        params: { path: '/submitted/repo' },
      }),
      expect.any(Object)
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        local_path: '/trusted/repo',
        remote_url: undefined,
        slug: 'local/repo',
      }),
      expect.any(Object)
    );
  });

  it('does not persist when executor inspection fails', async () => {
    executorMocks.requestExecutor.mockResolvedValueOnce({
      success: false,
      error: { code: 'GIT_REPO_INSPECT_FAILED', message: 'Not a valid git repository' },
    });
    const service = new ReposService(
      {} as never,
      { get: () => ({}), service: vi.fn() } as unknown as Application
    );
    const create = vi.spyOn(service, 'create');
    await expect(
      service.addLocalRepository({ path: '/bad', slug: 'local/bad' }, {
        user: { user_id: '550e8400-e29b-41d4-a716-446655440000' },
      } as never)
    ).rejects.toThrow(/Not a valid git repository/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('ReposService.createBranch Git lifecycle execution', () => {
  it('rejects invalid delegated routing before persisting the branch', async () => {
    delegatedHomeMocks.resolve.mockRejectedValueOnce(
      new Error('Delegated execution requires a unix_username home key')
    );
    const branches = { createMaterializationIntent: vi.fn(), find: vi.fn(async () => []) };
    const app = {
      get: () => ({ execution: { branch_rbac: true } }),
      sessionTokenService: {
        generateCommandToken: vi.fn(async () => 'delegated-user-token'),
      },
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'branches') return branches;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'get').mockResolvedValue({
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/agor',
      local_path: '/managed/repos/agor',
      default_branch: 'main',
    } as never);

    await expect(
      service.createBranch(
        '550e8400-e29b-41d4-a716-446655440001',
        {
          name: 'invalid-routing',
          ref: 'invalid-routing',
          createBranch: true,
          sourceBranch: 'main',
          boardId: '550e8400-e29b-41d4-a716-446655440003',
          storage_mode: 'worktree',
        },
        { user: { user_id: '550e8400-e29b-41d4-a716-446655440004' } } as never
      )
    ).rejects.toThrow(/unix_username/);
    expect(branches.createMaterializationIntent).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('returns the failed representation when executor dispatch throws synchronously', async () => {
    executorMocks.spawnExecutorFireAndForget.mockImplementationOnce(() => {
      throw new Error('launcher unavailable');
    });
    const repo = {
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/agor',
      local_path: '/managed/repos/agor',
      default_branch: 'main',
    };
    const creatingBranch = {
      branch_id: '550e8400-e29b-41d4-a716-446655440002',
      repo_id: repo.repo_id,
      name: 'dispatch-failure',
      path: '/managed/worktrees/preset-io/agor/dispatch-failure',
      filesystem_status: 'creating',
    };
    const failedBranch = {
      ...creatingBranch,
      filesystem_status: 'failed',
      error_message: 'Failed to spawn executor: launcher unavailable',
    };
    const branches = {
      createMaterializationIntent: vi.fn(async () => creatingBranch),
      settleFilesystemIntent: vi.fn(async () => failedBranch),
      find: vi.fn(async () => []),
    };
    const app = {
      get: () => ({}),
      sessionTokenService: {
        generateCommandToken: vi.fn(async () => 'delegated-user-token'),
      },
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: '550e8400-e29b-41d4-a716-446655440003',
              objects: {},
            })),
          };
        if (name === 'branches') return branches;
        if (name === 'board-objects') {
          return { create: vi.fn(async () => undefined), find: vi.fn(async () => ({ data: [] })) };
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'get').mockResolvedValue(repo as never);

    const result = await service.createBranch(
      repo.repo_id,
      {
        name: creatingBranch.name,
        ref: creatingBranch.name,
        createBranch: true,
        sourceBranch: 'main',
        boardId: '550e8400-e29b-41d4-a716-446655440003',
        position: { x: 10, y: 20 },
        storage_mode: 'worktree',
      },
      { user: { user_id: '550e8400-e29b-41d4-a716-446655440004' } } as never
    );

    expect(branches.settleFilesystemIntent).toHaveBeenCalledWith(
      {
        branch_id: creatingBranch.branch_id,
        filesystem_attempt_id: expect.any(String),
        filesystem_status: 'failed',
        error_message: 'Failed to spawn executor: launcher unavailable',
      },
      expect.objectContaining({ provider: undefined })
    );
    expect(result).toEqual(failedBranch);
  });

  it('persists a sanitized cross-repo base without attaching delegated Git work', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();

    const repo = {
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/agor',
      local_path: '/managed/repos/agor',
      default_branch: 'main',
    };
    const branch = {
      branch_id: '550e8400-e29b-41d4-a716-446655440002',
      repo_id: repo.repo_id,
      name: 'fix-lifecycle-identity',
      path: '/managed/worktrees/preset-io/agor/fix-lifecycle-identity',
      others_fs_access: 'read',
    };
    const branches = {
      createMaterializationIntent: vi.fn(async () => branch),
      find: vi.fn(async () => []),
    };
    const boardObjects = {
      create: vi.fn(async () => undefined),
      find: vi.fn(async () => ({ data: [] })),
    };
    const app = {
      get: () => ({ execution: { branch_rbac: true } }),
      sessionTokenService: {
        generateCommandToken: vi.fn(async () => 'delegated-user-token'),
      },
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: '550e8400-e29b-41d4-a716-446655440003',
              objects: {},
            })),
          };
        if (name === 'branches') return branches;
        if (name === 'board-objects') return boardObjects;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'get').mockResolvedValue(repo as never);

    await service.createBranch(
      repo.repo_id,
      {
        name: branch.name,
        ref: branch.name,
        createBranch: true,
        sourceBranch: 'template/deal-desk-revops-analyst',
        sourceRemoteUrl: 'https://token:secret@github.com/preset-io/agor-teammate.git',
        boardId: '550e8400',
        position: { x: 10, y: 20 },
        storage_mode: 'worktree',
      },
      {
        provider: 'rest',
        user: {
          user_id: '550e8400-e29b-41d4-a716-446655440004',
          role: 'member',
        },
      } as never
    );

    expect(branches.createMaterializationIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        base_ref: 'template/deal-desk-revops-analyst',
        base_remote_url: 'https://github.com/preset-io/agor-teammate.git',
        board_id: '550e8400-e29b-41d4-a716-446655440003',
      }),
      expect.anything()
    );
    expect(branches.createMaterializationIntent.mock.calls[0]?.[1]).toMatchObject({
      provider: undefined,
    });
    expect(boardObjects.create).toHaveBeenCalledWith(
      expect.objectContaining({ board_id: '550e8400-e29b-41d4-a716-446655440003' }),
      expect.anything()
    );
    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git.branch.add' }),
      expect.not.objectContaining({ delegatedHomeKey: expect.anything() })
    );
  });

  it('rejects an external branch create when the caller cannot attach to the board', async () => {
    repositoryMocks.resolveBoardAccess.mockResolvedValueOnce({ capabilities: ['board.view'] });
    const repo = {
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/agor',
      local_path: '/managed/repos/agor',
      default_branch: 'main',
    };
    const branches = {
      createMaterializationIntent: vi.fn(),
      find: vi.fn(async () => []),
    };
    const app = {
      get: () => ({ execution: { branch_rbac: true } }),
      service: vi.fn((name: string) => {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: '550e8400-e29b-41d4-a716-446655440003',
              objects: {},
            })),
          };
        if (name === 'branches') return branches;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'get').mockResolvedValue(repo as never);

    await expect(
      service.createBranch(
        repo.repo_id,
        {
          name: 'denied',
          ref: 'denied',
          createBranch: true,
          sourceBranch: 'main',
          boardId: '550e8400-e29b-41d4-a716-446655440003',
        },
        {
          provider: 'rest',
          user: {
            user_id: '550e8400-e29b-41d4-a716-446655440004',
            role: 'member',
          },
        } as never
      )
    ).rejects.toThrow('Board Editor or Manager access');
    expect(branches.createMaterializationIntent).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('rejects a client-selected template remote before persisting a branch', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    const branches = { createMaterializationIntent: vi.fn(), find: vi.fn(async () => []) };
    const app = {
      get: () => ({}),
      service: vi.fn((name: string) => {
        if (name === 'branches') return branches;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'get').mockResolvedValue({
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/agor-teammate-private',
      local_path: '/managed/repos/agor-teammate-private',
      default_branch: 'main',
    } as never);

    await expect(
      service.createBranch(
        '550e8400-e29b-41d4-a716-446655440001',
        {
          name: 'forged-template-source',
          ref: 'forged-template-source',
          createBranch: true,
          sourceBranch: 'template/deal-desk-revops-analyst',
          sourceRemoteUrl: 'https://attacker.example/template.git',
          boardId: '550e8400-e29b-41d4-a716-446655440003',
        },
        { user: { user_id: '550e8400-e29b-41d4-a716-446655440004' } } as never
      )
    ).rejects.toThrow(/canonical Agor teammate template repository/);
    expect(branches.createMaterializationIntent).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });
});

describe('ReposService.cloneRepository Git lifecycle execution', () => {
  it('creates managed storage without delegated user routing', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();

    const repos = { patch: vi.fn() };
    const app = {
      get: () => ({}),
      sessionTokenService: {
        generateCommandToken: vi.fn(async () => 'delegated-user-token'),
      },
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'repos') return repos;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'create').mockResolvedValue({
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/agor-teammate',
    } as never);

    await service.cloneRepository({ url: 'https://github.com/preset-io/agor-teammate.git' }, {
      user: { user_id: '550e8400-e29b-41d4-a716-446655440004' },
    } as never);

    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'git.clone',
        params: expect.objectContaining({ importEnvironmentConfig: false }),
      }),
      expect.not.objectContaining({ delegatedHomeKey: expect.anything() })
    );
  });

  it('permits .agor.yml environment import only for an authenticated admin', async () => {
    const repos = { patch: vi.fn() };
    const app = {
      get: () => ({}),
      sessionTokenService: {
        generateCommandToken: vi.fn(async () => 'delegated-user-token'),
      },
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'repos') return repos;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'create').mockResolvedValue({
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/agor-admin-clone',
    } as never);

    await service.cloneRepository({ url: 'https://github.com/preset-io/agor-admin-clone.git' }, {
      provider: 'rest',
      user: {
        user_id: '550e8400-e29b-41d4-a716-446655440004',
        role: 'admin',
      },
    } as never);

    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'git.clone',
        params: expect.objectContaining({ importEnvironmentConfig: true }),
      }),
      expect.anything()
    );
  });

  it('persists clone-exit failure in a fresh write-gated tenant unit', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    const db = { marker: 'base-db' };
    const current = {
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/agor-failed-clone',
      clone_status: 'cloning',
    };
    const repos = {
      get: vi.fn(async () => current),
      patch: vi.fn(async (_id: string, data: object) => ({ ...current, ...data })),
    };
    const app = {
      get: () => ({}),
      sessionTokenService: {
        generateCommandToken: vi.fn(async () => 'delegated-user-token'),
      },
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'repos') return repos;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService(db as never, app);
    vi.spyOn(service, 'create').mockResolvedValue(current as never);

    await service.cloneRepository({ url: 'https://github.com/preset-io/agor-failed-clone.git' }, {
      tenant: { tenant_id: 'tenant-a', source: 'explicit' },
      user: { user_id: '550e8400-e29b-41d4-a716-446655440004' },
    } as never);
    const spawnOptions = executorMocks.spawnExecutorFireAndForget.mock.calls.at(-1)?.[1] as
      | { onExit?: (code: number | null) => Promise<void> | void }
      | undefined;

    await spawnOptions?.onExit?.(17);

    expect(tenantScopeMocks.withFreshTenantWrite).toHaveBeenCalledWith(
      db,
      'tenant-a',
      expect.any(Function)
    );
    expect(repos.get).toHaveBeenCalledWith(current.repo_id);
    expect(repos.patch).toHaveBeenCalledWith(current.repo_id, {
      clone_status: 'failed',
      clone_error: {
        exit_code: 17,
        category: 'unknown',
        message: 'Clone exited with code 17 before reporting an error.',
      },
    });
  });
});

describe('ReposService.remove branch inventory', () => {
  it('does not dispatch destructive cleanup until every branch is retired', async () => {
    const repo = {
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/repo',
      repo_type: 'remote',
      local_path: '/managed/repos/preset-io/repo',
    };
    const branch = {
      branch_id: '550e8400-e29b-41d4-a716-446655440002',
      repo_id: repo.repo_id,
      name: 'starting',
      path: '/managed/worktrees/preset-io/repo/starting',
    };
    repositoryMocks.findAllBranchesByRepoId.mockReset().mockResolvedValue([branch]);
    repositoryMocks.lockRepoForBranchInventory.mockReset().mockResolvedValue(repo);
    repositoryMocks.assertBranchRetirementReady.mockRejectedValueOnce(
      new EnvironmentRetirementConflictError(branch.branch_id as never)
    );
    const app = {
      get: () => ({}),
      service: vi.fn((name: string) => {
        if (name === 'branches') return { removeMetadataWithRealtime: vi.fn() };
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const tx = { run: vi.fn() };
    const db = {
      run: vi.fn(),
      transaction: vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => work(tx)),
    };
    const service = new ReposService(db as never, app);
    vi.spyOn(service, 'get').mockResolvedValue(repo as never);

    await expect(
      service.remove(repo.repo_id, {
        query: { cleanup: true },
        tenant: { tenant_id: 'tenant-a', source: 'explicit' },
      } as never)
    ).rejects.toThrow('must settle before repository cleanup');
    expect(repositoryMocks.claimRepoDeletionAttempt).not.toHaveBeenCalled();
    expect(executorMocks.requestExecutor).not.toHaveBeenCalled();
  });

  it('does not dispatch destructive cleanup while a branch has unfinished tasks', async () => {
    const repo = {
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/repo',
      repo_type: 'remote',
      local_path: '/managed/repos/preset-io/repo',
    };
    const branch = {
      branch_id: '550e8400-e29b-41d4-a716-446655440002',
      repo_id: repo.repo_id,
      name: 'busy',
      path: '/managed/worktrees/preset-io/repo/busy',
    };
    repositoryMocks.findAllBranchesByRepoId.mockReset().mockResolvedValue([branch]);
    repositoryMocks.lockRepoForBranchInventory.mockReset().mockResolvedValue(repo);
    repositoryMocks.hasNonterminalForBranch.mockResolvedValueOnce(true);
    const app = {
      get: () => ({}),
      service: vi.fn((name: string) => {
        if (name === 'branches') return { removeMetadataWithRealtime: vi.fn() };
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const tx = { run: vi.fn() };
    const db = {
      run: vi.fn(),
      transaction: vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => work(tx)),
    };
    const service = new ReposService(db as never, app);
    vi.spyOn(service, 'get').mockResolvedValue(repo as never);

    await expect(
      service.remove(repo.repo_id, {
        query: { cleanup: true },
        tenant: { tenant_id: 'tenant-a', source: 'explicit' },
      } as never)
    ).rejects.toThrow('unfinished tasks');
    expect(repositoryMocks.claimRepoDeletionAttempt).not.toHaveBeenCalled();
    expect(executorMocks.requestExecutor).not.toHaveBeenCalled();
  });

  it('passes the authorized unbounded filesystem inventory without a service bearer', async () => {
    const repo = {
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/repo',
      repo_type: 'remote',
      local_path: '/managed/repos/preset-io/repo',
    };
    const branches = [
      {
        branch_id: '550e8400-e29b-41d4-a716-446655440002',
        repo_id: repo.repo_id,
        name: 'feature',
        path: '/managed/worktrees/preset-io/repo/feature',
      },
    ];
    repositoryMocks.findAllBranchesByRepoId.mockReset().mockResolvedValue(branches);
    repositoryMocks.lockRepoForBranchInventory.mockReset().mockResolvedValue(repo);
    repositoryMocks.deleteRepo.mockReset().mockResolvedValue(undefined);
    executorMocks.requestExecutor.mockResolvedValueOnce({ success: true, data: {} });
    const branchService = { removeMetadataWithRealtime: vi.fn(async () => undefined) };
    const app = {
      get: () => ({}),
      service: vi.fn((name: string) => {
        if (name === 'branches') return branchService;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const tx = { run: vi.fn() };
    const db = {
      run: vi.fn(),
      transaction: vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => work(tx)),
    };
    const service = new ReposService(db as never, app);
    vi.spyOn(service, 'get').mockResolvedValue(repo as never);

    await service.remove(repo.repo_id, {
      query: { cleanup: true },
      tenant: { tenant_id: 'tenant-a', source: 'explicit' },
    } as never);

    expect(executorMocks.requestExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'git.repo.delete',
        params: expect.objectContaining({
          repoId: repo.repo_id,
          repoPath: repo.local_path,
          branchPaths: [branches[0].path],
        }),
      }),
      expect.anything()
    );
    expect(executorMocks.requestExecutor.mock.calls[0]?.[0]).not.toHaveProperty('sessionToken');
  });

  it('uses the unbounded repository inventory after locking instead of Feathers pagination', async () => {
    const repo = {
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/large-repo',
      repo_type: 'remote',
    };
    const branches = Array.from({ length: 10_001 }, (_, index) => ({
      branch_id: `branch-${index}`,
      repo_id: repo.repo_id,
      name: `branch-${index}`,
    }));
    repositoryMocks.findAllBranchesByRepoId.mockReset().mockResolvedValue(branches);
    repositoryMocks.lockRepoForBranchInventory.mockReset().mockResolvedValue(repo);
    repositoryMocks.deleteRepo.mockReset().mockResolvedValue(undefined);

    const branchService = {
      find: vi.fn(async () => {
        throw new Error('transport-paginated find must not be used');
      }),
      removeMetadataWithRealtime: vi.fn(async () => undefined),
    };
    const app = {
      get: () => ({}),
      service: vi.fn((name: string) => {
        if (name === 'branches') return branchService;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const tx = { run: vi.fn() };
    const db = {
      run: vi.fn(),
      transaction: vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => work(tx)),
    };
    const service = new ReposService(db as never, app);
    vi.spyOn(service, 'get').mockResolvedValue(repo as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await service.remove(repo.repo_id, {
        tenant: { tenant_id: 'tenant-a', source: 'explicit' },
      } as never);
    } finally {
      log.mockRestore();
    }

    expect(branchService.find).not.toHaveBeenCalled();
    expect(repositoryMocks.findAllBranchesByRepoId).toHaveBeenNthCalledWith(1, repo.repo_id);
    expect(repositoryMocks.findAllBranchesByRepoId).toHaveBeenNthCalledWith(2, repo.repo_id);
    expect(repositoryMocks.lockRepoForBranchInventory).toHaveBeenCalledWith(repo.repo_id);
    expect(repositoryMocks.lockRepoForBranchInventory.mock.invocationCallOrder[0]).toBeLessThan(
      repositoryMocks.findAllBranchesByRepoId.mock.invocationCallOrder[1]!
    );
    expect(branchService.removeMetadataWithRealtime).toHaveBeenCalledTimes(10_001);
    expect(repositoryMocks.deleteRepo).toHaveBeenCalledOnce();
  });
});
