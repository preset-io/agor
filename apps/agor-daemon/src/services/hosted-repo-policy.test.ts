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
    vi.spyOn(BranchRepository.prototype, 'findByRepoAndName').mockResolvedValue(null);
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

  describe('tenant filesystem confinement', () => {
    const attackerParams = {
      provider: 'rest',
      user: { user_id: '550e8400-e29b-41d4-a716-446655440004', role: 'member' },
      tenant: { tenant_id: 'attacker' },
    } as never;
    const victimRepo = '/home/agor/.agor/tenants/victim/repos/acme/private-source';
    const victimCheckout = '/home/agor/.agor/tenants/victim/worktrees/acme/private-source/main';

    function hostedService() {
      return new ReposService(
        {} as never,
        { get: () => ({}), service: vi.fn() } as unknown as Application
      );
    }

    it.each([`file://${victimRepo}`, victimRepo])(
      'rejects a local clone source (%s) before creating any row',
      async (url) => {
        const service = hostedService();
        const create = vi.spyOn(service, 'create');

        await expect(
          service.cloneRepository({ url, slug: 'attacker/copied-private-source' }, attackerParams)
        ).rejects.toThrow(/HTTPS or SSH/);
        expect(create).not.toHaveBeenCalled();
      }
    );

    it('rejects a caller-selected local_path on create', async () => {
      const adapterCreate = vi.spyOn(DrizzleService.prototype, 'create');

      await expect(
        hostedService().create(
          {
            slug: 'attacker/copy' as never,
            repo_type: 'remote',
            remote_url: 'https://forge.example/attacker/copy.git',
            local_path: victimRepo,
          },
          attackerParams
        )
      ).rejects.toThrow(/local_path is managed by Agor/);
      expect(adapterCreate).not.toHaveBeenCalled();
    });

    it('rejects a local remote_url on create', async () => {
      await expect(
        hostedService().create(
          {
            slug: 'attacker/copy' as never,
            repo_type: 'remote',
            remote_url: `file://${victimRepo}`,
          },
          attackerParams
        )
      ).rejects.toThrow(/HTTPS or SSH/);
    });

    it('rejects repointing an owned row at another tenant checkout', async () => {
      const service = hostedService();
      vi.spyOn(service, 'get').mockResolvedValue({
        repo_id: 'repo-1',
        repo_type: 'remote',
        slug: 'attacker/copy',
        local_path: '/home/agor/.agor/tenants/attacker/repos/attacker/copy',
      } as Repo);
      const adapterPatch = vi.spyOn(DrizzleService.prototype, 'patch');
      const adapterUpdate = vi.spyOn(DrizzleService.prototype, 'update');

      await expect(
        service.patch(
          'repo-1',
          { local_path: victimCheckout, remote_url: 'https://attacker.example/drop.git' },
          attackerParams
        )
      ).rejects.toThrow(/local_path is managed by Agor/);
      await expect(
        service.update('repo-1', { local_path: victimCheckout }, attackerParams)
      ).rejects.toThrow(/local_path is managed by Agor/);
      await expect(
        service.patch(null, { local_path: victimCheckout }, attackerParams)
      ).rejects.toThrow(/local_path is managed by Agor/);
      expect(adapterPatch).not.toHaveBeenCalled();
      expect(adapterUpdate).not.toHaveBeenCalled();
    });

    it('rejects a local remote_url patch', async () => {
      await expect(
        hostedService().patch(
          'repo-1',
          { remote_url: 'file:///home/agor/.agor/tenants/attacker/drop.git' },
          attackerParams
        )
      ).rejects.toThrow(/HTTPS or SSH/);
    });

    it('accepts the executor re-sending the unchanged managed path', async () => {
      const localPath = '/home/agor/.agor/tenants/attacker/repos/attacker/copy';
      const service = hostedService();
      vi.spyOn(service, 'get').mockResolvedValue({
        repo_id: 'repo-1',
        repo_type: 'remote',
        local_path: localPath,
      } as Repo);
      const patched = { repo_id: 'repo-1', local_path: localPath } as Repo;
      vi.spyOn(DrizzleService.prototype, 'patch').mockResolvedValue(patched);

      await expect(
        service.patch('repo-1', { local_path: localPath, clone_status: 'cloning' }, attackerParams)
      ).resolves.toBe(patched);
    });
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
