import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createExecutorClient: vi.fn(),
  parseAgorYml: vi.fn(),
  writeAgorYml: vi.fn(),
  deleteBranchDirectory: vi.fn(),
  deleteRepoDirectory: vi.fn(),
}));

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/config');
  return {
    ...actual,
    parseAgorYml: mocks.parseAgorYml,
    writeAgorYml: mocks.writeAgorYml,
  };
});

vi.mock('@agor/core/git', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/git');
  return {
    ...actual,
    deleteBranchDirectory: mocks.deleteBranchDirectory,
    deleteRepoDirectory: mocks.deleteRepoDirectory,
  };
});

vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: mocks.createExecutorClient,
}));

import {
  handleBranchAgorYmlExport,
  handleBranchAgorYmlImport,
  handleGitRepoDelete,
} from './git.js';

const repoId = '550e8400-e29b-41d4-a716-446655440001';
const branchId = '550e8400-e29b-41d4-a716-446655440002';

function createClient(records: {
  repo?: Record<string, unknown>;
  branches?: Array<Record<string, unknown>>;
  branch?: Record<string, unknown>;
}) {
  const client = {
    io: { disconnect: vi.fn() },
    service: vi.fn((name: string) => {
      if (name === 'repos') {
        return { get: vi.fn(async () => records.repo) };
      }
      if (name === 'branches') {
        return {
          get: vi.fn(async () => records.branch),
          find: vi.fn(async () => ({ data: records.branches ?? [] })),
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
