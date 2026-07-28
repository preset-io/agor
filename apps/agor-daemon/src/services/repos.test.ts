import type { Application } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { ReposService } from './repos';

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

const executorMocks = vi.hoisted(() => ({ runExecutorCommand: vi.fn() }));
vi.mock('../utils/spawn-executor.js', () => {
  return {
    runExecutorCommand: executorMocks.runExecutorCommand,
    generateScopedServiceToken: vi.fn(() => 'scoped-token'),
    getDaemonUrl: vi.fn(() => 'http://daemon'),
    spawnExecutorFireAndForget: vi.fn(),
  };
});

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
    const app = { service: vi.fn() } as unknown as Application;
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
    const service = new ReposService({} as never, { service: vi.fn() } as unknown as Application);
    const create = vi.spyOn(service, 'create');
    await expect(
      service.addLocalRepository({ path: '/bad', slug: 'local/bad' }, {
        user: { user_id: '550e8400-e29b-41d4-a716-446655440000' },
      } as never)
    ).rejects.toThrow(/Not a valid git repository/);
    expect(create).not.toHaveBeenCalled();
  });
});
