import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  RepoRepository,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchID, RepoSlug, UUID } from '@agor/core/types';
import { vi } from 'vitest';
import { ownedDbTest as dbTest } from '../../../../packages/core/src/db/test-helpers';
import { BranchesService } from './branches';
import { ReposService } from './repos';

dbTest(
  'rejects repository deletion before touching remaining branches and emits no tombstones',
  async ({ db }) => {
    const repoRepository = new RepoRepository(db);
    const branchRepository = new BranchRepository(db);
    const repo = await repoRepository.create({
      repo_id: generateId() as UUID,
      slug: 'repo-removal-rollback',
      name: 'Repo removal rollback',
      repo_type: 'remote',
      remote_url: 'https://github.com/preset-io/agor.git',
      local_path: '/tmp/repo-removal-rollback',
      default_branch: 'main',
    });
    const branchIds = [generateId() as BranchID, generateId() as BranchID];
    for (const [index, branchId] of branchIds.entries()) {
      await branchRepository.create({
        branch_id: branchId,
        repo_id: repo.repo_id,
        created_by: 'test-user' as UUID,
        name: `rollback-branch-${index}`,
        ref: `rollback-branch-${index}`,
        branch_unique_id: 8000 + index,
        path: `/tmp/rollback-branch-${index}`,
        others_can: 'view',
      });
    }

    const branchEmit = vi.fn();
    let branchesService!: BranchesService;
    const app = {
      get: vi.fn(() => ({})),
      service: vi.fn((path: string) => {
        if (path === 'branches') return branchesService;
        throw new Error(`Unexpected service: ${path}`);
      }),
    } as unknown as Application;
    const serviceDb = createTenantScopedDatabaseProxy(db);
    branchesService = new BranchesService(serviceDb, app);
    branchesService.emit = branchEmit;
    const reposService = new ReposService(serviceDb, app);
    const serviceRepo = (reposService as unknown as { repoRepo: RepoRepository }).repoRepo;
    vi.spyOn(serviceRepo, 'delete').mockRejectedValueOnce(
      new Error('forced final repository deletion failure')
    );

    // Production reaches `remove` through the Feathers tenant around-hook, which
    // wraps the whole call in an ambient tenant DB scope. Reproduce that here so
    // the armed scope guard sees the same declared tenancy intent the HTTP path
    // provides; `remove`'s prologue reads run in this scope, then it opens its
    // own native transaction for the atomic delete.
    await expect(
      runWithTenantDatabaseScope(serviceDb, 'tenant-a', () =>
        reposService.remove(repo.repo_id, {
          tenant: { tenant_id: 'tenant-a', source: 'explicit' },
        } as never)
      )
    ).rejects.toThrow('branches first');

    expect(await repoRepository.findById(repo.repo_id)).not.toBeNull();
    for (const branchId of branchIds) {
      expect(await branchRepository.findById(branchId)).not.toBeNull();
    }
    expect(branchEmit).not.toHaveBeenCalled();
  }
);

dbTest(
  'only an admin may remove a shared repository, checked before any lookup',
  async ({ db }) => {
    const repoRepository = new RepoRepository(db);
    const repo = await repoRepository.create({
      repo_id: generateId() as UUID,
      slug: 'acme/shared' as RepoSlug,
      name: 'Shared',
      repo_type: 'remote',
      remote_url: 'https://github.com/acme/shared.git',
      local_path: '/tmp/repo-removal-admin',
      default_branch: 'main',
    });
    const app = {
      get: vi.fn(() => ({})),
      service: vi.fn((path: string) => {
        if (path === 'branches') return {};
        throw new Error(`Unexpected service: ${path}`);
      }),
    } as unknown as Application;
    const serviceDb = createTenantScopedDatabaseProxy(db);
    const reposService = new ReposService(serviceDb, app);
    reposService.emit = vi.fn();
    const get = vi.spyOn(reposService, 'get');
    const caller = (role: string, provider = 'rest') =>
      ({
        provider,
        user: { user_id: 'caller', role },
        tenant: { tenant_id: 'tenant-a', source: 'explicit' },
      }) as never;
    const remove = (id: string, params: never) =>
      runWithTenantDatabaseScope(serviceDb, 'tenant-a', () => reposService.remove(id, params));
    const denied = 'Admin access is required to change repository settings';

    for (const params of [caller('member'), caller('member', 'socketio'), caller('viewer')]) {
      await expect(remove(repo.repo_id, params)).rejects.toThrow(denied);
    }
    // A missing repository answers the same, so the denial is no existence oracle.
    await expect(remove(generateId(), caller('member'))).rejects.toThrow(denied);
    expect(get).not.toHaveBeenCalled();
    expect(await repoRepository.findById(repo.repo_id)).toEqual(repo);

    await expect(remove(repo.repo_id, caller('admin'))).resolves.toMatchObject({
      repo_id: repo.repo_id,
    });
    expect(await repoRepository.findById(repo.repo_id)).toBeNull();
  }
);
