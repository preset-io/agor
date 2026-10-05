import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Branch, Repo } from '@agor/core/types';
import { createGit, resolveGitRef, simpleGit } from '@agor/git';
import type { UserGitEnvironment } from '@agor/git/pure';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GitBranchAddPayload } from '../payload-types.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { handleGitBranchAdd } from './git.js';

// Only the daemon boundary is stubbed here. Resolution, authenticated transport,
// object transfer, materialization and ownership markers all use real local Git.
vi.mock('../services/feathers-client.js', () => ({ createExecutorClient: vi.fn() }));

let root: string;
let repo: Repo;
let branch: Branch;
let env: UserGitEnvironment;
let remoteSha: string;
let localSha: string;
let payload: GitBranchAddPayload;
let patch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agor-teammate-default-'));
  const seed = join(root, 'seed');
  await mkdir(seed);
  const git = simpleGit(seed);
  await git.init(['--initial-branch=trunk']);
  await git.addConfig('user.name', 'Fixture');
  await git.addConfig('user.email', 'fixture@example.test');
  await writeFile(join(seed, 'template'), 'first');
  await git.add('.').commit('first');
  localSha = (await git.revparse('HEAD')).trim();
  const remote = join(root, 'template.git');
  await simpleGit().clone(seed, remote, ['--bare']);
  const cache = join(root, 'registered');
  await simpleGit().clone(remote, cache, ['--origin', 'upstream']);
  await git.addRemote('upstream', remote);
  await writeFile(join(seed, 'template'), 'latest');
  await git.add('.').commit('remote update');
  remoteSha = (await git.revparse('HEAD')).trim();
  await git.push('upstream', 'trunk');
  await simpleGit(cache).fetch('upstream');
  repo = {
    repo_id: 'repo',
    local_path: cache,
    remote_url: remote,
    default_branch: 'trunk',
  } as Repo;
  branch = {
    branch_id: 'branch' as Branch['branch_id'],
    branch_unique_id: 1,
    created_by: 'owner' as Branch['created_by'],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_used: new Date().toISOString(),
    archived: false,
    needs_attention: false,
    repo_id: repo.repo_id,
    path: join(root, 'teammate'),
    name: 'teammate' as Branch['name'],
    ref: 'teammate',
    new_branch: true,
    ref_type: 'branch',
    storage_mode: 'worktree',
    filesystem_status: 'creating',
    provisioning_attempt_id: 'attempt',
    custom_context: { teammate: { kind: 'teammate', displayName: 'Fixture' } },
  };
  env = {};
  payload = {
    command: 'git.branch.add',
    sessionToken: 'fixture',
    params: {
      branchId: branch.branch_id,
      repoId: repo.repo_id,
      provisioningAttemptId: 'attempt',
      allowExistingCheckout: false,
      useReference: false,
    },
  };
  patch = vi.fn(async (_id: string, data: Partial<Branch>) => Object.assign(branch, data));
  vi.mocked(createExecutorClient).mockResolvedValue({
    io: { disconnect: vi.fn() },
    service: (name: string) => {
      if (name === 'repos') return { get: async () => repo };
      if (name === 'branches') return { get: async () => ({ ...branch }), patch };
      if (name === 'executor-git-environment') return { create: async () => env };
      throw new Error(`Unexpected service: ${name}`);
    },
  } as unknown as Awaited<ReturnType<typeof createExecutorClient>>);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each(['behind', 'diverged', 'clone'])(
  'implicit alternate default on non-origin remote uses exact live SHA (%s), never resets the cache',
  async (mode) => {
    const git = simpleGit(repo.local_path);
    if (mode === 'diverged') {
      await git.addConfig('user.name', 'Fixture');
      await git.addConfig('user.email', 'fixture@example.test');
      await git.raw(['commit', '--allow-empty', '-m', 'unpublished local work']);
      localSha = (await git.revparse('HEAD')).trim();
    }
    if (mode === 'clone') branch.storage_mode = 'clone';
    await writeFile(join(repo.local_path, 'keep-untracked'), 'local work');
    await writeFile(join(repo.local_path, 'template'), 'uncommitted local edit');
    const before = await git.raw(['status', '--porcelain=v1']);
    const config = await readFile(join(repo.local_path, '.git/config'), 'utf8');
    // This is the original failure; fetching the cache does not fix it.
    await expect(
      resolveGitRef(repo.local_path, 'trunk', {
        remote: { url: repo.remote_url!, name: 'upstream' },
      })
    ).rejects.toThrow('ambiguous');
    expect(await handleGitBranchAdd(payload, {})).toMatchObject({ success: true });
    expect(branch.base_sha).toBe(remoteSha);
    expect(branch.base_source).toEqual({ name: 'trunk', remote_url: repo.remote_url });
    expect((await simpleGit(branch.path).revparse('HEAD')).trim()).toBe(remoteSha);
    expect((await git.revparse('trunk')).trim()).toBe(localSha);
    expect(await git.raw(['status', '--porcelain=v1'])).toBe(before);
    expect(await readFile(join(repo.local_path, '.git/config'), 'utf8')).toBe(config);
    expect(await readFile(join(repo.local_path, 'keep-untracked'), 'utf8')).toBe('local work');
    expect(await readFile(join(repo.local_path, 'template'), 'utf8')).toBe(
      'uncommitted local edit'
    );
  }
);

it.each(['trunk', 'refs/heads/trunk'])('preserves explicit ref %s', async (ref) => {
  branch.base_ref = ref;
  const result = await handleGitBranchAdd(payload, {});
  if (ref === 'trunk') {
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('ambiguous');
    await expect(stat(branch.path)).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    expect(result.success).toBe(true);
    expect(branch.base_sha).toBe(localSha);
    expect((await simpleGit(branch.path).revparse('HEAD')).trim()).toBe(localSha);
  }
});

it.each(['worktree', 'clone'] as const)(
  'ordinary branch without a source ref starts from the live remote default (%s)',
  async (mode) => {
    delete branch.custom_context;
    branch.storage_mode = mode;
    const git = simpleGit(repo.local_path);
    expect(await handleGitBranchAdd(payload, {})).toMatchObject({ success: true });
    expect(branch.base_sha).toBe(remoteSha);
    expect(branch.base_source).toEqual({ name: 'trunk', remote_url: repo.remote_url });
    expect((await simpleGit(branch.path).revparse('HEAD')).trim()).toBe(remoteSha);
    expect((await git.revparse('trunk')).trim()).toBe(localSha);
  }
);

it('ordinary branch still refuses an explicit ambiguous source ref', async () => {
  delete branch.custom_context;
  branch.base_ref = 'trunk';
  const result = await handleGitBranchAdd(payload, {});
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain('ambiguous');
  await expect(stat(branch.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('clone storage resolves an explicit bare branch name against the live remote', async () => {
  delete branch.custom_context;
  branch.storage_mode = 'clone';
  branch.base_ref = 'trunk';
  expect(await handleGitBranchAdd(payload, {})).toMatchObject({ success: true });
  expect(branch.base_sha).toBe(remoteSha);
  expect(branch.base_source).toEqual({ name: 'trunk', remote_url: repo.remote_url });
  expect((await simpleGit(branch.path).revparse('HEAD')).trim()).toBe(remoteSha);
  expect((await simpleGit(repo.local_path).revparse('trunk')).trim()).toBe(localSha);
});

it('clone storage keeps commit SHAs on full resolution', async () => {
  delete branch.custom_context;
  branch.storage_mode = 'clone';
  branch.base_ref = localSha;
  expect(await handleGitBranchAdd(payload, {})).toMatchObject({ success: true });
  expect(branch.base_sha).toBe(localSha);
  expect((await simpleGit(branch.path).revparse('HEAD')).trim()).toBe(localSha);
});

it('clone storage still rejects a branch missing everywhere', async () => {
  delete branch.custom_context;
  branch.storage_mode = 'clone';
  branch.base_ref = 'no-such-branch';
  const result = await handleGitBranchAdd(payload, {});
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain('does not exist');
});

it.each(['teammate', 'ordinary'])('keeps local-only defaults local (%s)', async (kind) => {
  if (kind === 'ordinary') delete branch.custom_context;
  repo.remote_url = undefined;
  await simpleGit(repo.local_path).removeRemote('upstream');
  expect((await handleGitBranchAdd(payload, {})).success).toBe(true);
  expect(branch.base_sha).toBe(localSha);
});

it.each(['missing remote', 'missing branch'])(
  '%s fails without stale fallback; retry reuses the same teammate',
  async (failure) => {
    const url = repo.remote_url;
    if (failure === 'missing remote') repo.remote_url = join(root, 'missing.git');
    else repo.default_branch = 'missing';
    expect((await handleGitBranchAdd(payload, {})).success).toBe(false);
    expect(branch.filesystem_status).toBe('failed');
    expect(branch.base_sha).toBeUndefined();
    await expect(stat(branch.path)).rejects.toMatchObject({ code: 'ENOENT' });
    repo.remote_url = url;
    repo.default_branch = 'trunk';
    branch.filesystem_status = 'creating';
    expect((await handleGitBranchAdd(payload, {})).success).toBe(true);
    expect(branch.base_sha).toBe(remoteSha);
    expect((await simpleGit(repo.local_path).revparse('trunk')).trim()).toBe(localSha);
    expect((await simpleGit(repo.local_path).branchLocal()).all.sort()).toEqual([
      'teammate',
      'trunk',
    ]);
  }
);

it('retains selected remote provenance on retry after resolution but before materialization', async () => {
  const git = simpleGit(repo.local_path);
  // Worktree creation fails after the provenance report, without touching local work.
  await mkdir(branch.path);
  await writeFile(join(branch.path, 'keep'), 'unrelated files');
  expect((await handleGitBranchAdd(payload, {})).success).toBe(false);
  expect(branch.base_sha).toBe(remoteSha);
  expect(await readFile(join(branch.path, 'keep'), 'utf8')).toBe('unrelated files');
  // Only remove this fixture's obstruction, as an operator would after inspection.
  await rm(branch.path, { recursive: true });
  branch.filesystem_status = 'creating';
  expect((await handleGitBranchAdd(payload, {})).success).toBe(true);
  expect((await simpleGit(branch.path).revparse('HEAD')).trim()).toBe(remoteSha);
  expect((await git.revparse('trunk')).trim()).toBe(localSha);
});

it.each(['worktree', 'clone'] as const)(
  'retains missing-checkout behavior for %s',
  async (mode) => {
    branch.storage_mode = mode;
    repo.local_path = join(root, 'not-cloned');
    const result = await handleGitBranchAdd(payload, {});
    expect(result.success).toBe(mode === 'clone');
    if (mode === 'worktree')
      expect(result.error?.message).toContain('directory that does not exist');
    else expect((await simpleGit(branch.path).revparse('HEAD')).trim()).toBe(remoteSha);
  }
);

it('auth failure exposes safe technical details without falling back to local refs', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Access denied');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    repo.remote_url = `http://127.0.0.1:${address.port}/private.git`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await handleGitBranchAdd(payload, {});
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/403|Access denied/);
      expect(branch.error_message).toBe(result.error?.message);
      expect(branch.base_sha).toBeUndefined();
      expect((await createGit(repo.local_path).git.revparse('trunk')).trim()).toBe(localSha);
    } finally {
      log.mockRestore();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(['teammate', 'ordinary'])(
  'fetch failure after resolution is fatal, never a stale fallback; retry keeps source provenance (%s)',
  async (kind) => {
    if (kind === 'ordinary') delete branch.custom_context;
    const remote = repo.remote_url!;
    patch.mockImplementationOnce(async (_id: string, data: Partial<Branch>) => {
      Object.assign(branch, data);
      await rename(remote, `${remote}.unavailable`);
      return branch;
    });
    expect((await handleGitBranchAdd(payload, {})).success).toBe(false);
    expect(branch.base_sha).toBe(remoteSha);
    expect(branch.filesystem_status).toBe('failed');
    expect((await simpleGit(repo.local_path).branchLocal()).all).toEqual(['trunk']);
    await rename(`${remote}.unavailable`, remote);
    branch.filesystem_status = 'creating';
    expect((await handleGitBranchAdd(payload, {})).success).toBe(true);
    expect((await simpleGit(branch.path).revparse('HEAD')).trim()).toBe(remoteSha);
  }
);

it.each(['worktree', 'clone'] as const)(
  'does not accept a ref race during %s provisioning',
  async (mode) => {
    branch.storage_mode = mode;
    patch.mockImplementationOnce(async (_id: string, data: Partial<Branch>) => {
      Object.assign(branch, data);
      const seed = simpleGit(join(root, 'seed'));
      await seed.raw(['commit', '--allow-empty', '-m', 'concurrent update']);
      await seed.push('upstream', 'trunk');
      return branch;
    });
    const result = await handleGitBranchAdd(payload, {});
    expect(branch.base_sha).toBe(remoteSha);
    if (mode === 'worktree') {
      expect(result.success).toBe(true);
      expect((await simpleGit(branch.path).revparse('HEAD')).trim()).toBe(remoteSha);
    } else {
      // Existing clone policy fails closed when a branch moves mid-clone.
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('moved during clone');
    }
  }
);
