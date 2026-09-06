import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createExecutorClient: vi.fn(),
  diagnoseGit: vi.fn(),
  parseAgorYml: vi.fn(),
  writeAgorYml: vi.fn(),
  deleteBranchDirectory: vi.fn(),
  deleteRepoDirectory: vi.fn(),
  cloneRepo: vi.fn(),
  createBranchAsClone: vi.fn(),
  isRemoteRefVisibleForClone: vi.fn(),
  getReposDir: vi.fn(() => '/safe/repos'),
  addConfig: vi.fn(),
  gitRaw: vi.fn(),
  isValidGitRepo: vi.fn(),
  getDefaultBranch: vi.fn(),
  getCurrentBranch: vi.fn(),
  listGitWorktrees: vi.fn(),
  getRemoteUrl: vi.fn(),
  ensureGitRemoteUrl: vi.fn(),
  scanGitConfigRemoteCredentials: vi.fn(),
  scrubGitConfigRemoteCredentials: vi.fn(),
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
    isRemoteRefVisibleForClone: mocks.isRemoteRefVisibleForClone,
    deleteBranchDirectory: mocks.deleteBranchDirectory,
    deleteRepoDirectory: mocks.deleteRepoDirectory,
    isValidGitRepo: mocks.isValidGitRepo,
    getDefaultBranch: mocks.getDefaultBranch,
    getCurrentBranch: mocks.getCurrentBranch,
    listGitWorktrees: mocks.listGitWorktrees,
    getRemoteUrl: mocks.getRemoteUrl,
    ensureGitRemoteUrl: mocks.ensureGitRemoteUrl,
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
}));

import {
  handleBranchAgorYmlExport,
  handleBranchAgorYmlImport,
  handleGitBranchAdd,
  handleGitBranchRemove,
  handleGitClone,
  handleGitManagedCredentialsReconcile,
  handleGitRepoDelete,
  handleGitRepoInspect,
  handleGitRepoRealignOrigin,
} from './git.js';

const repoId = '550e8400-e29b-41d4-a716-446655440001';
const branchId = '550e8400-e29b-41d4-a716-446655440002';
const materializationAttemptId = '550e8400-e29b-41d4-a716-446655440004';
const deleteRoots = { reposRoot: '/safe/repos', branchesRoot: '/safe/worktrees' };

function createClient(records: {
  repo?: Record<string, unknown>;
  repoPages?: Array<Array<Record<string, unknown>>>;
  branches?: Array<Record<string, unknown>>;
  branchPages?: Array<Array<Record<string, unknown>>>;
  branch?: Record<string, unknown>;
  branchFindQueries?: Array<Record<string, unknown>>;
  patchedRepos?: Array<Record<string, unknown>>;
  patchedBranches?: Array<Record<string, unknown>>;
  renderedBranches?: string[];
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
          get: vi.fn(async () => records.repo),
          settleClone: vi.fn(async (data: Record<string, unknown>) => {
            records.patchedRepos?.push(data);
            return { ...(records.repo ?? {}), ...data };
          }),
          patch: vi.fn(async (_id: string, data: Record<string, unknown>) => {
            records.patchedRepos?.push(data);
            return { ...(records.repo ?? {}), ...data };
          }),
          create: vi.fn(async (data: Record<string, unknown>) => data),
          find,
        };
      }
      if (name === 'executor-git-environment') {
        return { create: vi.fn(async () => ({})) };
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
          get: vi.fn(async () => records.branch),
          find,
          patch: vi.fn(async (_id: string, data: Record<string, unknown>) => {
            records.patchedBranches?.push(data);
            return { ...(records.branch ?? {}), ...data };
          }),
          settleFilesystem: vi.fn(async (data: Record<string, unknown>) => {
            records.patchedBranches?.push(data);
            return { ...(records.branch ?? {}), ...data };
          }),
        };
      }
      if (name === `branches/${branchId}/render-environment`) {
        return {
          create: vi.fn(async () => {
            records.renderedBranches?.push(branchId);
            return records.branch;
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
  mocks.isRemoteRefVisibleForClone.mockResolvedValue(false);
  mocks.isValidGitRepo.mockResolvedValue(true);
  mocks.getDefaultBranch.mockResolvedValue('main');
  mocks.getCurrentBranch.mockResolvedValue('feature');
  mocks.listGitWorktrees.mockResolvedValue([{ path: '/trusted/branch', branch: 'feature' }]);
  mocks.getRemoteUrl.mockResolvedValue('https://user:secret@example.com/org/repo.git');
  mocks.scanGitConfigRemoteCredentials.mockResolvedValue({
    findings: [{ configPath: '/repo/.git/config' }],
  });
  mocks.scrubGitConfigRemoteCredentials.mockResolvedValue({ findings: [] });
  mocks.ensureGitRemoteUrl.mockResolvedValue({ changed: false });
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
    const patchedBranches: Array<Record<string, unknown>> = [];
    const renderedBranches: string[] = [];
    createClient({
      repo: {
        repo_id: repoId,
        local_path: '/trusted/repo',
        remote_url: 'https://user:secret@example.com/trusted/repo.git',
        environment: {
          version: 2,
          default: 'dev',
          variants: { dev: { start: 'pnpm dev' } },
        },
      },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        path: '/trusted/branch',
        name: 'feature',
        ref: 'trusted-ref',
        base_ref: 'trusted-base',
        base_remote_url: 'https://github.com/preset-io/agor-teammate.git',
        new_branch: true,
        ref_type: 'branch',
        storage_mode: 'clone',
        clone_depth: 42,
      },
      patchedBranches,
      renderedBranches,
    });

    const result = await handleGitBranchAdd(
      {
        command: 'git.branch.add',
        sessionToken: 'tenant-token',
        params: {
          branchId,
          repoId,
          materializationAttemptId,
          useReference: true,
        },
      },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.createBranchAsClone).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteUrl: 'https://github.com/preset-io/agor-teammate.git',
        originRemoteUrl: 'https://example.com/trusted/repo.git',
        ref: 'trusted-base',
        newBranchName: 'trusted-ref',
        depth: 42,
        referencePath: '/trusted/repo',
      })
    );
    expect(patchedBranches).toContainEqual({
      branch_id: branchId,
      filesystem_attempt_id: materializationAttemptId,
      filesystem_status: 'ready',
    });
    expect(renderedBranches).toEqual([branchId]);
    expect(patchedBranches.some((patch) => 'start_command' in patch)).toBe(false);
  });

  it('recovers a demonstrably completed clone without starting another materialization', async () => {
    const patchedBranches: Array<Record<string, unknown>> = [];
    createClient({
      repo: {
        repo_id: repoId,
        local_path: '/trusted/repo',
        remote_url: 'https://user:secret@example.com/trusted/repo.git',
      },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        path: '/trusted/branch',
        name: 'feature',
        ref: 'feature',
        ref_type: 'branch',
        storage_mode: 'clone',
      },
      patchedBranches,
    });
    mocks.getRemoteUrl.mockResolvedValueOnce('https://example.com/trusted/repo.git');

    const result = await handleGitBranchAdd(
      {
        command: 'git.branch.add',
        sessionToken: 'tenant-token',
        params: { branchId, repoId, materializationAttemptId, recoveryMode: true },
      },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.createBranchAsClone).not.toHaveBeenCalled();
    expect(patchedBranches).toContainEqual({
      branch_id: branchId,
      filesystem_attempt_id: materializationAttemptId,
      filesystem_status: 'ready',
    });
  });

  it('terminally fails recovery when the expired attempt left no valid checkout', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'agor-recovery-missing-'));
    const missingBranchPath = join(tempRoot, 'branch');
    const patchedBranches: Array<Record<string, unknown>> = [];
    createClient({
      repo: {
        repo_id: repoId,
        local_path: '/trusted/repo',
        remote_url: 'https://example.com/trusted/repo.git',
      },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        path: missingBranchPath,
        name: 'feature',
        ref: 'feature',
        ref_type: 'branch',
        storage_mode: 'clone',
      },
      patchedBranches,
    });
    mocks.isValidGitRepo.mockResolvedValueOnce(false);

    try {
      const result = await handleGitBranchAdd(
        {
          command: 'git.branch.add',
          sessionToken: 'tenant-token',
          params: { branchId, repoId, materializationAttemptId, recoveryMode: true },
        },
        {}
      );

      expect(result).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('left no valid Git checkout') },
      });
      expect(mocks.createBranchAsClone).not.toHaveBeenCalled();
      await expect(access(missingBranchPath)).rejects.toThrow();
      expect(patchedBranches).toContainEqual({
        branch_id: branchId,
        filesystem_attempt_id: materializationAttemptId,
        filesystem_status: 'failed',
        error_message: expect.stringContaining('left no valid Git checkout'),
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('restores a clone from the destination branch when it has already been pushed', async () => {
    createClient({
      repo: {
        repo_id: repoId,
        local_path: '/trusted/repo',
        remote_url: 'https://github.com/preset-io/agor-teammate-private.git',
      },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        path: '/trusted/branch',
        name: 'private-ponc',
        ref: 'private-ponc',
        base_ref: 'template/deal-desk-revops-analyst',
        base_remote_url: 'https://github.com/preset-io/agor-teammate.git',
        new_branch: true,
        ref_type: 'branch',
        storage_mode: 'clone',
      },
    });
    mocks.isRemoteRefVisibleForClone.mockResolvedValueOnce(true);

    const result = await handleGitBranchAdd(
      {
        command: 'git.branch.add',
        sessionToken: 'tenant-token',
        params: { branchId, repoId, materializationAttemptId, restoreMode: true },
      },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.isRemoteRefVisibleForClone).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteUrl: 'https://github.com/preset-io/agor-teammate-private.git',
        ref: 'private-ponc',
        refType: 'branch',
      })
    );
    expect(mocks.createBranchAsClone).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteUrl: 'https://github.com/preset-io/agor-teammate-private.git',
        ref: 'private-ponc',
      })
    );
    expect(mocks.createBranchAsClone.mock.calls[0]?.[0]).not.toHaveProperty('originRemoteUrl');
    expect(mocks.createBranchAsClone.mock.calls[0]?.[0]).not.toHaveProperty('newBranchName');
  });

  it('falls back to the qualified template only when the destination branch is absent', async () => {
    createClient({
      repo: {
        repo_id: repoId,
        local_path: '/trusted/repo',
        remote_url: 'https://github.com/preset-io/agor-teammate-private.git',
      },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        path: '/trusted/branch',
        name: 'private-ponc',
        ref: 'private-ponc',
        base_ref: 'template/deal-desk-revops-analyst',
        base_remote_url: 'https://github.com/preset-io/agor-teammate.git',
        new_branch: true,
        ref_type: 'branch',
        storage_mode: 'clone',
      },
    });

    const result = await handleGitBranchAdd(
      {
        command: 'git.branch.add',
        sessionToken: 'tenant-token',
        params: { branchId, repoId, materializationAttemptId, restoreMode: true },
      },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.createBranchAsClone).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteUrl: 'https://github.com/preset-io/agor-teammate.git',
        originRemoteUrl: 'https://github.com/preset-io/agor-teammate-private.git',
        ref: 'template/deal-desk-revops-analyst',
        newBranchName: 'private-ponc',
      })
    );
  });

  it('does not replace a destination branch when the restore preflight fails', async () => {
    createClient({
      repo: {
        repo_id: repoId,
        local_path: '/trusted/repo',
        remote_url: 'https://github.com/preset-io/agor-teammate-private.git',
      },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        path: '/trusted/branch',
        name: 'private-ponc',
        ref: 'private-ponc',
        base_ref: 'template/deal-desk-revops-analyst',
        base_remote_url: 'https://github.com/preset-io/agor-teammate.git',
        new_branch: true,
        ref_type: 'branch',
        storage_mode: 'clone',
      },
    });
    mocks.isRemoteRefVisibleForClone.mockRejectedValueOnce(new Error('destination unavailable'));

    const result = await handleGitBranchAdd(
      {
        command: 'git.branch.add',
        sessionToken: 'tenant-token',
        params: { branchId, repoId, materializationAttemptId, restoreMode: true },
      },
      {}
    );

    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('destination unavailable') },
    });
    expect(mocks.createBranchAsClone).not.toHaveBeenCalled();
  });

  it('rejects a forged persisted template remote before filesystem materialization', async () => {
    createClient({
      repo: {
        repo_id: repoId,
        local_path: '/trusted/repo',
        remote_url: 'https://github.com/preset-io/agor-teammate-private.git',
      },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        path: '/trusted/branch',
        name: 'private-ponc',
        ref: 'private-ponc',
        base_ref: 'template/deal-desk-revops-analyst',
        base_remote_url: 'https://attacker.example/template.git',
        new_branch: true,
        ref_type: 'branch',
        storage_mode: 'clone',
      },
    });

    const result = await handleGitBranchAdd(
      {
        command: 'git.branch.add',
        sessionToken: 'tenant-token',
        params: { branchId, repoId, materializationAttemptId },
      },
      {}
    );

    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('Refusing untrusted base_remote_url') },
    });
    expect(mocks.createBranchAsClone).not.toHaveBeenCalled();
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
          repoId,
          materializationAttemptId,
        },
      },
      {}
    );
    expect(result).toMatchObject({ success: false, error: { message: 'Not found' } });
    expect(mocks.createBranchAsClone).not.toHaveBeenCalled();
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

  it('realigns an origin from daemon-authoritative inputs without a daemon client', async () => {
    mocks.ensureGitRemoteUrl.mockResolvedValueOnce({ changed: true });
    const result = await handleGitRepoRealignOrigin(
      {
        command: 'git.repo.realign-origin',
        params: {
          repoId,
          repoPath: '/managed/repo',
          remoteUrl: 'https://example.com/org/repo.git',
          repoSlug: 'org/repo',
        },
      },
      {}
    );

    expect(result).toMatchObject({ success: true, data: { repoId, changed: true } });
    expect(mocks.ensureGitRemoteUrl).toHaveBeenCalledWith(
      '/managed/repo',
      'origin',
      'https://example.com/org/repo.git'
    );
    expect(mocks.createExecutorClient).not.toHaveBeenCalled();
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
    try {
      const result = await handleGitBranchRemove(
        {
          command: 'git.branch.remove',
          params: {
            branchId,
            branchPath,
            branchesRoot,
            storageMode: 'clone',
          },
        },
        {}
      );

      expect(result.success).toBe(true);
      expect(mocks.deleteBranchDirectory).toHaveBeenCalledWith(branchPath, branchesRoot);
      expect(mocks.createExecutorClient).not.toHaveBeenCalled();
    } finally {
      await rm(branchesRoot, { recursive: true, force: true });
    }
  });

  it('uses the daemon-authoritative git.repo.delete inventory without a Feathers bearer', async () => {
    const result = await handleGitRepoDelete(
      {
        command: 'git.repo.delete',
        params: {
          repoId,
          repoPath: '/safe/repos/repo',
          branchPaths: ['/safe/worktrees/repo/feature'],
          ...deleteRoots,
        },
      },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.deleteBranchDirectory).toHaveBeenCalledWith(
      '/safe/worktrees/repo/feature',
      '/safe/worktrees'
    );
    expect(mocks.deleteRepoDirectory).toHaveBeenCalledWith('/safe/repos/repo', '/safe/repos');
  });

  it('uses slug-derived output paths for git.clone to avoid same-basename collisions', async () => {
    const previousGitConfigParameters = process.env.GIT_CONFIG_PARAMETERS;
    const patchedRepos: Array<Record<string, unknown>> = [];
    createClient({ repo: { repo_id: repoId }, patchedRepos });

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
      expect(patchedRepos.at(-1)).toMatchObject({
        repo_id: repoId,
        clone_status: 'ready',
        default_branch: 'main',
      });
    } finally {
      if (previousGitConfigParameters === undefined) {
        delete process.env.GIT_CONFIG_PARAMETERS;
      } else {
        process.env.GIT_CONFIG_PARAMETERS = previousGitConfigParameters;
      }
    }
  });

  it('uses a daemon-selected clone output path without resolving an ambient tenant root', async () => {
    createClient({ repo: { repo_id: repoId }, patchedRepos: [] });
    mocks.getReposDir.mockImplementationOnce(() => {
      throw new Error('missing ambient tenant context');
    });
    mocks.cloneRepo.mockResolvedValueOnce({
      path: '/tenant/acme/repos/preset-io/agor-teammate',
      repoName: 'agor-teammate',
      defaultBranch: 'main',
    });

    const result = await handleGitClone(
      {
        command: 'git.clone',
        sessionToken: 'tenant-bound-service-token',
        params: {
          url: 'https://github.com/preset-io/agor-teammate.git',
          outputPath: '/tenant/acme/repos/preset-io/agor-teammate',
          slug: 'preset-io/agor-teammate',
          repoId,
          createDbRecord: true,
        },
      },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.getReposDir).not.toHaveBeenCalled();
    expect(mocks.cloneRepo).toHaveBeenCalledWith(
      expect.objectContaining({ targetDir: '/tenant/acme/repos/preset-io/agor-teammate' })
    );
  });

  it.each([false, true])(
    'imports executable clone environment only when the daemon grants it (%s)',
    async (importEnvironmentConfig) => {
      const patchedRepos: Array<Record<string, unknown>> = [];
      createClient({ repo: { repo_id: repoId }, patchedRepos });
      mocks.parseAgorYml.mockReturnValue({
        version: 2,
        default: 'dev',
        variants: { dev: { start: 'pnpm dev' } },
      });

      const result = await handleGitClone(
        {
          command: 'git.clone',
          sessionToken: 'tenant-bound-service-token',
          params: {
            url: 'https://github.com/preset-io/agor-teammate.git',
            outputPath: '/tenant/acme/repos/preset-io/agor-teammate',
            slug: 'preset-io/agor-teammate',
            repoId,
            createDbRecord: true,
            importEnvironmentConfig,
          },
        },
        {}
      );

      expect(result.success).toBe(true);
      expect(mocks.parseAgorYml).toHaveBeenCalledTimes(importEnvironmentConfig ? 1 : 0);
      expect(patchedRepos.some((patch) => 'environment' in patch)).toBe(importEnvironmentConfig);
    }
  );

  it('deletes every branch path in the daemon unbounded inventory', async () => {
    const branchPaths = Array.from(
      { length: 1002 },
      (_, index) => `/safe/worktrees/repo/branch-${index}`
    );

    const result = await handleGitRepoDelete(
      {
        command: 'git.repo.delete',
        params: { repoId, repoPath: '/safe/repos/repo', branchPaths, ...deleteRoots },
      },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.deleteBranchDirectory).toHaveBeenCalledTimes(1002);
    expect(mocks.deleteBranchDirectory).toHaveBeenNthCalledWith(
      1001,
      '/safe/worktrees/repo/branch-1000',
      '/safe/worktrees'
    );
    expect(mocks.deleteRepoDirectory).toHaveBeenCalledWith('/safe/repos/repo', '/safe/repos');
  });

  it('stops repo deletion when a daemon-supplied branch path fails containment', async () => {
    mocks.deleteBranchDirectory.mockRejectedValueOnce(new Error('Path outside managed root'));

    const result = await handleGitRepoDelete(
      {
        command: 'git.repo.delete',
        params: {
          repoId,
          repoPath: '/safe/repos/repo',
          branchPaths: ['/outside/branch'],
          ...deleteRoots,
        },
      },
      {}
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/outside managed root/);
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
