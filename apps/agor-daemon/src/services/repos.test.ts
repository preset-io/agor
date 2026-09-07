import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCurrentTenantId } from '@agor/core/db';
import type { Application } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReposService } from './repos';

/** Create a temp dir that looks like a materialized git checkout (has `.git`). */
function makeValidCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agor-branch-'));
  writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/x');
  return dir;
}
/** A path guaranteed not to exist on disk. */
function missingPath(): string {
  return join(tmpdir(), `agor-missing-${Math.floor(performance.now())}-${process.pid}`);
}

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
  resolveBranchUserAccess: vi.fn(),
}));

// Shared BranchRepository mock so tests can drive/assert the atomic CAS methods
// (`claimFailedForProvisioningRetry` / `markProvisioningFailedIfCreating`) that
// the provisioning safety nets and retry go through. Every `new
// BranchRepository()` in the service returns this same object.
const branchRepoMock = vi.hoisted(() => ({
  findActiveByRepoAndName: vi.fn(async () => null),
  findByRepoAndName: vi.fn(async () => null),
  getAllUsedUniqueIds: vi.fn(async () => [] as number[]),
  addOwner: vi.fn(async () => undefined),
  claimFailedForProvisioningRetry: vi.fn(),
  markProvisioningFailedIfCreating: vi.fn(),
  acknowledgeProvisioningAttempt: vi.fn(),
  findCreatingPage: vi.fn(),
  // Used by the real `ensureCanControlBranchEnvironment` gate, which the retry
  // path runs through — left unmocked on purpose so the tests exercise the
  // actual permission resolution rather than a stubbed verdict.
  findById: vi.fn(),
  resolveUserPermission: vi.fn(),
}));

vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();

  return {
    ...actual,
    BranchRepository: vi.fn().mockImplementation(function BranchRepository() {
      return {
        ...branchRepoMock,
        findAllByRepoId: repositoryMocks.findAllBranchesByRepoId,
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
      };
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
    const branches = { create: vi.fn(), find: vi.fn(async () => []) };
    const app = {
      get: () => ({}),
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
    expect(branches.create).not.toHaveBeenCalled();
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
      create: vi.fn(async () => creatingBranch),
      patch: vi.fn(async () => failedBranch),
      find: vi.fn(async () => []),
    };
    const app = {
      get: () => ({}),
      sessionTokenService: {
        generateCommandToken: vi.fn(async () => 'delegated-user-token'),
      },
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'boards') return { get: vi.fn(async () => ({ objects: {} })) };
        if (name === 'branches') return branches;
        if (name === 'board-objects') {
          return { create: vi.fn(async () => undefined), find: vi.fn(async () => ({ data: [] })) };
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'get').mockResolvedValue(repo as never);
    branchRepoMock.acknowledgeProvisioningAttempt.mockResolvedValue({
      applied: true,
      branch: failedBranch,
    });

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

    expect(branchRepoMock.acknowledgeProvisioningAttempt).toHaveBeenCalledWith(
      creatingBranch.branch_id,
      {
        filesystem_status: 'failed',
        error_message: 'Failed to spawn executor: launcher unavailable',
      },
      undefined
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
      create: vi.fn(async () => branch),
      find: vi.fn(async () => []),
    };
    const boardObjects = {
      create: vi.fn(async () => undefined),
      find: vi.fn(async () => ({ data: [] })),
    };
    const app = {
      get: () => ({}),
      sessionTokenService: {
        generateCommandToken: vi.fn(async () => 'delegated-user-token'),
      },
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'boards') return { get: vi.fn(async () => ({ objects: {} })) };
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
        boardId: '550e8400-e29b-41d4-a716-446655440003',
        position: { x: 10, y: 20 },
        storage_mode: 'worktree',
      },
      {
        user: { user_id: '550e8400-e29b-41d4-a716-446655440004' },
      } as never
    );

    expect(branches.create).toHaveBeenCalledWith(
      expect.objectContaining({
        base_ref: 'template/deal-desk-revops-analyst',
        base_remote_url: 'https://github.com/preset-io/agor-teammate.git',
      }),
      expect.anything()
    );
    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git.branch.add' }),
      expect.not.objectContaining({ delegatedHomeKey: expect.anything() })
    );
  });

  it('rejects a client-selected template remote before persisting a branch', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    const branches = { create: vi.fn(), find: vi.fn(async () => []) };
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
    expect(branches.create).not.toHaveBeenCalled();
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

describe('ReposService branch provisioning lifecycle', () => {
  type BranchesMock = {
    get: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    find?: ReturnType<typeof vi.fn>;
    emit?: ReturnType<typeof vi.fn>;
  };

  function makeService(branches: BranchesMock, db: unknown = {}) {
    branches.emit ??= vi.fn();
    const app = {
      // Provisioning reads deployment config off the app (impersonation
      // resolution, clone-reference hints, daemon unix user).
      get: () => ({}),
      // Dispatch mints a scoped executor command token before spawning; without
      // this daemon-private singleton the spawn fails closed and never reaches
      // the executor mock.
      sessionTokenService: {
        generateCommandToken: vi.fn(async () => 'delegated-user-token'),
      },
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'branches') return branches;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService(db as never, app);
    return { service, app };
  }

  /**
   * Minimal database stand-in that can back a real tenant scope: with a tenant
   * id present, `runWithTenantDatabaseScope` opens a transaction to set the
   * `agor.tenant_id` GUC, so the handle must expose `transaction`.
   */
  function fakeTenantCapableDb() {
    return {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute: async () => undefined }),
    };
  }

  function grabOnExit(): (code: number | null) => void {
    const opts = executorMocks.spawnExecutorFireAndForget.mock.calls.at(-1)?.[1] as {
      onExit?: (code: number | null) => void;
    };
    if (!opts?.onExit) throw new Error('expected an onExit safety net to be wired');
    return opts.onExit;
  }

  const branch = (over: Record<string, unknown> = {}) => ({
    branch_id: 'b1',
    repo_id: 'r1',
    name: 'feature',
    path: missingPath(),
    storage_mode: 'worktree' as const,
    created_by: 'user-1',
    filesystem_status: 'creating' as const,
    // Generation owning the in-flight attempt; dispatch must carry it through
    // to the executor and to its own onExit safety net.
    provisioning_attempt_id: 'attempt-1',
    ...over,
  });
  const repo = { repo_id: 'r1', local_path: '/managed/repo', slug: 'acme/app' };

  beforeEach(() => {
    executorMocks.spawnExecutorFireAndForget.mockReset();
    branchRepoMock.claimFailedForProvisioningRetry.mockReset();
    branchRepoMock.markProvisioningFailedIfCreating.mockReset();
    branchRepoMock.findById.mockReset();
    branchRepoMock.resolveUserPermission.mockReset();
    branchRepoMock.acknowledgeProvisioningAttempt.mockReset();
    branchRepoMock.findCreatingPage.mockReset();
    branchRepoMock.acknowledgeProvisioningAttempt.mockImplementation(
      async (_id, acknowledgement) => ({ applied: true, branch: branch(acknowledgement) })
    );
    branchRepoMock.findCreatingPage.mockResolvedValue([]);
    // Sensible defaults: CAS is a no-op unless a test opts in.
    branchRepoMock.markProvisioningFailedIfCreating.mockResolvedValue({
      changed: false,
      branch: branch({ filesystem_status: 'failed' }),
    });
    branchRepoMock.claimFailedForProvisioningRetry.mockResolvedValue({
      claimed: false,
      branch: branch({ filesystem_status: 'creating' }),
    });
    branchRepoMock.findById.mockResolvedValue(branch({ filesystem_status: 'failed' }));
    branchRepoMock.resolveUserPermission.mockResolvedValue('all');
  });

  // ---- crash / onExit safety net ------------------------------------------

  it('onExit(non-zero) atomically marks a still-creating branch failed (no .git promotion)', async () => {
    branchRepoMock.markProvisioningFailedIfCreating.mockResolvedValue({
      changed: true,
      branch: branch({ filesystem_status: 'failed' }),
    });
    const { service } = makeService({ get: vi.fn(), patch: vi.fn() });

    await (
      service as unknown as { dispatchBranchProvisioning: (...a: unknown[]) => Promise<void> }
    ).dispatchBranchProvisioning(branch(), repo, 'user-1', undefined, 'create');

    grabOnExit()(1);

    await vi.waitFor(() => {
      expect(branchRepoMock.markProvisioningFailedIfCreating).toHaveBeenCalledWith(
        'b1',
        expect.stringMatching(/provisioning/i),
        // Fenced on the generation this dispatch owned, so a superseded
        // attempt's exit can never fail a newer one.
        'attempt-1'
      );
    });
  });

  it('onExit does NOT promote to ready even when a valid checkout is on disk', async () => {
    // The whole point of the new design: the daemon never infers success from a
    // daemon-local .git path. A crash → failed, and the user retries.
    const dir = makeValidCheckout();
    branchRepoMock.markProvisioningFailedIfCreating.mockResolvedValue({
      changed: true,
      branch: branch({ path: dir, filesystem_status: 'failed' }),
    });
    const patch = vi.fn(async () => ({}));
    const { service } = makeService({ get: vi.fn(), patch });

    await (
      service as unknown as { dispatchBranchProvisioning: (...a: unknown[]) => Promise<void> }
    ).dispatchBranchProvisioning(branch({ path: dir }), repo, 'user-1', undefined, 'create');

    grabOnExit()(1);

    await vi.waitFor(() => {
      expect(branchRepoMock.markProvisioningFailedIfCreating).toHaveBeenCalled();
    });
    // Never a status patch to 'ready'.
    expect(patch).not.toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({ filesystem_status: 'ready' })
    );
  });

  it('onExit code 0 does not touch the row (executor already acked)', async () => {
    const { service } = makeService({ get: vi.fn(), patch: vi.fn() });

    await (
      service as unknown as { dispatchBranchProvisioning: (...a: unknown[]) => Promise<void> }
    ).dispatchBranchProvisioning(branch(), repo, 'user-1', undefined, 'create');

    grabOnExit()(0);
    await new Promise((r) => setImmediate(r));
    expect(branchRepoMock.markProvisioningFailedIfCreating).not.toHaveBeenCalled();
  });

  it('synchronous spawn failure marks the branch failed and returns that row', async () => {
    // Fire-and-forget means no process exists to emit onExit, so the failure
    // has to be recorded inline or the branch stays 'creating' with no signal.
    // The patched row is returned so `createBranch` hands its caller the failed
    // representation rather than a stale 'creating' one.
    executorMocks.spawnExecutorFireAndForget.mockImplementationOnce(() => {
      throw new Error('executor binary not found');
    });
    const patch = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    const { service } = makeService({ get: vi.fn(), patch });

    const result = await (
      service as unknown as { dispatchBranchProvisioning: (...a: unknown[]) => Promise<unknown> }
    ).dispatchBranchProvisioning(branch(), repo, 'user-1', undefined, 'create');

    expect(branchRepoMock.acknowledgeProvisioningAttempt).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({
        filesystem_status: 'failed',
        error_message: expect.stringMatching(/failed to spawn executor/i),
      }),
      'attempt-1'
    );
    expect((result as { filesystem_status?: string }).filesystem_status).toBe('failed');
  });

  // ---- retry authorization (branch control, not just view) ----------------
  //
  // The retry writes through the repository CAS, so it never passes the
  // branches-service `patch` hook that normally demands `all`. Reading the
  // branch only proves VIEW access. These pin the explicit in-service gate:
  // without it, any member who can see a failed branch could run provisioning
  // under `branch.created_by`'s execution identity.

  /** A retry request as it arrives over REST/MCP (i.e. with a provider set). */
  const externalParams = (over: Record<string, unknown> = {}) =>
    ({
      provider: 'rest',
      user: { user_id: 'user-2', role: 'member' },
      ...over,
    }) as never;

  it('refuses a viewer/member without branch control (no CAS, no dispatch)', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    branchRepoMock.resolveUserPermission.mockResolvedValue('session');
    const { service } = makeService({ get, patch: vi.fn() });

    await expect(service.retryBranchProvisioning('b1', externalParams())).rejects.toThrow(
      /'all' branch permission or admin access/i
    );
    expect(branchRepoMock.claimFailedForProvisioningRetry).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it.each(['none', 'view', 'session', 'prompt'])(
    'refuses branch permission tier %s',
    async (tier) => {
      const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
      branchRepoMock.resolveUserPermission.mockResolvedValue(tier);
      const { service } = makeService({ get, patch: vi.fn() });

      await expect(service.retryBranchProvisioning('b1', externalParams())).rejects.toThrow(
        /'all' branch permission or admin access/i
      );
      expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
    }
  );

  it('allows a caller with `all` branch permission', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    branchRepoMock.resolveUserPermission.mockResolvedValue('all');
    branchRepoMock.claimFailedForProvisioningRetry.mockResolvedValue({
      claimed: true,
      branch: branch({ filesystem_status: 'creating' }),
    });
    const { service } = makeService({ get, patch: vi.fn() });
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    await service.retryBranchProvisioning('b1', externalParams());

    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledTimes(1);
  });

  it('allows a global admin without consulting branch permission', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    branchRepoMock.claimFailedForProvisioningRetry.mockResolvedValue({
      claimed: true,
      branch: branch({ filesystem_status: 'creating' }),
    });
    const { service } = makeService({ get, patch: vi.fn() });
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    await service.retryBranchProvisioning(
      'b1',
      externalParams({ user: { user_id: 'admin-1', role: 'admin' } })
    );

    expect(branchRepoMock.resolveUserPermission).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledTimes(1);
  });

  it('rejects an unauthenticated external caller', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    const { service } = makeService({ get, patch: vi.fn() });

    await expect(
      service.retryBranchProvisioning('b1', externalParams({ user: undefined }))
    ).rejects.toThrow(/authentication required/i);
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('lets the executor service account through (internal plumbing)', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    branchRepoMock.claimFailedForProvisioningRetry.mockResolvedValue({
      claimed: true,
      branch: branch({ filesystem_status: 'creating' }),
    });
    const { service } = makeService({ get, patch: vi.fn() });
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    await service.retryBranchProvisioning(
      'b1',
      externalParams({ user: { user_id: 'svc', _isServiceAccount: true } })
    );

    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledTimes(1);
  });

  // ---- explicit retry (failed → creating only) ----------------------------

  it('retry on a ready branch is a no-op (no claim, no dispatch)', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'ready' }));
    const { service } = makeService({ get, patch: vi.fn() });

    const result = await service.retryBranchProvisioning('b1');

    expect(result.filesystem_status).toBe('ready');
    expect(branchRepoMock.claimFailedForProvisioningRetry).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('retry on a live creating branch is refused (409 in-progress)', async () => {
    // Written by the current daemon lifetime → a materializer may still be
    // running, so retry must not spawn a second one.
    const get = vi.fn(async () =>
      branch({ filesystem_status: 'creating', updated_at: new Date().toISOString() })
    );
    const { service } = makeService({ get, patch: vi.fn() });

    await expect(service.retryBranchProvisioning('b1')).rejects.toThrow(/in progress/i);
    expect(branchRepoMock.markProvisioningFailedIfCreating).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('retry on a creating branch with an unparseable updated_at is refused (fails safe)', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'creating', updated_at: 'garbage' }));
    const { service } = makeService({ get, patch: vi.fn() });

    await expect(service.retryBranchProvisioning('b1')).rejects.toThrow(/in progress/i);
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('does not infer that an old creating branch is orphaned', async () => {
    // Row last written before this process started ⇒ its materializer died with
    // the previous daemon. This is the path that keeps a stranded branch
    // repairable in tenants the startup watchdog never scans.
    const get = vi.fn(async () =>
      branch({ filesystem_status: 'creating', updated_at: '2020-01-01T00:00:00.000Z' })
    );
    const { service } = makeService({ get, patch: vi.fn() });
    await expect(service.retryBranchProvisioning('b1')).rejects.toThrow(/in progress/i);
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('two callers cannot take over a creating branch based on process age', async () => {
    const get = vi.fn(async () =>
      branch({ filesystem_status: 'creating', updated_at: '2020-01-01T00:00:00.000Z' })
    );
    const { service } = makeService({ get, patch: vi.fn() });
    const results = await Promise.allSettled([
      service.retryBranchProvisioning('b1'),
      service.retryBranchProvisioning('b1'),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('refuses an archived branch even when its status still reads failed', async () => {
    // Archiving normally overwrites filesystem_status, but a branch archived
    // while already `failed` keeps it — so a status-only check would let an
    // archived branch through into provisioning instead of unarchive.
    const get = vi.fn(async () => branch({ filesystem_status: 'failed', archived: true }));
    const { service } = makeService({ get, patch: vi.fn() });

    await expect(service.retryBranchProvisioning('b1')).rejects.toThrow(/archived/i);
    expect(branchRepoMock.claimFailedForProvisioningRetry).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('retry on a non-failed lifecycle state (e.g. preserved) is refused (not retryable)', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'preserved' }));
    const { service } = makeService({ get, patch: vi.fn() });

    await expect(service.retryBranchProvisioning('b1')).rejects.toThrow(/cannot be retried/i);
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('retry on a failed branch atomically claims failed→creating and re-dispatches', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    branchRepoMock.claimFailedForProvisioningRetry.mockResolvedValue({
      claimed: true,
      branch: branch({ filesystem_status: 'creating' }),
    });
    const { service } = makeService({ get, patch: vi.fn() });
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    const result = await service.retryBranchProvisioning('b1');

    expect(branchRepoMock.claimFailedForProvisioningRetry).toHaveBeenCalledWith(
      'b1',
      expect.any(String)
    );
    expect(result.filesystem_status).toBe('creating');
    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'git.branch.add',
        params: expect.objectContaining({ provisioningAttemptId: expect.any(String) }),
      }),
      expect.any(Object)
    );
  });

  it('retry surfaces the failed row when the executor spawn fails synchronously', async () => {
    // Fire-and-forget means a synchronous spawn failure produces no process and
    // therefore no onExit. dispatchBranchProvisioning patches the branch to
    // `failed` for exactly that case; retry has to return THAT row. Returning
    // the pre-dispatch `creating` claim would tell a REST/MCP caller a retry is
    // in flight when nothing is running.
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    branchRepoMock.claimFailedForProvisioningRetry.mockResolvedValue({
      claimed: true,
      branch: branch({ filesystem_status: 'creating' }),
    });
    const patch = vi.fn(async () =>
      branch({ filesystem_status: 'failed', error_message: 'Failed to spawn executor: boom' })
    );
    executorMocks.spawnExecutorFireAndForget.mockImplementation(() => {
      throw new Error('boom');
    });
    const { service } = makeService({ get, patch });
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    const result = await service.retryBranchProvisioning('b1');

    expect(result.filesystem_status).toBe('failed');
    expect(result.error_message).toMatch(/failed to spawn executor/i);
  });

  it("retry runs its CAS inside the caller's tenant database scope", async () => {
    // retryBranchProvisioning is a custom method: no Feathers hook opens a
    // tenant scope for it. In `required_from_auth` the daemon handle is a
    // scope-requiring proxy, so an unscoped repository write throws
    // MissingTenantDatabaseScopeError and retry would be dead in cloud. Assert
    // the ambient tenant at the moment of the CAS — this fails if the wrapping
    // unit of work is removed.
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    let tenantDuringClaim: string | undefined;
    branchRepoMock.claimFailedForProvisioningRetry.mockImplementation(async () => {
      tenantDuringClaim = getCurrentTenantId() as string | undefined;
      return { claimed: true, branch: branch({ filesystem_status: 'creating' }) };
    });
    const { service } = makeService({ get, patch: vi.fn() }, fakeTenantCapableDb());
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    await service.retryBranchProvisioning('b1', {
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    } as never);

    expect(tenantDuringClaim).toBe('tenant-a');
  });

  it("retry's dispatch — and its late onExit safety net — stay in the caller's tenant", async () => {
    // The CAS scope asserted above is NOT sufficient on its own.
    // `dispatchBranchProvisioning` reads `getCurrentTenantId()` at dispatch time
    // and hands that id to the executor's `onExit`, which re-enters it through
    // `runWithTenantDatabaseScope` long after the request scope has unwound.
    // Remove the tenant wrapper from around the *dispatch* and the CAS test
    // still passes, typecheck still passes — but the safety net's write lands
    // under the wrong tenant (or none). Pin the whole chain: in-scope while
    // dispatching, and the same tenant on the asynchronous failure write.
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    let tenantDuringDispatch: string | undefined;
    executorMocks.spawnExecutorFireAndForget.mockImplementation(() => {
      tenantDuringDispatch = getCurrentTenantId() as string | undefined;
      return undefined as never;
    });
    branchRepoMock.claimFailedForProvisioningRetry.mockResolvedValue({
      claimed: true,
      branch: branch({ filesystem_status: 'creating', provisioning_attempt_id: 'attempt-2' }),
    });
    let tenantDuringSafetyNet: string | undefined;
    branchRepoMock.markProvisioningFailedIfCreating.mockImplementation(async () => {
      tenantDuringSafetyNet = getCurrentTenantId() as string | undefined;
      return { changed: true, branch: branch({ filesystem_status: 'failed' }) };
    });
    const { service } = makeService({ get, patch: vi.fn() }, fakeTenantCapableDb());
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    await service.retryBranchProvisioning('b1', {
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    } as never);

    expect(tenantDuringDispatch).toBe('tenant-a');

    // Executor dies without acknowledging: the late write must re-enter
    // tenant-a, and must be fenced on the generation this retry claimed.
    grabOnExit()(9);

    await vi.waitFor(() => {
      expect(branchRepoMock.markProvisioningFailedIfCreating).toHaveBeenCalledWith(
        'b1',
        expect.stringMatching(/provisioning/i),
        'attempt-2'
      );
    });
    expect(tenantDuringSafetyNet).toBe('tenant-a');
  });

  it('retry that loses the atomic claim (concurrent/double-click) does NOT dispatch a 2nd executor', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    // Another caller already flipped it to creating and won the claim.
    branchRepoMock.claimFailedForProvisioningRetry.mockResolvedValue({
      claimed: false,
      branch: branch({ filesystem_status: 'creating' }),
    });
    const { service } = makeService({ get, patch: vi.fn() });
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    const result = await service.retryBranchProvisioning('b1');

    expect(branchRepoMock.claimFailedForProvisioningRetry).toHaveBeenCalledTimes(1);
    expect(result.filesystem_status).toBe('creating');
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('two concurrent retries against the same failed branch dispatch exactly once', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    // The repo-level CAS is the fence: first call wins the claim, second loses.
    branchRepoMock.claimFailedForProvisioningRetry
      .mockResolvedValueOnce({ claimed: true, branch: branch({ filesystem_status: 'creating' }) })
      .mockResolvedValueOnce({ claimed: false, branch: branch({ filesystem_status: 'creating' }) });
    const { service } = makeService({ get, patch: vi.fn() });
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    await Promise.all([
      service.retryBranchProvisioning('b1'),
      service.retryBranchProvisioning('b1'),
    ]);

    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledTimes(1);
  });

  // ---- startup watchdog (interrupted creating → failed) -------------------

  it('watchdog marks every stuck creating branch failed — never recovers or re-dispatches', async () => {
    const stuckA = branch({ branch_id: 'a', filesystem_status: 'creating' });
    const stuckB = branch({ branch_id: 'b', filesystem_status: 'creating' });
    const find = vi.fn(async () => []);
    branchRepoMock.findCreatingPage.mockResolvedValue([stuckA, stuckB]);
    branchRepoMock.markProvisioningFailedIfCreating.mockResolvedValue({
      changed: true,
      branch: branch({ filesystem_status: 'failed' }),
    });
    const { service } = makeService({ get: vi.fn(), patch: vi.fn(), find });

    const summary = await service.reconcileStuckCreatingBranches();

    expect(summary).toEqual({ scanned: 2, failed: 2 });
    expect(branchRepoMock.markProvisioningFailedIfCreating).toHaveBeenCalledTimes(2);
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });
});
