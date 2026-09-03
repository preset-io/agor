import type { AgorConfig } from '@agor/core/config';
import { RepoRepository, UsersRepository } from '@agor/core/db';
import type { UserID } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBranchExecutorSandboxMounts } from './branch-executor-sandbox.js';

const db = { run: vi.fn() } as never;
const executionUserId = 'user-caller' as UserID;

function resolve(config: AgorConfig, overrides: Record<string, unknown> = {}) {
  return resolveBranchExecutorSandboxMounts({
    config,
    tenantId: 'tenant-a',
    executionUserId,
    branch: {
      repo_id: 'repo-1' as never,
      storage_mode: 'worktree',
    },
    db,
    ...overrides,
  });
}

describe('resolveBranchExecutorSandboxMounts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not resolve local mounts in simple or delegated execution', async () => {
    const userLookup = vi.spyOn(UsersRepository.prototype, 'getFilesystemHomeProjection');
    const repoLookup = vi.spyOn(RepoRepository.prototype, 'findById');

    await expect(resolve({ execution: { unix_user_mode: 'simple' } })).resolves.toEqual({});
    await expect(
      resolve({
        execution: {
          unix_user_mode: 'delegated',
          executor_command_template: 'launcher --user {user_id}',
        },
      })
    ).resolves.toEqual({});
    expect(userLookup).not.toHaveBeenCalled();
    expect(repoLookup).not.toHaveBeenCalled();
  });

  it('resolves shared-sandbox storage mounts without requiring an owner home', async () => {
    vi.spyOn(RepoRepository.prototype, 'findById').mockResolvedValue({
      local_path: '/srv/agor/repos/org/repo',
    } as never);
    const userLookup = vi.spyOn(UsersRepository.prototype, 'getFilesystemHomeProjection');

    await expect(
      resolve({
        paths: { data_home: '/srv/agor' },
        execution: { sandbox: { enabled: true, home_mode: 'shared' } },
      })
    ).resolves.toEqual({
      sandboxWorktreesRoot: '/srv/agor/worktrees',
      sandboxBaseRepoPath: '/srv/agor/repos/org/repo',
    });
    expect(userLookup).not.toHaveBeenCalled();
  });

  it('derives the canonical tenant/user home for the execution caller', async () => {
    vi.spyOn(RepoRepository.prototype, 'findById').mockResolvedValue({
      local_path: '/srv/agor-tenants/tenant-a/repos/org/repo',
    } as never);
    vi.spyOn(UsersRepository.prototype, 'getFilesystemHomeProjection').mockImplementation(
      async (userId) =>
        ({
          user_id: userId,
          filesystem_home: null,
        }) as never
    );

    await expect(
      resolve({
        paths: { data_home: '/srv/agor' },
        multi_tenancy: {
          mode: 'required_from_auth',
          filesystem_isolation_enabled: true,
          tenants_base_folder: '/srv/agor-tenants',
        },
        execution: {
          unix_user_mode: 'sandbox',
          sandbox: { enabled: true, home_mode: 'per_user' },
        },
      })
    ).resolves.toEqual({
      sandboxHomeStore: '/srv/agor-tenants/tenant-a/homes/user-caller',
      sandboxWorktreesRoot: '/srv/agor-tenants/tenant-a/worktrees',
      sandboxBaseRepoPath: '/srv/agor-tenants/tenant-a/repos/org/repo',
    });
    expect(UsersRepository.prototype.getFilesystemHomeProjection).toHaveBeenCalledWith(
      'user-caller'
    );
  });

  it('honors a validated filesystem_home override and omits a base-repo mount for clones', async () => {
    vi.spyOn(UsersRepository.prototype, 'getFilesystemHomeProjection').mockResolvedValue({
      user_id: executionUserId,
      filesystem_home: '/home/caller',
    } as never);
    const repoLookup = vi.spyOn(RepoRepository.prototype, 'findById');

    await expect(
      resolve(
        {
          paths: { data_home: '/srv/agor' },
          execution: { sandbox: { enabled: true, home_mode: 'per_user' } },
        },
        { branch: { repo_id: 'repo-1', storage_mode: 'clone' } }
      )
    ).resolves.toEqual({
      sandboxHomeStore: '/home/caller',
      sandboxWorktreesRoot: '/srv/agor/worktrees',
    });
    expect(repoLookup).not.toHaveBeenCalled();
  });

  it('fails closed when the execution caller no longer has a tenant user row', async () => {
    vi.spyOn(RepoRepository.prototype, 'findById').mockResolvedValue(null);
    vi.spyOn(UsersRepository.prototype, 'getFilesystemHomeProjection').mockResolvedValue(null);

    await expect(
      resolve({
        paths: { data_home: '/srv/agor' },
        execution: { sandbox: { enabled: true, home_mode: 'per_user' } },
      })
    ).rejects.toThrow(
      'Cannot resolve per-user sandbox home: execution user user-caller was not found'
    );
  });
});
