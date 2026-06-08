import { assertRemoteRefVisibleForClone } from '@agor/core/git';
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

vi.mock('@agor/core/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/git')>();

  return {
    ...actual,
    assertRemoteRefVisibleForClone: vi.fn(),
  };
});

describe('ReposService.createBranch clone preflight', () => {
  it('rejects clone-mode local-only source refs before persisting branch state', async () => {
    const branchesCreate = vi.fn();
    const getGitEnvironment = vi.fn(async () => ({ GITHUB_TOKEN: 'gh_test_token_for_preflight' }));
    vi.mocked(assertRemoteRefVisibleForClone).mockRejectedValueOnce(
      new Error("Clone mode cannot clone local-only or missing branch 'local-only'")
    );

    const app = {
      service(path: string) {
        if (path === 'branches') return { create: branchesCreate };
        if (path === 'users') return { getGitEnvironment };
        throw new Error(`Unexpected service: ${path}`);
      },
    } as unknown as Application;

    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'get').mockResolvedValue({
      repo_id: 'repo-1',
      slug: 'org/repo',
      remote_url: 'https://github.com/org/repo.git',
      local_path: undefined,
      default_branch: 'main',
    } as never);

    await expect(
      service.createBranch(
        'repo-1',
        {
          name: 'new-branch',
          ref: 'new-branch',
          createBranch: true,
          sourceBranch: 'local-only',
          storage_mode: 'clone',
        },
        { user: { user_id: 'user-1' } } as never
      )
    ).rejects.toThrow(/Clone mode cannot clone local-only/);

    expect(getGitEnvironment).toHaveBeenCalledWith({ userId: 'user-1' }, expect.any(Object));
    expect(assertRemoteRefVisibleForClone).toHaveBeenCalledWith({
      remoteUrl: 'https://github.com/org/repo.git',
      ref: 'local-only',
      refType: 'branch',
      env: { GITHUB_TOKEN: 'gh_test_token_for_preflight' },
    });
    expect(branchesCreate).not.toHaveBeenCalled();
  });
});
