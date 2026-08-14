import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createExecutorClient: vi.fn(),
  diagnoseGit: vi.fn(),
  parseAgorYml: vi.fn(),
  writeAgorYml: vi.fn(),
  deleteBranchDirectory: vi.fn(),
  listGitWorktrees: vi.fn(),
  removeGitWorktree: vi.fn(),
  deleteRepoDirectory: vi.fn(),
  cloneRepo: vi.fn(),
  createBranchAsClone: vi.fn(),
  getReposDir: vi.fn(() => '/safe/repos'),
  addConfig: vi.fn(),
  gitRaw: vi.fn(),
  isValidGitRepo: vi.fn(),
  getDefaultBranch: vi.fn(),
  getRemoteUrl: vi.fn(),
  scanGitConfigRemoteCredentials: vi.fn(),
  scrubGitConfigRemoteCredentials: vi.fn(),
  handleUnixSyncRepo: vi.fn(),
  handleUnixSyncBranch: vi.fn(),
  userHome: '/passwd/home',
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, userInfo: vi.fn(() => ({ homedir: mocks.userHome })) };
});

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/config');
  return {
    ...actual,
    getReposDir: mocks.getReposDir,
  };
});

vi.mock('@agor/core/config/node', () => ({
  parseAgorYml: mocks.parseAgorYml,
  writeAgorYml: mocks.writeAgorYml,
}));

vi.mock('../git/index.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../git/index.js');
  return {
    ...actual,
    createGit: vi.fn(() => ({ git: { addConfig: mocks.addConfig, raw: mocks.gitRaw } })),
    cloneRepo: mocks.cloneRepo,
    createBranchAsClone: mocks.createBranchAsClone,
    deleteBranchDirectory: mocks.deleteBranchDirectory,
    listGitWorktrees: mocks.listGitWorktrees,
    removeGitWorktree: mocks.removeGitWorktree,
    deleteRepoDirectory: mocks.deleteRepoDirectory,
    isValidGitRepo: mocks.isValidGitRepo,
    getDefaultBranch: mocks.getDefaultBranch,
    getRemoteUrl: mocks.getRemoteUrl,
    scanGitConfigRemoteCredentials: mocks.scanGitConfigRemoteCredentials,
    scrubGitConfigRemoteCredentials: mocks.scrubGitConfigRemoteCredentials,
  };
});

vi.mock('@agor/git', async () => {
  const actual = await vi.importActual<typeof import('@agor/git')>('@agor/git');
  return { ...actual, diagnoseGit: mocks.diagnoseGit };
});

vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: mocks.createExecutorClient,
  getExecutorBranchesService: (client: { service: (name: string) => unknown }) =>
    client.service('branches'),
  getExecutorReposService: (client: { service: (name: string) => unknown }) =>
    client.service('repos'),
}));

vi.mock('./unix.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./unix.js');
  return {
    ...actual,
    handleUnixSyncRepo: mocks.handleUnixSyncRepo,
    handleUnixSyncBranch: mocks.handleUnixSyncBranch,
  };
});

import {
  handleBranchAgorYmlExport,
  handleBranchAgorYmlImport,
  handleGitBranchAdd,
  handleGitBranchRemove,
  handleGitClone,
  handleGitManagedCredentialsReconcile,
  handleGitRepoDelete,
  handleGitRepoInspect,
} from './git.js';

const repoId = '550e8400-e29b-41d4-a716-446655440001';
const branchId = '550e8400-e29b-41d4-a716-446655440002';
const repoDeleteOperationId = '550e8400-e29b-41d4-a716-446655440098';
const deleteRoots = {
  reposRoot: '/safe/repos',
  branchesRoot: '/safe/worktrees',
  filesystemOperationId: repoDeleteOperationId,
};
const repoDeleteLifecycle = {
  filesystem_status: 'deleting',
  filesystem_operation_id: repoDeleteOperationId,
};

function createClient(records: {
  repo?: Record<string, unknown>;
  repoPages?: Array<Array<Record<string, unknown>>>;
  branches?: Array<Record<string, unknown>>;
  branchPages?: Array<Array<Record<string, unknown>>>;
  branch?: Record<string, unknown>;
  branchFindQueries?: Array<Record<string, unknown>>;
  patchedRepos?: Array<Record<string, unknown>>;
  patchedBranches?: Array<Record<string, unknown>>;
}) {
  const client = {
    io: { disconnect: vi.fn() },
    service: vi.fn((name: string) => {
      if (name === 'repos') {
        const find = vi.fn(
          async ({ query }: { query?: { $skip?: number; $limit?: number } } = {}) => {
            const allRepos = records.repoPages?.flat() ?? (records.repo ? [records.repo] : []);
            const skip = query?.$skip ?? 0;
            const limit = query?.$limit ?? 1000;
            return {
              data: allRepos.slice(skip, skip + limit),
              total: allRepos.length,
              limit,
              skip,
            };
          }
        );
        return {
          get: vi.fn(async () =>
            records.repo || records.branch
              ? { repo_id: repoId, slug: 'repo', ...(records.repo ?? {}) }
              : undefined
          ),
          patch: vi.fn(async (_id: string, data: Record<string, unknown>) => {
            records.patchedRepos?.push(data);
            return { ...(records.repo ?? {}), ...data };
          }),
          create: vi.fn(async (data: Record<string, unknown>) => data),
          find,
        };
      }
      if (name === 'users') {
        return { getGitEnvironment: vi.fn(async () => ({})) };
      }
      if (name === 'branches') {
        const find = vi.fn(
          async ({ query }: { query?: { $skip?: number; $limit?: number } } = {}) => {
            records.branchFindQueries?.push(query ?? {});
            if (records.branchPages) {
              const skip = query?.$skip ?? 0;
              const limit = query?.$limit ?? 1000;
              const allBranches = records.branchPages.flat();
              return {
                data: allBranches.slice(skip, skip + limit),
                total: allBranches.length,
                limit,
                skip,
              };
            }
            const data = records.branches ?? [];
            return {
              data,
              total: data.length,
              limit: query?.$limit ?? data.length,
              skip: query?.$skip ?? 0,
            };
          }
        );
        return {
          get: vi.fn(async () =>
            records.branch
              ? {
                  filesystem_status: 'creating',
                  filesystem_operation_id: '550e8400-e29b-41d4-a716-446655440099',
                  repo_id: repoId,
                  name: 'feature',
                  ...records.branch,
                }
              : undefined
          ),
          find,
          patch: vi.fn(async (_id: string, data: Record<string, unknown>) => {
            records.patchedBranches?.push(data);
            return { ...(records.branch ?? {}), ...data };
          }),
        };
      }
      throw new Error(`unexpected service ${name}`);
    }),
  };
  mocks.createExecutorClient.mockResolvedValue(client);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getReposDir.mockReturnValue('/safe/repos');
  mocks.diagnoseGit.mockResolvedValue({
    status: 'ready',
    binary: '/usr/bin/git',
    version: '2.47.1',
  });
  mocks.gitRaw.mockImplementation(async (args: string[]) => {
    if (args.includes('status')) return '';
    if (args.includes('--abbrev-ref')) return 'main\n';
    if (args.includes('HEAD')) return 'sha-abc\n';
    return '';
  });
  mocks.cloneRepo.mockResolvedValue({
    path: '/safe/repos/smoke/agor-assistant-pr1258',
    repoName: 'agor-assistant',
    defaultBranch: 'main',
  });
  mocks.createBranchAsClone.mockResolvedValue({ path: '/trusted/branch', ref: 'main' });
  mocks.removeGitWorktree.mockResolvedValue(undefined);
  mocks.listGitWorktrees.mockResolvedValue([]);
  mocks.isValidGitRepo.mockResolvedValue(true);
  mocks.getDefaultBranch.mockResolvedValue('main');
  mocks.getRemoteUrl.mockResolvedValue('https://user:secret@example.com/org/repo.git');
  mocks.scanGitConfigRemoteCredentials.mockResolvedValue({
    findings: [{ configPath: '/repo/.git/config' }],
  });
  mocks.scrubGitConfigRemoteCredentials.mockResolvedValue({ findings: [] });
  mocks.handleUnixSyncRepo.mockResolvedValue({
    success: true,
    data: { groupName: 'agor_repo_test' },
  });
  mocks.handleUnixSyncBranch.mockResolvedValue({
    success: true,
    data: { groupName: 'agor_wt_test' },
  });
});

describe('managed executor git/fs commands', () => {
  it('fails closed before clone when executor Git is unavailable', async () => {
    const patchedRepos: Array<Record<string, unknown>> = [];
    createClient({ repo: { repo_id: repoId }, patchedRepos });
    mocks.diagnoseGit.mockResolvedValueOnce({
      status: 'missing',
      detail: 'Git executable is unavailable. Install Git and retry.',
    });

    const result = await handleGitClone(
      {
        command: 'git.clone',
        sessionToken: 'tenant-token',
        params: {
          url: 'https://example.com/repo.git',
          slug: 'repo',
          repoId,
          createDbRecord: false,
        },
      },
      {}
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: 'GIT_CLONE_FAILED', message: expect.stringContaining('Install Git') },
    });
    expect(mocks.cloneRepo).not.toHaveBeenCalled();
    expect(patchedRepos).toContainEqual(
      expect.objectContaining({
        clone_status: 'failed',
        clone_error: expect.objectContaining({ category: 'git_unavailable' }),
      })
    );
  });

  it('resolves trusted repo metadata just-in-time inside git.branch.add', async () => {
    createClient({
      repo: {
        repo_id: repoId,
        slug: 'preset-io/agor',
        local_path: '/trusted/repo',
        remote_url: 'https://user:secret@example.com/trusted/repo.git',
      },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        path: '/safe/worktrees/preset-io/agor/feature',
        name: 'feature',
        ref: 'trusted-ref',
        base_ref: 'trusted-base',
        new_branch: true,
        ref_type: 'branch',
        storage_mode: 'clone',
        clone_depth: 42,
      },
    });

    const result = await handleGitBranchAdd(
      {
        command: 'git.branch.add',
        sessionToken: 'tenant-token',
        params: {
          branchId,
          filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
          repoId,
          branchesRoot: '/safe/worktrees',
          useReference: true,
        },
      },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.createBranchAsClone).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteUrl: 'https://example.com/trusted/repo.git',
        ref: 'trusted-base',
        newBranchName: 'trusted-ref',
        depth: 42,
        referencePath: '/trusted/repo',
      })
    );
  });

  it('runs branch isolation in the current lifecycle executor and fails closed', async () => {
    const patchedBranches: Array<Record<string, unknown>> = [];
    createClient({
      repo: {
        repo_id: repoId,
        slug: 'preset-io/agor',
        local_path: '/trusted/repo',
        remote_url: 'https://example.com/repo.git',
      },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        path: '/safe/worktrees/preset-io/agor/feature',
        name: 'feature',
        ref: 'feature',
        base_ref: 'main',
        new_branch: true,
        ref_type: 'branch',
        storage_mode: 'clone',
      },
      patchedBranches,
    });
    mocks.handleUnixSyncBranch.mockResolvedValueOnce({
      success: false,
      error: { code: 'UNIX_SYNC_BRANCH_FAILED', message: 'setfacl failed' },
    });

    const result = await handleGitBranchAdd(
      {
        command: 'git.branch.add',
        sessionToken: 'tenant-token',
        params: {
          branchId,
          filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
          repoId,
          branchesRoot: '/safe/worktrees',
          initUnixGroup: true,
          daemonUser: 'agor',
        },
      },
      {}
    );

    expect(mocks.handleUnixSyncBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'unix.sync-branch',
        sessionToken: 'tenant-token',
        params: { branchId, daemonUser: 'agor' },
      }),
      {}
    );
    expect(result).toMatchObject({ success: false, error: { message: 'setfacl failed' } });
    expect(patchedBranches).toContainEqual(
      expect.objectContaining({ filesystem_status: 'failed' })
    );
    expect(patchedBranches).not.toContainEqual(
      expect.objectContaining({ filesystem_status: 'ready' })
    );
  });

  it('denies missing tenant-scoped repo before filesystem materialization', async () => {
    mocks.createExecutorClient.mockResolvedValueOnce({
      io: { disconnect: vi.fn() },
      service: vi.fn(() => ({
        get: vi.fn(async () => {
          throw new Error('Not found');
        }),
      })),
    });
    const result = await handleGitBranchAdd(
      {
        command: 'git.branch.add',
        sessionToken: 'other-tenant-token',
        params: {
          branchId,
          filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
          repoId,
          branchesRoot: '/safe/worktrees',
        },
      },
      {}
    );
    expect(result).toMatchObject({ success: false, error: { message: 'Not found' } });
    expect(mocks.createBranchAsClone).not.toHaveBeenCalled();
  });

  it('does not materialize or repair files for a superseded creation generation', async () => {
    const patchedBranches: Array<Record<string, unknown>> = [];
    createClient({
      repo: {
        repo_id: repoId,
        local_path: '/trusted/repo',
        remote_url: 'https://example.com/repo.git',
      },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        path: '/trusted/branch',
        name: 'feature',
        storage_mode: 'clone',
        filesystem_status: 'creating',
        filesystem_operation_id: '550e8400-e29b-41d4-a716-446655440098',
      },
      patchedBranches,
    });

    const result = await handleGitBranchAdd(
      {
        command: 'git.branch.add',
        sessionToken: 'tenant-token',
        params: {
          branchId,
          filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
          repoId,
          branchesRoot: '/safe/worktrees',
        },
      },
      {}
    );

    expect(result).toMatchObject({ success: false, error: { code: 'GIT_BRANCH_ADD_FAILED' } });
    expect(mocks.createBranchAsClone).not.toHaveBeenCalled();
    expect(mocks.handleUnixSyncBranch).not.toHaveBeenCalled();
    expect(patchedBranches).toEqual([]);
  });

  it('inspects local repository contents only inside the executor and returns sanitized metadata', async () => {
    const result = await handleGitRepoInspect(
      {
        command: 'git.repo.inspect',
        params: { path: '/repo' },
      },
      {}
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        path: '/repo',
        defaultBranch: 'main',
        remoteUrl: 'https://example.com/org/repo.git',
        credentialFindingCount: 1,
      },
    });
  });

  it('returns canonical realpath identity when a local repository is registered through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-repo-inspect-symlink-'));
    const target = join(root, 'target');
    const alias = join(root, 'alias');
    await mkdir(target);
    await symlink(target, alias);
    try {
      const result = await handleGitRepoInspect(
        { command: 'git.repo.inspect', params: { path: alias } },
        {}
      );
      expect(result).toMatchObject({ success: true, data: { path: target } });
      expect(mocks.isValidGitRepo).toHaveBeenCalledWith(target);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('expands tilde from passwd user info rather than a misleading HOME', async () => {
    const oldHome = process.env.HOME;
    process.env.HOME = '/daemon/home';
    try {
      await handleGitRepoInspect({ command: 'git.repo.inspect', params: { path: '~/repo' } }, {});
      expect(mocks.isValidGitRepo).toHaveBeenCalledWith('/passwd/home/repo');
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it('continues inspection with a safe diagnostic when .agor.yml is malformed', async () => {
    mocks.parseAgorYml.mockImplementationOnce(() => {
      throw new Error('secret malformed contents');
    });
    const result = await handleGitRepoInspect(
      { command: 'git.repo.inspect', params: { path: '/repo' } },
      {}
    );
    expect(result).toMatchObject({
      success: true,
      data: { environmentWarning: expect.stringContaining('Failed to parse .agor.yml') },
    });
    expect(JSON.stringify(result)).not.toContain('secret malformed contents');
  });

  it('rejects an invalid local repository', async () => {
    mocks.isValidGitRepo.mockResolvedValueOnce(false);
    const result = await handleGitRepoInspect(
      { command: 'git.repo.inspect', params: { path: '/not-repo' } },
      {}
    );
    expect(result).toMatchObject({ success: false, error: { code: 'GIT_REPO_INSPECT_FAILED' } });
  });

  it('paginates self-hosted reconciliation and dry-run does not mutate configs', async () => {
    createClient({
      repoPages: [
        Array.from({ length: 1000 }, (_, index) => ({
          repo_id: `local-${index}`,
          repo_type: 'local',
        })),
        [{ repo_id: repoId, repo_type: 'remote', local_path: '/managed/repo' }],
      ],
      branches: [
        {
          branch_id: branchId,
          repo_id: repoId,
          path: '/managed/archived',
          archived: true,
        },
      ],
    });

    const result = await handleGitManagedCredentialsReconcile(
      {
        command: 'git.managed-credentials.reconcile',
        sessionToken: 'tenant-token',
        params: {},
      },
      { dryRun: true }
    );

    expect(result).toMatchObject({ success: true, data: { dryRun: true } });
    expect(mocks.scrubGitConfigRemoteCredentials).not.toHaveBeenCalled();
  });

  it('reconciles active and archived branches without an unsupported archived query operator', async () => {
    const activePath = '/managed/active';
    const archivedPath = '/managed/archived';
    const branchFindQueries: Array<Record<string, unknown>> = [];
    createClient({
      repo: { repo_id: repoId, repo_type: 'remote', local_path: '/managed/repo' },
      branchFindQueries,
      branches: [
        { branch_id: branchId, repo_id: repoId, path: activePath, archived: false },
        { branch_id: 'archived-branch', repo_id: repoId, path: archivedPath, archived: true },
      ],
    });

    const result = await handleGitManagedCredentialsReconcile(
      {
        command: 'git.managed-credentials.reconcile',
        sessionToken: 'tenant-token',
        params: {},
      },
      {}
    );

    expect(result).toMatchObject({ success: true });
    expect(mocks.scrubGitConfigRemoteCredentials).toHaveBeenCalledWith(activePath);
    expect(mocks.scrubGitConfigRemoteCredentials).toHaveBeenCalledWith(archivedPath);
    expect(branchFindQueries).toEqual([{ repo_id: repoId, $limit: 1000, $skip: 0 }]);
  });
  it('uses the daemon-provided tenant root when removing a branch directory', async () => {
    const branchesRoot = await mkdtemp(join(tmpdir(), 'agor-tenant-worktrees-'));
    const branchPath = join(branchesRoot, 'repo', 'feature');
    await mkdir(branchPath, { recursive: true });
    const patchedBranches: Array<Record<string, unknown>> = [];
    createClient({
      branch: {
        branch_id: branchId,
        path: branchPath,
        storage_mode: 'clone',
        filesystem_status: 'deleting',
      },
      patchedBranches,
    });
    mocks.deleteBranchDirectory.mockImplementationOnce(async () => {
      await rm(branchPath, { recursive: true, force: true });
    });

    try {
      const result = await handleGitBranchRemove(
        {
          command: 'git.branch.remove',
          sessionToken: 'jwt',
          params: {
            branchId,
            filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
            branchPath,
            branchesRoot,
            storageMode: 'clone',
            privilegedFilesystemDelete: true,
            deleteDbRecord: false,
          },
        },
        {}
      );

      expect(result.success).toBe(true);
      expect(mocks.deleteBranchDirectory).toHaveBeenCalledWith(branchPath, branchesRoot, {
        expectedRelativePath: join('repo', 'feature'),
        privileged: true,
      });
      expect(patchedBranches).toContainEqual({ filesystem_status: 'deleted' });
    } finally {
      await rm(branchesRoot, { recursive: true, force: true });
    }
  });

  it('refuses payload path drift and persists a sanitized retryable failure', async () => {
    const patchedBranches: Array<Record<string, unknown>> = [];
    createClient({
      branch: {
        branch_id: branchId,
        path: '/safe/worktrees/repo/persisted',
        storage_mode: 'clone',
        filesystem_status: 'deleting',
      },
      patchedBranches,
    });

    const result = await handleGitBranchRemove(
      {
        command: 'git.branch.remove',
        sessionToken: 'jwt',
        params: {
          branchId,
          filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
          branchPath: '/safe/worktrees/repo/from-payload',
          branchesRoot: '/safe/worktrees',
          storageMode: 'clone',
          privilegedFilesystemDelete: true,
          deleteDbRecord: false,
        },
      },
      {}
    );

    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('safety check') },
    });
    expect(mocks.deleteBranchDirectory).not.toHaveBeenCalled();
    expect(patchedBranches).toContainEqual({
      filesystem_status: 'delete_failed',
      error_message: expect.stringContaining('safety check'),
    });
    expect(JSON.stringify(result)).not.toContain('/safe/worktrees/repo/from-payload');
  });

  it('refuses a legacy branch root that aliases another repository worktree namespace', async () => {
    const patchedBranches: Array<Record<string, unknown>> = [];
    const legacyRepo = {
      repo_id: repoId,
      slug: 'org',
      local_path: '/safe/repos/org-legacy',
    };
    createClient({
      repo: legacyRepo,
      repoPages: [
        [
          legacyRepo,
          {
            repo_id: '550e8400-e29b-41d4-a716-446655440099',
            slug: 'org/repo',
            local_path: '/safe/repos/org/repo',
          },
        ],
      ],
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        name: 'repo',
        path: '/safe/worktrees/org/repo',
        storage_mode: 'clone',
        filesystem_status: 'deleting',
      },
      branches: [
        {
          branch_id: branchId,
          repo_id: repoId,
          name: 'repo',
          path: '/safe/worktrees/org/repo',
        },
      ],
      patchedBranches,
    });

    const result = await handleGitBranchRemove(
      {
        command: 'git.branch.remove',
        sessionToken: 'jwt',
        params: {
          branchId,
          filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
          branchPath: '/safe/worktrees/org/repo',
          branchesRoot: '/safe/worktrees',
          storageMode: 'clone',
          deleteDbRecord: false,
        },
      },
      {}
    );

    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('safety check') },
    });
    expect(mocks.deleteBranchDirectory).not.toHaveBeenCalled();
    expect(patchedBranches).toContainEqual({
      filesystem_status: 'delete_failed',
      error_message: expect.stringContaining('safety check'),
    });
  });

  it('refuses a persisted branch name that can traverse out of its canonical root', async () => {
    const patchedBranches: Array<Record<string, unknown>> = [];
    createClient({
      branch: {
        branch_id: branchId,
        name: '../victim',
        path: '/safe/worktrees/victim',
        storage_mode: 'clone',
        filesystem_status: 'deleting',
      },
      patchedBranches,
    });

    const result = await handleGitBranchRemove(
      {
        command: 'git.branch.remove',
        sessionToken: 'jwt',
        params: {
          branchId,
          filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
          branchPath: '/safe/worktrees/victim',
          branchesRoot: '/safe/worktrees',
          storageMode: 'clone',
          privilegedFilesystemDelete: true,
          deleteDbRecord: false,
        },
      },
      {}
    );

    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('safety check') },
    });
    expect(mocks.deleteBranchDirectory).not.toHaveBeenCalled();
    expect(patchedBranches).toContainEqual({
      filesystem_status: 'delete_failed',
      error_message: expect.stringContaining('safety check'),
    });
  });

  it.each(['org/intermediate/../agor', 'org/./agor', '../agor'])(
    'refuses an unsafe persisted repository slug before branch deletion: %s',
    async (slug) => {
      const patchedBranches: Array<Record<string, unknown>> = [];
      createClient({
        repo: { repo_id: repoId, slug },
        branch: {
          branch_id: branchId,
          repo_id: repoId,
          name: 'feature',
          path: '/safe/worktrees/org/agor/feature',
          storage_mode: 'clone',
          filesystem_status: 'deleting',
        },
        patchedBranches,
      });

      const result = await handleGitBranchRemove(
        {
          command: 'git.branch.remove',
          sessionToken: 'jwt',
          params: {
            branchId,
            filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
            branchPath: '/safe/worktrees/org/agor/feature',
            branchesRoot: '/safe/worktrees',
            storageMode: 'clone',
            privilegedFilesystemDelete: true,
            deleteDbRecord: false,
          },
        },
        {}
      );

      expect(result).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('safety check') },
      });
      expect(mocks.deleteBranchDirectory).not.toHaveBeenCalled();
      expect(patchedBranches).toContainEqual({
        filesystem_status: 'delete_failed',
        error_message: expect.stringContaining('safety check'),
      });
    }
  );

  it('does not delete or report failure for a superseded deletion generation', async () => {
    const patchedBranches: Array<Record<string, unknown>> = [];
    createClient({
      branch: {
        branch_id: branchId,
        path: '/safe/worktrees/repo/feature',
        storage_mode: 'clone',
        filesystem_status: 'deleting',
        filesystem_operation_id: '550e8400-e29b-41d4-a716-446655440098',
      },
      patchedBranches,
    });

    const result = await handleGitBranchRemove(
      {
        command: 'git.branch.remove',
        sessionToken: 'jwt',
        params: {
          branchId,
          filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
          branchPath: '/safe/worktrees/repo/feature',
          branchesRoot: '/safe/worktrees',
          storageMode: 'clone',
          deleteDbRecord: false,
        },
      },
      {}
    );

    expect(result).toMatchObject({ success: false, error: { code: 'GIT_BRANCH_REMOVE_FAILED' } });
    expect(mocks.deleteBranchDirectory).not.toHaveBeenCalled();
    expect(patchedBranches).toEqual([]);
  });

  it('persists delete_failed and never reports deleted when privileged removal fails', async () => {
    const branchesRoot = await mkdtemp(join(tmpdir(), 'agor-delete-failure-'));
    const branchPath = join(branchesRoot, 'repo', 'feature');
    await mkdir(branchPath, { recursive: true });
    const patchedBranches: Array<Record<string, unknown>> = [];
    createClient({
      branch: {
        branch_id: branchId,
        path: branchPath,
        storage_mode: 'clone',
        filesystem_status: 'deleting',
      },
      patchedBranches,
    });
    mocks.deleteBranchDirectory.mockRejectedValueOnce(
      new Error(`EACCES: permission denied, rmdir '${branchPath}/node_modules/native/build'`)
    );

    try {
      const result = await handleGitBranchRemove(
        {
          command: 'git.branch.remove',
          sessionToken: 'jwt',
          params: {
            branchId,
            filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
            branchPath,
            branchesRoot,
            storageMode: 'clone',
            privilegedFilesystemDelete: true,
            deleteDbRecord: false,
          },
        },
        {}
      );

      expect(result).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('sudoers') },
      });
      expect(patchedBranches).toEqual([
        {
          filesystem_status: 'delete_failed',
          error_message: expect.stringContaining('sudoers'),
        },
      ]);
      expect(JSON.stringify(result)).not.toContain(branchPath);
    } finally {
      await rm(branchesRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'EACCES: permission denied, rmdir node_modules/native',
    "error: failed to delete '/safe/worktrees/repo/feature': Directory not empty",
  ])(
    'uses privileged exact-root deletion when git worktree removal leaves ACL residue: %s',
    async (removalError) => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'agor-worktree-delete-'));
      const branchesRoot = join(tempRoot, 'worktrees');
      const branchPath = join(branchesRoot, 'repo', 'feature');
      const repoPath = join(tempRoot, 'repos', 'repo');
      const patchedBranches: Array<Record<string, unknown>> = [];
      await mkdir(branchPath, { recursive: true });
      await mkdir(repoPath, { recursive: true });
      await writeFile(
        join(branchPath, '.git'),
        `gitdir: ${join(repoPath, '.git', 'worktrees', 'feature')}\n`
      );
      createClient({
        repo: { repo_id: repoId, local_path: repoPath },
        branch: {
          branch_id: branchId,
          repo_id: repoId,
          path: branchPath,
          storage_mode: 'worktree',
          filesystem_status: 'deleting',
        },
        patchedBranches,
      });
      mocks.removeGitWorktree
        .mockRejectedValueOnce(new Error(removalError))
        .mockResolvedValueOnce(undefined);
      mocks.listGitWorktrees.mockResolvedValueOnce([
        { path: branchPath, name: 'feature', sha: 'abc', ref: 'feature', detached: false },
      ]);
      mocks.deleteBranchDirectory.mockImplementationOnce(async () => {
        await rm(branchPath, { recursive: true, force: true });
      });

      try {
        const result = await handleGitBranchRemove(
          {
            command: 'git.branch.remove',
            sessionToken: 'jwt',
            params: {
              branchId,
              filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
              branchPath,
              branchesRoot,
              storageMode: 'worktree',
              privilegedFilesystemDelete: true,
              deleteDbRecord: false,
            },
          },
          {}
        );

        expect(result.success).toBe(true);
        expect(mocks.removeGitWorktree).toHaveBeenNthCalledWith(1, repoPath, branchPath);
        expect(mocks.deleteBranchDirectory).toHaveBeenCalledWith(branchPath, branchesRoot, {
          expectedRelativePath: join('repo', 'feature'),
          privileged: true,
        });
        expect(mocks.removeGitWorktree).toHaveBeenNthCalledWith(2, repoPath, branchPath);
        expect(patchedBranches).toContainEqual({ filesystem_status: 'deleted' });
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }
  );

  it('accepts a partial worktree removal that already deregistered the exact path', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'agor-worktree-partial-delete-'));
    const branchesRoot = join(tempRoot, 'worktrees');
    const branchPath = join(branchesRoot, 'repo', 'feature');
    const repoPath = join(tempRoot, 'repos', 'repo');
    const patchedBranches: Array<Record<string, unknown>> = [];
    await mkdir(branchPath, { recursive: true });
    await mkdir(repoPath, { recursive: true });
    await writeFile(
      join(branchPath, '.git'),
      `gitdir: ${join(repoPath, '.git', 'worktrees', 'feature')}\n`
    );
    createClient({
      repo: { repo_id: repoId, local_path: repoPath },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        path: branchPath,
        storage_mode: 'worktree',
        filesystem_status: 'deleting',
      },
      patchedBranches,
    });
    mocks.removeGitWorktree.mockRejectedValueOnce(
      new Error(`error: failed to delete '${branchPath}': Directory not empty`)
    );
    mocks.deleteBranchDirectory.mockImplementationOnce(async () => {
      await rm(branchPath, { recursive: true, force: true });
    });
    mocks.listGitWorktrees.mockResolvedValueOnce([]);

    try {
      const result = await handleGitBranchRemove(
        {
          command: 'git.branch.remove',
          sessionToken: 'jwt',
          params: {
            branchId,
            filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
            branchPath,
            branchesRoot,
            storageMode: 'worktree',
            privilegedFilesystemDelete: true,
            deleteDbRecord: false,
          },
        },
        {}
      );

      expect(result.success).toBe(true);
      expect(mocks.removeGitWorktree).toHaveBeenCalledTimes(1);
      expect(mocks.listGitWorktrees).toHaveBeenCalledWith(repoPath);
      expect(patchedBranches).toContainEqual({ filesystem_status: 'deleted' });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('refuses a worktree gitdir pointer that targets a different repository', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'agor-worktree-pointer-'));
    const branchesRoot = join(tempRoot, 'worktrees');
    const branchPath = join(branchesRoot, 'repo', 'feature');
    const persistedRepoPath = join(tempRoot, 'repos', 'persisted');
    const pointedRepoPath = join(tempRoot, 'repos', 'other');
    const patchedBranches: Array<Record<string, unknown>> = [];
    await mkdir(branchPath, { recursive: true });
    await mkdir(persistedRepoPath, { recursive: true });
    await mkdir(pointedRepoPath, { recursive: true });
    await writeFile(
      join(branchPath, '.git'),
      `gitdir: ${join(pointedRepoPath, '.git', 'worktrees', 'feature')}\n`
    );
    createClient({
      repo: { repo_id: repoId, local_path: persistedRepoPath },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        path: branchPath,
        storage_mode: 'worktree',
        filesystem_status: 'deleting',
      },
      patchedBranches,
    });

    try {
      const result = await handleGitBranchRemove(
        {
          command: 'git.branch.remove',
          sessionToken: 'jwt',
          params: {
            branchId,
            filesystemOperationId: '550e8400-e29b-41d4-a716-446655440099',
            branchPath,
            branchesRoot,
            storageMode: 'worktree',
            privilegedFilesystemDelete: true,
            deleteDbRecord: false,
          },
        },
        {}
      );

      expect(result).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('safety check') },
      });
      expect(mocks.removeGitWorktree).not.toHaveBeenCalled();
      expect(mocks.deleteBranchDirectory).not.toHaveBeenCalled();
      expect(patchedBranches).toContainEqual({
        filesystem_status: 'delete_failed',
        error_message: expect.stringContaining('safety check'),
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('derives git.repo.delete paths from daemon records instead of payload paths', async () => {
    createClient({
      repo: {
        ...repoDeleteLifecycle,
        repo_id: repoId,
        slug: 'org/repo',
        repo_type: 'remote',
        local_path: '/safe/repos/org/repo',
      },
      branches: [
        {
          branch_id: branchId,
          repo_id: repoId,
          name: 'feature',
          path: '/safe/worktrees/org/repo/feature',
        },
      ],
    });

    const result = await handleGitRepoDelete(
      { command: 'git.repo.delete', sessionToken: 'jwt', params: { repoId, ...deleteRoots } },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.deleteBranchDirectory).toHaveBeenCalledWith(
      '/safe/worktrees/org/repo/feature',
      '/safe/worktrees',
      { expectedRelativePath: join('org/repo', 'feature') }
    );
    expect(mocks.deleteRepoDirectory).toHaveBeenCalledWith('/safe/repos/org/repo', '/safe/repos', {
      expectedRelativePath: 'org/repo',
    });
  });

  it('refuses git.repo.delete after its repository lifecycle generation is superseded', async () => {
    createClient({
      repo: {
        ...repoDeleteLifecycle,
        repo_id: repoId,
        slug: 'org/repo',
        repo_type: 'remote',
        local_path: '/safe/repos/org/repo',
        filesystem_operation_id: '550e8400-e29b-41d4-a716-446655440099',
      },
      branches: [],
    });

    const result = await handleGitRepoDelete(
      { command: 'git.repo.delete', sessionToken: 'jwt', params: { repoId, ...deleteRoots } },
      {}
    );

    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringMatching(/canonical managed identity/i) },
    });
    expect(mocks.deleteRepoDirectory).not.toHaveBeenCalled();
  });

  it('refuses deletion when another same-tenant repo row aliases or descends from the root', async () => {
    const repo = {
      ...repoDeleteLifecycle,
      repo_id: repoId,
      slug: 'org/repo',
      repo_type: 'remote',
      local_path: '/safe/repos/org/repo',
    };
    createClient({
      repo,
      repoPages: [
        [
          repo,
          {
            repo_id: '550e8400-e29b-41d4-a716-446655440099',
            slug: 'attacker/alias',
            repo_type: 'local',
            local_path: `${repo.local_path}/child`,
          },
        ],
      ],
      branches: [],
    });

    const result = await handleGitRepoDelete(
      { command: 'git.repo.delete', sessionToken: 'jwt', params: { repoId, ...deleteRoots } },
      {}
    );

    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringMatching(/overlaps another metadata owner/i) },
    });
    expect(mocks.deleteRepoDirectory).not.toHaveBeenCalled();
  });

  it('detects canonical repository aliases registered through different symlink paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-repo-delete-symlink-'));
    const target = join(root, 'target');
    const alias = join(root, 'alias');
    await mkdir(target);
    await symlink(target, alias);
    const repo = {
      ...repoDeleteLifecycle,
      repo_id: repoId,
      slug: 'legacy',
      repo_type: 'remote',
      local_path: target,
    };
    createClient({
      repo,
      repoPages: [
        [
          repo,
          {
            repo_id: '550e8400-e29b-41d4-a716-446655440099',
            slug: 'alias/repo',
            repo_type: 'local',
            local_path: alias,
          },
        ],
      ],
      branches: [],
    });

    try {
      const result = await handleGitRepoDelete(
        { command: 'git.repo.delete', sessionToken: 'jwt', params: { repoId, ...deleteRoots } },
        {}
      );
      expect(result).toMatchObject({
        success: false,
        error: { message: expect.stringMatching(/overlaps another metadata owner/i) },
      });
      expect(mocks.deleteRepoDirectory).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses slug-derived output paths for git.clone to avoid same-basename collisions', async () => {
    const previousGitConfigParameters = process.env.GIT_CONFIG_PARAMETERS;
    const patchedRepos: Array<Record<string, unknown>> = [];
    createClient({
      repo: {
        repo_id: repoId,
        slug: 'smoke/agor-assistant-pr1258',
        repo_type: 'remote',
        local_path: '/safe/repos/smoke/agor-assistant-pr1258',
      },
      patchedRepos,
    });

    try {
      const result = await handleGitClone(
        {
          command: 'git.clone',
          sessionToken: 'jwt',
          params: {
            url: 'https://github.com/preset-io/agor-assistant.git',
            slug: 'smoke/agor-assistant-pr1258',
            repoId,
            createDbRecord: true,
          },
        },
        {}
      );

      expect(result.success).toBe(true);
      expect(mocks.cloneRepo).toHaveBeenCalledWith(
        expect.objectContaining({ targetDir: '/safe/repos/smoke/agor-assistant-pr1258' })
      );
      expect(process.env.GIT_CONFIG_PARAMETERS).toContain(
        "'safe.directory=/safe/repos/smoke/agor-assistant-pr1258'"
      );
      expect(patchedRepos).not.toContainEqual(
        expect.objectContaining({ local_path: expect.anything() })
      );
      expect(patchedRepos.at(-1)).toMatchObject({ clone_status: 'ready' });
    } finally {
      if (previousGitConfigParameters === undefined) {
        delete process.env.GIT_CONFIG_PARAMETERS;
      } else {
        process.env.GIT_CONFIG_PARAMETERS = previousGitConfigParameters;
      }
    }
  });

  it('keeps a cloned repo non-ready when lifecycle permission sync fails', async () => {
    const patchedRepos: Array<Record<string, unknown>> = [];
    createClient({
      repo: {
        repo_id: repoId,
        slug: 'org/repo',
        repo_type: 'remote',
        local_path: '/safe/repos/org/repo',
      },
      patchedRepos,
    });
    mocks.cloneRepo.mockResolvedValueOnce({
      path: '/safe/repos/org/repo',
      repoName: 'repo',
      defaultBranch: 'main',
    });
    mocks.handleUnixSyncRepo.mockResolvedValueOnce({
      success: false,
      error: { code: 'UNIX_SYNC_REPO_FAILED', message: 'chgrp failed' },
    });

    const result = await handleGitClone(
      {
        command: 'git.clone',
        sessionToken: 'tenant-token',
        params: {
          url: 'https://example.com/repo.git',
          slug: 'org/repo',
          repoId,
          initUnixGroup: true,
          daemonUser: 'agor',
        },
      },
      {}
    );

    expect(mocks.handleUnixSyncRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'unix.sync-repo',
        sessionToken: 'tenant-token',
        params: expect.objectContaining({ repoId, daemonUser: 'agor', initialize: true }),
      }),
      {}
    );
    expect(result).toMatchObject({ success: false, error: { message: 'chgrp failed' } });
    expect(patchedRepos).not.toContainEqual(expect.objectContaining({ clone_status: 'ready' }));
  });

  it('pages through every branch before deleting repo directories', async () => {
    const branches = Array.from({ length: 1002 }, (_, index) => ({
      branch_id: `branch-${index}`,
      repo_id: repoId,
      name: `branch-${index}`,
      path: `/safe/worktrees/org/repo/branch-${index}`,
    }));
    createClient({
      repo: {
        ...repoDeleteLifecycle,
        repo_id: repoId,
        slug: 'org/repo',
        repo_type: 'remote',
        local_path: '/safe/repos/org/repo',
      },
      branchPages: [branches.slice(0, 1000), branches.slice(1000)],
    });

    const result = await handleGitRepoDelete(
      { command: 'git.repo.delete', sessionToken: 'jwt', params: { repoId, ...deleteRoots } },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.deleteBranchDirectory).toHaveBeenCalledTimes(1002);
    expect(mocks.deleteBranchDirectory).toHaveBeenNthCalledWith(
      1001,
      '/safe/worktrees/org/repo/branch-1000',
      '/safe/worktrees',
      { expectedRelativePath: join('org/repo', 'branch-1000') }
    );
    expect(mocks.deleteRepoDirectory).toHaveBeenCalledWith('/safe/repos/org/repo', '/safe/repos', {
      expectedRelativePath: 'org/repo',
    });
  }, 30_000);

  it('rejects git.repo.delete if branch query returns a foreign branch', async () => {
    createClient({
      repo: {
        ...repoDeleteLifecycle,
        repo_id: repoId,
        slug: 'org/repo',
        repo_type: 'remote',
        local_path: '/safe/repos/org/repo',
      },
      branches: [
        { branch_id: branchId, repo_id: '550e8400-e29b-41d4-a716-446655440099', path: '/bad' },
      ],
    });

    const result = await handleGitRepoDelete(
      { command: 'git.repo.delete', sessionToken: 'jwt', params: { repoId, ...deleteRoots } },
      {}
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/SAFETY CHECK FAILED/);
    expect(mocks.deleteBranchDirectory).not.toHaveBeenCalled();
    expect(mocks.deleteRepoDirectory).not.toHaveBeenCalled();
  });

  it('imports .agor.yml from the executor-owned branch path after repo membership check', async () => {
    const environment = {
      version: 2,
      default: 'default',
      variants: { default: { start: 'pnpm dev' } },
    };
    mocks.parseAgorYml.mockReturnValue(environment);
    createClient({
      branch: { branch_id: branchId, repo_id: repoId, path: '/safe/worktrees/repo/feature' },
    });

    const result = await handleBranchAgorYmlImport(
      { command: 'branch.agor-yml.import', sessionToken: 'jwt', params: { repoId, branchId } },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.parseAgorYml).toHaveBeenCalledWith('/safe/worktrees/repo/feature/.agor.yml');
    expect(result.data).toMatchObject({ environment });
  });

  it('exports .agor.yml from the executor-owned branch path after repo membership check', async () => {
    const environment = {
      version: 2,
      default: 'default',
      variants: { default: { start: 'pnpm dev' } },
    };
    createClient({
      branch: { branch_id: branchId, repo_id: repoId, path: '/safe/worktrees/repo/feature' },
    });

    const result = await handleBranchAgorYmlExport(
      {
        command: 'branch.agor-yml.export',
        sessionToken: 'jwt',
        params: { repoId, branchId, environment },
      },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.writeAgorYml).toHaveBeenCalledWith(
      '/safe/worktrees/repo/feature/.agor.yml',
      environment
    );
  });
});
