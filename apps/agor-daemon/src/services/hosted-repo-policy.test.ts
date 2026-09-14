import { BoardRepository, BranchRepository } from '@agor/core/db';
import type { Application, Branch, Repo } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleService } from '../adapters/drizzle';
import { BranchesService } from './branches';
import { ReposService } from './repos';

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    resolveMultiTenancyConfig: vi.fn(() => ({ mode: 'required_from_auth' })),
  };
});

describe('hosted repository storage policy canonical boundaries', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects worktree rows through the exposed branches.create boundary', async () => {
    const service = new BranchesService(
      {} as never,
      { get: () => ({}), service: vi.fn() } as unknown as Application
    );

    await expect(
      service.create({
        board_id: '550e8400-e29b-41d4-a716-446655440000',
        storage_mode: 'worktree',
      } as Partial<Branch>)
    ).rejects.toThrow(/worktree.*unavailable in hosted multi-tenant mode/);
  });

  it('uses the daemon clone default when onboarding omits storage_mode', async () => {
    const config = {
      database: { dialect: 'postgresql' as const },
      multi_tenancy: {
        mode: 'required_from_auth' as const,
        auth_claim: 'tenant_id',
        filesystem_isolation_enabled: true,
      },
      execution: {
        branch_storage: {
          default_mode: 'clone' as const,
          allowed_modes: ['clone' as const],
        },
      },
    };
    const app = {
      get: vi.fn(() => config),
      service: vi.fn(),
    } as unknown as Application;
    const service = new BranchesService({} as never, app);
    vi.spyOn(BoardRepository.prototype, 'findById').mockResolvedValue(null);
    const adapterCreate = vi.spyOn(DrizzleService.prototype, 'create').mockResolvedValue({
      branch_id: '550e8400-e29b-41d4-a716-446655440001',
      board_id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'onboarding-teammate',
      storage_mode: 'clone',
    } as Branch);

    await expect(
      service.create({
        board_id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'onboarding-teammate',
      })
    ).resolves.toMatchObject({ storage_mode: 'clone' });
    expect(adapterCreate).toHaveBeenCalledWith(
      expect.objectContaining({ storage_mode: 'clone' }),
      undefined
    );
  });

  it('applies the clone default at the onboarding repo.createBranch boundary', async () => {
    const config = {
      database: { dialect: 'postgresql' as const },
      multi_tenancy: {
        mode: 'required_from_auth' as const,
        auth_claim: 'tenant_id',
        filesystem_isolation_enabled: true,
      },
      execution: {
        branch_storage: {
          default_mode: 'clone' as const,
          allowed_modes: ['clone' as const],
        },
      },
    };
    const service = new ReposService(
      {} as never,
      {
        get: vi.fn(() => config),
        service: vi.fn(),
      } as unknown as Application
    );
    vi.spyOn(BranchRepository.prototype, 'findActiveByRepoAndName').mockResolvedValue(null);
    vi.spyOn(service, 'get').mockResolvedValue({
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/onboarding-teammate',
      local_path: '/managed/repos/onboarding-teammate',
      default_branch: 'main',
      remote_url: undefined,
    } as Repo);

    await expect(
      service.createBranch(
        '550e8400-e29b-41d4-a716-446655440001',
        {
          name: 'onboarding-teammate',
          ref: 'onboarding-teammate',
          createBranch: true,
          sourceBranch: 'main',
          boardId: '550e8400-e29b-41d4-a716-446655440000',
        },
        { user: { user_id: '550e8400-e29b-41d4-a716-446655440002' } } as never
      )
    ).rejects.toThrow(/Cannot create a clone-mode branch.*no remote_url/);
  });

  it('rejects bulk conversion to local repositories', async () => {
    const service = new ReposService(
      {} as never,
      { get: () => ({}), service: vi.fn() } as unknown as Application
    );

    await expect(service.patch(null, { repo_type: 'local' })).rejects.toThrow(
      /Bulk conversion to local repositories is unavailable/
    );
  });

  it('allows unrelated updates to historical local repository rows', async () => {
    const patched = { repo_id: 'repo-1', repo_type: 'local', slug: 'renamed' } as Repo;
    const adapterPatch = vi.spyOn(DrizzleService.prototype, 'patch').mockResolvedValue(patched);
    const service = new ReposService(
      {} as never,
      { get: () => ({}), service: vi.fn() } as unknown as Application
    );

    await expect(service.patch('repo-1', { slug: 'renamed' })).resolves.toBe(patched);
    expect(adapterPatch).toHaveBeenCalledWith('repo-1', { slug: 'renamed' }, undefined);
  });
});
