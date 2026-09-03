import {
  getCurrentTenantDatabaseScope,
  RepoRepository,
  runWithTenantContext,
  UsersRepository,
} from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestExecutor } from '../utils/spawn-executor.js';
import { FileService } from './file.js';

const impersonationMocks = vi.hoisted(() => ({
  resolveDelegatedExecutionHomeKey: vi.fn(),
}));

vi.mock('../utils/executor-delegated-home.js', () => ({
  resolveDelegatedExecutionHomeKey: impersonationMocks.resolveDelegatedExecutionHomeKey,
}));

vi.mock('../utils/spawn-executor.js', () => ({
  getDaemonUrl: vi.fn(() => 'http://daemon.test'),
  requestExecutor: vi.fn(),
}));

function createApp(config = {}) {
  return {
    get: () => config,
    sessionTokenService: { generateCommandToken: vi.fn(async () => 'user-token') },
  } as never;
}

const branch = {
  branch_id: 'branch-1',
  path: '/tenant-a/branch-1',
  repo_id: 'repo-1',
  storage_mode: 'worktree',
  primary_owner_user_id: 'branch-owner',
};

function createBranchRepo(
  findById = vi.fn().mockResolvedValue(branch),
  fsAccess: 'none' | 'read' | 'write' = 'read'
) {
  return {
    findById,
    resolveUserAccess: vi.fn().mockResolvedValue({
      can: 'view',
      fs_access: fsAccess,
      is_owner: false,
      source: 'others',
    }),
  } as never;
}

describe('FileService executor failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    impersonationMocks.resolveDelegatedExecutionHomeKey.mockResolvedValue(undefined);
  });

  it('does not report executor failure as an empty repository', async () => {
    vi.mocked(requestExecutor).mockResolvedValue({
      success: false,
      error: { code: 'EXECUTOR_FAILED', message: 'executor unavailable' },
    });
    const service = new FileService(createBranchRepo(), { run: vi.fn() } as never, createApp());

    await expect(
      runWithTenantContext('tenant-a', () =>
        service.find({
          query: { branch_id: 'branch-1' },
          user: {
            user_id: 'user-1',
            email: 'member@example.com',
            role: 'member',
          },
        })
      )
    ).rejects.toThrow('Failed to browse files: executor unavailable');
  });

  it.each([
    {
      operation: 'listing',
      invoke: (service: FileService, params: Parameters<FileService['find']>[0]) =>
        service.find(params),
      command: 'branch.files.browse',
      data: { files: [] },
    },
    {
      operation: 'reading/preview',
      invoke: (service: FileService, params: Parameters<FileService['get']>[1]) =>
        service.get('README.md', params),
      command: 'branch.files.read',
      data: {
        file: {
          path: 'README.md',
          title: 'README',
          size: 0,
          lastModified: '2026-07-30T00:00:00.000Z',
          isText: true,
          mimeType: 'text/markdown',
          content: '',
          encoding: 'utf-8',
        },
      },
    },
  ])(
    'passes the resolved execution-substrate identity through file $operation',
    async ({ invoke, command, data }) => {
      impersonationMocks.resolveDelegatedExecutionHomeKey.mockResolvedValue('alice');
      vi.mocked(requestExecutor).mockResolvedValue({ success: true, data });
      const service = new FileService(createBranchRepo(), { run: vi.fn() } as never, createApp());
      const params = {
        query: { branch_id: 'branch-1' },
        user: {
          user_id: 'user-1',
          email: 'member@example.com',
          role: 'member' as const,
        },
      };

      await runWithTenantContext('tenant-a', () => invoke(service, params));

      expect(requestExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          command,
          params: expect.objectContaining({
            cwd: '/tenant-a/branch-1',
            principalBranchAccess: 'read',
          }),
        }),
        expect.objectContaining({
          delegatedHomeKey: 'alice',
          templateVariables: {
            branch_id: 'branch-1',
            user_id: 'user-1',
            branch_fs_access: 'read',
          },
        })
      );
    }
  );

  it('passes the caller-scoped canonical home and tenant mounts to the per-user sandbox', async () => {
    vi.spyOn(UsersRepository.prototype, 'findById').mockResolvedValue({
      user_id: 'user-1',
      filesystem_home: null,
    } as never);
    vi.spyOn(RepoRepository.prototype, 'findById').mockResolvedValue({
      local_path: '/srv/tenants/tenant-a/repos/org/repo',
    } as never);
    vi.mocked(requestExecutor).mockResolvedValue({ success: true, data: { files: [] } });
    const service = new FileService(
      createBranchRepo(),
      { run: vi.fn() } as never,
      createApp({
        paths: { data_home: '/srv/agor' },
        multi_tenancy: {
          mode: 'required_from_auth',
          filesystem_isolation_enabled: true,
          tenants_base_folder: '/srv/tenants',
        },
        execution: { sandbox: { enabled: true, home_mode: 'per_user' } },
      })
    );

    await runWithTenantContext('tenant-a', () =>
      service.find({
        query: { branch_id: 'branch-1' },
        user: { user_id: 'user-1', email: 'member@example.com', role: 'member' },
      })
    );

    expect(requestExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          sandboxHomeStore: '/srv/tenants/tenant-a/homes/user-1',
          sandboxWorktreesRoot: '/srv/tenants/tenant-a/worktrees',
          sandboxBaseRepoPath: '/srv/tenants/tenant-a/repos/org/repo',
        }),
      }),
      expect.objectContaining({
        templateVariables: expect.objectContaining({ user_id: 'user-1' }),
      })
    );
    expect(UsersRepository.prototype.findById).toHaveBeenCalledWith('user-1');
    expect(JSON.stringify(vi.mocked(requestExecutor).mock.calls[0])).not.toContain('branch-owner');
  });

  it('scopes database reads but leaves executor work outside the transaction', async () => {
    const db = { run: vi.fn() } as never;
    const findById = vi.fn(async () => {
      expect(getCurrentTenantDatabaseScope()?.tenantId).toBe('tenant-a');
      return { branch_id: 'branch-1' };
    });
    impersonationMocks.resolveDelegatedExecutionHomeKey.mockImplementation(async () => {
      expect(getCurrentTenantDatabaseScope()?.tenantId).toBe('tenant-a');
      return 'alice';
    });
    vi.mocked(requestExecutor).mockImplementation(async () => {
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      return { success: true, data: { files: [] } };
    });
    const service = new FileService(createBranchRepo(findById), db, createApp());

    await runWithTenantContext('tenant-a', () =>
      service.find({
        query: { branch_id: 'branch-1' },
        user: { user_id: 'user-1', email: 'member@example.com', role: 'member' },
      })
    );

    expect(findById).toHaveBeenCalledOnce();
    expect(requestExecutor).toHaveBeenCalledOnce();
  });

  it('fails before repository access when tenant identity is missing', async () => {
    const findById = vi.fn();
    const service = new FileService(
      createBranchRepo(findById),
      { run: vi.fn() } as never,
      createApp()
    );

    await expect(
      service.find({
        query: { branch_id: 'branch-1' },
        user: { user_id: 'user-1', email: 'member@example.com', role: 'member' },
      })
    ).rejects.toThrow('Missing active tenant context for file database access');
    expect(findById).not.toHaveBeenCalled();
  });

  it('reuses the branch authorized by the registered RBAC preload', async () => {
    const findById = vi.fn();
    vi.mocked(requestExecutor).mockResolvedValue({ success: true, data: { files: [] } });
    const service = new FileService(
      createBranchRepo(findById),
      { run: vi.fn() } as never,
      createApp()
    );

    await runWithTenantContext('tenant-a', () =>
      service.find({
        query: { branch_id: 'branch-1' },
        branch: { branch_id: 'branch-1', path: '/tenant-a/branch-1' },
        user: { user_id: 'user-1', email: 'member@example.com', role: 'member' },
      } as never)
    );

    expect(findById).not.toHaveBeenCalled();
    expect(requestExecutor).toHaveBeenCalledOnce();
  });

  it('requires normalized filesystem read access even when the branch is viewable', async () => {
    const service = new FileService(
      createBranchRepo(undefined, 'none'),
      { run: vi.fn() } as never,
      createApp()
    );

    await expect(
      runWithTenantContext('tenant-a', () =>
        service.find({
          query: { branch_id: 'branch-1' },
          user: { user_id: 'user-1', email: 'member@example.com', role: 'member' },
        })
      )
    ).rejects.toThrow('branch filesystem read access required');
    expect(requestExecutor).not.toHaveBeenCalled();
  });
});
