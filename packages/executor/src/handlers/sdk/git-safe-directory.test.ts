import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureSessionGitSafeDirectories } from './git-safe-directory.js';

function makeClient({
  branch = { path: '/worktrees/repo/feature', repo_id: 'repo-1' },
  repo = { local_path: '/repos/repo' },
}: {
  branch?: Record<string, unknown>;
  repo?: Record<string, unknown>;
} = {}) {
  return {
    service(name: string) {
      if (name === 'sessions') {
        return { get: vi.fn(async () => ({ branch_id: 'branch-1' })) };
      }
      if (name === 'branches') {
        return { get: vi.fn(async () => branch) };
      }
      if (name === 'repos') {
        return { get: vi.fn(async () => repo) };
      }
      throw new Error(`unexpected service ${name}`);
    },
  } as any;
}

describe('configureSessionGitSafeDirectories', () => {
  const originalGitConfigParameters = process.env.GIT_CONFIG_PARAMETERS;

  afterEach(() => {
    if (originalGitConfigParameters === undefined) {
      delete process.env.GIT_CONFIG_PARAMETERS;
    } else {
      process.env.GIT_CONFIG_PARAMETERS = originalGitConfigParameters;
    }
    vi.restoreAllMocks();
  });

  it('appends branch and repo safe.directory entries to inherited git config parameters', async () => {
    process.env.GIT_CONFIG_PARAMETERS = "'transfer.credentialsInUrl=die'";

    const paths = await configureSessionGitSafeDirectories(makeClient(), 'session-1' as any);

    expect(paths).toEqual(['/worktrees/repo/feature', '/repos/repo']);
    expect(process.env.GIT_CONFIG_PARAMETERS).toContain("'transfer.credentialsInUrl=die'");
    expect(process.env.GIT_CONFIG_PARAMETERS).toContain("'safe.directory=/worktrees/repo/feature'");
    expect(process.env.GIT_CONFIG_PARAMETERS).toContain("'safe.directory=/repos/repo'");
  });

  it('deduplicates branch and repo paths', async () => {
    delete process.env.GIT_CONFIG_PARAMETERS;

    const paths = await configureSessionGitSafeDirectories(
      makeClient({ repo: { local_path: '/worktrees/repo/feature' } }),
      'session-1' as any
    );

    expect(paths).toEqual(['/worktrees/repo/feature']);
    expect(process.env.GIT_CONFIG_PARAMETERS).toBe("'safe.directory=/worktrees/repo/feature'");
  });
});
