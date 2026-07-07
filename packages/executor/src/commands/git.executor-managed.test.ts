import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createExecutorClient: vi.fn(),
  parseAgorYml: vi.fn(),
  writeAgorYml: vi.fn(),
  deleteBranchDirectory: vi.fn(),
  deleteRepoDirectory: vi.fn(),
  cloneRepo: vi.fn(),
  getReposDir: vi.fn(() => '/safe/repos'),
  addConfig: vi.fn(),
  gitRaw: vi.fn(),
}));

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/config');
  return {
    ...actual,
    parseAgorYml: mocks.parseAgorYml,
    writeAgorYml: mocks.writeAgorYml,
  };
});

vi.mock('../git/index.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../git/index.js');
  return {
    ...actual,
    createGit: vi.fn(() => ({ git: { addConfig: mocks.addConfig, raw: mocks.gitRaw } })),
    cloneRepo: mocks.cloneRepo,
    deleteBranchDirectory: mocks.deleteBranchDirectory,
    deleteRepoDirectory: mocks.deleteRepoDirectory,
    getReposDir: mocks.getReposDir,
  };
});

vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: mocks.createExecutorClient,
}));

import {
  handleBranchAgorYmlExport,
  handleBranchAgorYmlImport,
  handleBranchInspect,
  handleGitClone,
  handleGitRepoDelete,
} from './git.js';

const repoId = '550e8400-e29b-41d4-a716-446655440001';
const branchId = '550e8400-e29b-41d4-a716-446655440002';

function createClient(records: {
  repo?: Record<string, unknown>;
  branches?: Array<Record<string, unknown>>;
  branchPages?: Array<Array<Record<string, unknown>>>;
  branch?: Record<string, unknown>;
  patchedRepos?: Array<Record<string, unknown>>;
}) {
  const client = {
    io: { disconnect: vi.fn() },
    service: vi.fn((name: string) => {
      if (name === 'repos') {
        return {
          get: vi.fn(async () => records.repo),
          patch: vi.fn(async (_id: string, data: Record<string, unknown>) => {
            records.patchedRepos?.push(data);
            return { ...(records.repo ?? {}), ...data };
          }),
          create: vi.fn(async (data: Record<string, unknown>) => data),
          initializeUnixGroup: vi.fn(async () => ({ unix_group: 'agor_repo_test' })),
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
});

describe('managed executor git/fs commands', () => {
  it('derives git.repo.delete paths from daemon records instead of payload paths', async () => {
    createClient({
      repo: { repo_id: repoId, local_path: '/safe/repos/repo' },
      branches: [{ branch_id: branchId, repo_id: repoId, path: '/safe/worktrees/repo/feature' }],
    });

    const result = await handleGitRepoDelete(
      { command: 'git.repo.delete', sessionToken: 'jwt', params: { repoId } },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.deleteBranchDirectory).toHaveBeenCalledWith('/safe/worktrees/repo/feature');
    expect(mocks.deleteRepoDirectory).toHaveBeenCalledWith('/safe/repos/repo');
  });

  it('uses slug-derived output paths for git.clone to avoid same-basename collisions', async () => {
    const patchedRepos: Array<Record<string, unknown>> = [];
    createClient({ repo: { repo_id: repoId }, patchedRepos });

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
    expect(patchedRepos.at(-1)).toMatchObject({
      local_path: '/safe/repos/smoke/agor-assistant-pr1258',
    });
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
      { command: 'git.repo.delete', sessionToken: 'jwt', params: { repoId } },
      {}
    );

    expect(result.success).toBe(true);
    expect(mocks.deleteBranchDirectory).toHaveBeenCalledTimes(1002);
    expect(mocks.deleteBranchDirectory).toHaveBeenNthCalledWith(
      1001,
      '/safe/worktrees/repo/branch-1000'
    );
    expect(mocks.deleteRepoDirectory).toHaveBeenCalledWith('/safe/repos/repo');
  });

  it('rejects git.repo.delete if branch query returns a foreign branch', async () => {
    createClient({
      repo: { repo_id: repoId, local_path: '/safe/repos/repo' },
      branches: [
        { branch_id: branchId, repo_id: '550e8400-e29b-41d4-a716-446655440099', path: '/bad' },
      ],
    });

    const result = await handleGitRepoDelete(
      { command: 'git.repo.delete', sessionToken: 'jwt', params: { repoId } },
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
