import type { Application } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
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
      shouldInitUnixGroups: true,
    })),
    resolveMultiTenancyConfig: vi.fn(() => ({ mode: 'disabled' })),
  };
});

vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();

  return {
    ...actual,
    BranchRepository: vi.fn().mockImplementation(function BranchRepository() {
      return {
        findActiveByRepoAndName: vi.fn(async () => null),
        getAllUsedUniqueIds: vi.fn(async () => []),
        addOwner: vi.fn(async () => undefined),
      };
    }),
    RepoRepository: vi.fn().mockImplementation(function RepoRepository() {
      return {
        create: vi.fn(),
        findById: vi.fn(),
        findAll: vi.fn(async () => []),
        update: vi.fn(),
        delete: vi.fn(),
        findBySlug: vi.fn(),
      };
    }),
  };
});

const executorMocks = vi.hoisted(() => ({
  runExecutorCommand: vi.fn(),
  spawnExecutorFireAndForget: vi.fn(),
}));
vi.mock('../utils/spawn-executor.js', () => {
  return {
    runExecutorCommand: executorMocks.runExecutorCommand,
    generateScopedServiceToken: vi.fn(() => 'scoped-token'),
    getDaemonUrl: vi.fn(() => 'http://daemon'),
    spawnExecutorFireAndForget: executorMocks.spawnExecutorFireAndForget,
  };
});

const impersonationMocks = vi.hoisted(() => ({
  resolveExecutorReadAsUser: vi.fn(async () => 'requesting-user'),
  resolveGitImpersonationForUser: vi.fn(async () => 'daemon-user'),
}));
vi.mock('../utils/executor-read-impersonation.js', () => ({
  resolveExecutorReadAsUser: impersonationMocks.resolveExecutorReadAsUser,
}));
vi.mock('../utils/git-impersonation.js', () => ({
  resolveGitImpersonationForUser: impersonationMocks.resolveGitImpersonationForUser,
}));

describe('ReposService.addLocalRepository executor boundary', () => {
  it('persists sanitized executor metadata with an explicit slug and no remote URL', async () => {
    executorMocks.runExecutorCommand.mockResolvedValueOnce({
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

    expect(executorMocks.runExecutorCommand).toHaveBeenCalledWith(
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
    executorMocks.runExecutorCommand.mockResolvedValueOnce({
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

describe('ReposService.createBranch Git lifecycle identity', () => {
  it('uses the Git lifecycle resolver rather than the requesting-user read resolver', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    impersonationMocks.resolveExecutorReadAsUser.mockClear();
    impersonationMocks.resolveGitImpersonationForUser.mockClear();

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
        sourceBranch: 'main',
        boardId: '550e8400-e29b-41d4-a716-446655440003',
        position: { x: 10, y: 20 },
        storage_mode: 'worktree',
      },
      {
        user: { user_id: '550e8400-e29b-41d4-a716-446655440004' },
      } as never
    );

    expect(impersonationMocks.resolveGitImpersonationForUser).toHaveBeenCalledOnce();
    expect(impersonationMocks.resolveExecutorReadAsUser).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git.branch.add' }),
      expect.objectContaining({ asUser: 'daemon-user' })
    );
  });
});

describe('ReposService.cloneRepository Git lifecycle identity', () => {
  it('creates managed storage as the daemon lifecycle user, not the requesting user', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    impersonationMocks.resolveExecutorReadAsUser.mockClear();
    impersonationMocks.resolveGitImpersonationForUser.mockClear();

    const repos = { patch: vi.fn() };
    const app = {
      get: () => ({}),
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

    expect(impersonationMocks.resolveGitImpersonationForUser).toHaveBeenCalledOnce();
    expect(impersonationMocks.resolveExecutorReadAsUser).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git.clone' }),
      expect.objectContaining({ asUser: 'daemon-user' })
    );
  });
});
