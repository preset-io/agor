import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createExecutorClient: vi.fn(),
  parseAgorYml: vi.fn(),
  writeAgorYml: vi.fn(),
  deleteBranchDirectory: vi.fn(),
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
    deleteRepoDirectory: mocks.deleteRepoDirectory,
    isValidGitRepo: mocks.isValidGitRepo,
    getDefaultBranch: mocks.getDefaultBranch,
    getRemoteUrl: mocks.getRemoteUrl,
    scanGitConfigRemoteCredentials: mocks.scanGitConfigRemoteCredentials,
    scrubGitConfigRemoteCredentials: mocks.scrubGitConfigRemoteCredentials,
  };
});

vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: mocks.createExecutorClient,
}));

import {
  handleBranchAgorYmlExport,
  handleBranchAgorYmlImport,
  handleBranchInspect,
  handleGitBranchAdd,
  handleGitBranchRemove,
  handleGitClone,
  handleGitManagedCredentialsReconcile,
  handleGitRepoDelete,
  handleGitRepoInspect,
} from './git.js';

const repoId = '550e8400-e29b-41d4-a716-446655440001';
const branchId = '550e8400-e29b-41d4-a716-446655440002';
const deleteRoots = { reposRoot: '/safe/repos', branchesRoot: '/safe/worktrees' };

function createClient(records: {
  repo?: Record<string, unknown>;
  repoPages?: Array<Array<Record<string, unknown>>>;
  branches?: Array<Record<string, unknown>>;
  branchPages?: Array<Array<Record<string, unknown>>>;
  branch?: Record<string, unknown>;
  patchedRepos?: Array<Record<string, unknown>>;
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
          patch: vi.fn(async (_id: string, data: Record<string, unknown>) => {
            records.patchedRepos?.push(data);
            return { ...(records.repo ?? {}), ...data };
          }),
          create: vi.fn(async (data: Record<string, unknown>) => data),
          handoffCloneUnixPermissions: vi.fn(async () => ({ unixGroup: 'agor_repo_test' })),
          find,
        };
      }
      if (name === 'users') {
        return { getGitEnvironment: vi.fn(async () => ({})) };
      }
      if (name === 'branches') {
        const find = vi.fn(
          async ({ query }: { query?: { $skip?: number; $limit?: number } } = {}) => {
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
          patch: vi.fn(async (_id: string, data: Record<string, unknown>) => ({
            ...(records.branch ?? {}),
            ...data,
          })),
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
  mocks.isValidGitRepo.mockResolvedValue(true);
  mocks.getDefaultBranch.mockResolvedValue('main');
  mocks.getRemoteUrl.mockResolvedValue('https://user:secret@example.com/org/repo.git');
  mocks.scanGitConfigRemoteCredentials.mockResolvedValue({
    findings: [{ configPath: '/repo/.git/config' }],
  });
  mocks.scrubGitConfigRemoteCredentials.mockResolvedValue({ findings: [] });
});

describe('managed executor git/fs commands', () => {
  it('resolves trusted repo metadata just-in-time inside git.branch.add', async () => {
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
          repoId,
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
  it('uses the daemon-provided tenant root when removing a branch directory', async () => {
    const branchesRoot = await mkdtemp(join(tmpdir(), 'agor-tenant-worktrees-'));
    const branchPath = join(branchesRoot, 'repo', 'feature');
    await mkdir(branchPath, { recursive: true });
    createClient({});

    try {
      const result = await handleGitBranchRemove(
        {
          command: 'git.branch.remove',
          sessionToken: 'jwt',
          params: {
            branchId,
            branchPath,
            branchesRoot,
            storageMode: 'clone',
            deleteDbRecord: false,
          },
        },
        {}
      );

      expect(result.success).toBe(true);
      expect(mocks.deleteBranchDirectory).toHaveBeenCalledWith(branchPath, branchesRoot);
    } finally {
      await rm(branchesRoot, { recursive: true, force: true });
    }
  });

  it('derives git.repo.delete paths from daemon records instead of payload paths', async () => {
    createClient({
      repo: { repo_id: repoId, local_path: '/safe/repos/repo' },
      branches: [{ branch_id: branchId, repo_id: repoId, path: '/safe/worktrees/repo/feature' }],
    });

    const result = await handleGitRepoDelete(
      { command: 'git.repo.delete', sessionToken: 'jwt', params: { repoId, ...deleteRoots } },
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
      expect(patchedRepos).toContainEqual(
        expect.objectContaining({
          local_path: '/safe/repos/smoke/agor-assistant-pr1258',
        })
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

  it('adds branch/repo safe.directory and falls back to DB branch name when current branch lookup fails', async () => {
    mocks.gitRaw.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) return '';
      if (args.includes('--abbrev-ref')) throw new Error('dubious ownership');
      if (args.includes('HEAD')) return 'sha-abc\n';
      return '';
    });
    createClient({
      repo: { repo_id: repoId, local_path: '/safe/repos/repo' },
      branch: {
        branch_id: branchId,
        repo_id: repoId,
        name: 'feature-x',
        path: '/safe/worktrees/repo/feature-x',
      },
    });

    const result = await handleBranchInspect(
      { command: 'branch.inspect', sessionToken: 'jwt', params: { branchId } },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.addConfig).toHaveBeenCalledWith(
      'safe.directory',
      '/safe/worktrees/repo/feature-x',
      true,
      'global'
    );
    expect(mocks.addConfig).toHaveBeenCalledWith(
      'safe.directory',
      '/safe/repos/repo',
      true,
      'global'
    );
    expect(mocks.gitRaw).toHaveBeenCalledWith(
      expect.arrayContaining([
        '-c',
        'safe.directory=/safe/worktrees/repo/feature-x',
        '-c',
        'safe.directory=/safe/repos/repo',
      ])
    );
    expect(result.data).toMatchObject({ currentSha: 'sha-abc', currentRef: 'feature-x' });
  });

  it('pages through every branch before deleting repo directories', async () => {
    const branches = Array.from({ length: 1002 }, (_, index) => ({
      branch_id: `branch-${index}`,
      repo_id: repoId,
      path: `/safe/worktrees/repo/branch-${index}`,
    }));
    createClient({
      repo: { repo_id: repoId, local_path: '/safe/repos/repo' },
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
      '/safe/worktrees/repo/branch-1000',
      '/safe/worktrees'
    );
    expect(mocks.deleteRepoDirectory).toHaveBeenCalledWith('/safe/repos/repo', '/safe/repos');
  });

  it('rejects git.repo.delete if branch query returns a foreign branch', async () => {
    createClient({
      repo: { repo_id: repoId, local_path: '/safe/repos/repo' },
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
