import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRANCH_ARCHIVE_COMMAND,
  DEFAULT_BRANCH_CLEANUP_COMMAND,
  type DelegatedBranchWorkspaceStorage,
} from '@agor/core/types';
import { removeBranchWorkspace, simpleGit } from '@agor/git';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type BranchArchivePayload, BranchArchivePayloadSchema } from '../payload-types';
import { handleBranchArchive } from './branch-cleanup';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, stat: vi.fn(fs.stat) };
});
vi.mock('@agor/git', async (original) => {
  const git = await original<typeof import('@agor/git')>();
  return { ...git, removeBranchWorkspace: vi.fn(git.removeBranchWorkspace) };
});
let root: string;
let storage: DelegatedBranchWorkspaceStorage;
let actualStat: typeof stat;
beforeEach(async () => {
  actualStat = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).stat;
  root = await mkdtemp(join(tmpdir(), 'agor-external-cleanup-test-'));
  const tenantDataRoot = join(root, 'tenant-a');
  storage = {
    tenantDataRoot,
    branchesRoot: join(tenantDataRoot, 'worktrees'),
    branchPath: join(tenantDataRoot, 'worktrees', 'repo', 'victim'),
    repoPath: join(tenantDataRoot, 'repos', 'repo'),
    storageMode: 'clone',
  };
  await mkdir(storage.branchPath, { recursive: true });
  await mkdir(storage.repoPath, { recursive: true });
  await mkdir(join(storage.branchesRoot, 'neighbor'));
  await mkdir(join(root, 'tenant-b'));
  await writeFile(join(root, 'tenant-b', 'keep'), 'foreign tenant');
  await writeFile(join(storage.branchesRoot, 'neighbor', 'cache'), 'neighbor');
  // Model Cloud's mounted device identity only; Git, realpath, symlink checks
  // and recursive removal operate on real disposable directories. No SDK home
  // parent mount is provided: archive must not require or remove SDK storage.
  vi.mocked(stat).mockImplementation((async (path: Parameters<typeof stat>[0]) => {
    const result = await actualStat(path);
    Object.defineProperty(result, 'dev', { value: String(path) === tenantDataRoot ? 1 : 2 });
    return result;
  }) as typeof stat);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"ok":true}'))
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.mocked(stat).mockReset();
  await rm(root, { recursive: true, force: true });
});
function request(action: 'cleaned' | 'deleted'): BranchArchivePayload {
  const identity = {
    branchId: randomUUID(),
    operationId: randomUUID(),
    generation: 1,
    executionId: randomUUID(),
    deadlineAt: Date.now() + 10_000,
    delegatedStorage: storage,
  };
  return {
    command: BRANCH_ARCHIVE_COMMAND,
    daemonUrl: 'http://fixture.invalid',
    sessionToken: 'fixture',
    params:
      action === 'deleted'
        ? {
            ...identity,
            filesystemAction: action,
            removal: {
              branchPath: storage.branchPath,
              repoPath: storage.repoPath,
              branchesRoot: storage.branchesRoot,
              storageMode: 'clone',
            },
          }
        : {
            ...identity,
            filesystemAction: action,
            cwd: storage.branchPath,
            principalBranchAccess: 'write',
            cleanup: { command: DEFAULT_BRANCH_CLEANUP_COMMAND },
          },
  };
}
async function assertNeighbors() {
  expect(await readFile(join(storage.branchesRoot, 'neighbor', 'cache'), 'utf8')).toBe('neighbor');
  expect(await readFile(join(root, 'tenant-b', 'keep'), 'utf8')).toBe('foreign tenant');
  expect((await lstat(storage.repoPath)).isDirectory()).toBe(true);
}
function reports() {
  return vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(init!.body as string).action);
}

it('cleans only ignored files in the selected clone, even with core.worktree pointing at a neighbor', async () => {
  const git = simpleGit(storage.branchPath);
  await git.init();
  await git.addConfig('user.name', 'Fixture');
  await git.addConfig('user.email', 'fixture@example.test');
  await writeFile(join(storage.branchPath, '.gitignore'), 'cache\n');
  await writeFile(join(storage.branchPath, 'tracked'), 'original');
  await git.add(['.gitignore', 'tracked']);
  await git.commit('fixture');
  await writeFile(join(storage.branchPath, 'tracked'), 'modified');
  await writeFile(join(storage.branchPath, 'cache'), 'ignored');
  await writeFile(join(storage.branchPath, 'untracked'), 'retained');
  await git.addConfig('core.worktree', join(storage.branchesRoot, 'neighbor'));
  expect(await handleBranchArchive(request('cleaned'), {})).toEqual({ success: true });
  expect(reports()).toEqual(['claim', 'succeeded']);
  await expect(lstat(join(storage.branchPath, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(storage.branchPath, 'tracked'), 'utf8')).toBe('modified');
  expect(await readFile(join(storage.branchPath, 'untracked'), 'utf8')).toBe('retained');
  await assertNeighbors();
});

it.each([true, false])(
  'removes checkout with verified mounts (initially exists: %s)',
  async (exists) => {
    if (!exists) await rm(storage.branchPath, { recursive: true });
    else await writeFile(join(storage.branchPath, 'uncommitted'), 'explicitly discarded');
    expect(await handleBranchArchive(request('deleted'), {})).toEqual({ success: true });
    await expect(lstat(storage.branchPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(reports()).toEqual(['claim', 'succeeded']);
    await assertNeighbors();
  }
);

it.each([
  'image-local',
  'different-device',
  'missing-mount',
  'inaccessible',
  'foreign-tenant',
  'symlink',
  'ancestor-symlink',
  'mismatched-target',
] as const)(
  'fails closed before removal for %s and allows a corrected invocation',
  async (failure) => {
    const payload = request('deleted');
    await writeFile(join(storage.branchPath, 'keep'), 'not removed');
    const normalStat = vi.mocked(stat).getMockImplementation()!;
    if (failure === 'image-local') vi.mocked(stat).mockImplementation(actualStat);
    if (failure === 'different-device')
      vi.mocked(stat).mockImplementation((async (path: Parameters<typeof stat>[0]) => {
        const result = await actualStat(path);
        Object.defineProperty(result, 'dev', {
          value: String(path).includes('/repos')
            ? 3
            : String(path) === storage.tenantDataRoot
              ? 1
              : 2,
        });
        return result;
      }) as typeof stat);
    if (failure === 'missing-mount' || failure === 'inaccessible')
      vi.mocked(stat).mockRejectedValueOnce(
        Object.assign(new Error('fixture'), {
          code: failure === 'missing-mount' ? 'ENOENT' : 'EACCES',
        })
      );
    if (failure === 'foreign-tenant') {
      payload.params.delegatedStorage = { ...storage, branchPath: join(root, 'tenant-b') };
      if (payload.params.filesystemAction === 'deleted')
        payload.params.removal.branchPath = join(root, 'tenant-b');
    }
    if (failure === 'mismatched-target')
      payload.params.delegatedStorage = {
        ...storage,
        branchPath: join(storage.branchesRoot, 'neighbor'),
      };
    if (failure === 'symlink' || failure === 'ancestor-symlink') {
      const link = join(storage.branchesRoot, 'link');
      await symlink(
        failure === 'symlink' ? storage.branchPath : join(storage.branchesRoot, 'repo'),
        link
      );
      const target = failure === 'symlink' ? link : join(link, 'victim');
      payload.params.delegatedStorage = { ...storage, branchPath: target };
      if (payload.params.filesystemAction === 'deleted') payload.params.removal.branchPath = target;
    }
    expect(await handleBranchArchive(payload, {})).toMatchObject({
      success: false,
      error: { code: 'CLEANUP_COMMAND_FAILED' },
    });
    expect(reports()).toEqual(['claim', 'failed']);
    expect(await readFile(join(storage.branchPath, 'keep'), 'utf8')).toBe('not removed');
    await assertNeighbors();
    vi.mocked(stat).mockImplementation(normalStat);
    expect(await handleBranchArchive(request('deleted'), {})).toEqual({ success: true });
  }
);

it.each(['missing', 'git-file', 'git-symlink'] as const)(
  'refuses cleanup of %s checkout metadata before Git starts',
  async (failure) => {
    await writeFile(join(storage.branchPath, 'cache'), 'untouched');
    if (failure === 'git-file')
      await writeFile(join(storage.branchPath, '.git'), 'gitdir: ../neighbor\n');
    if (failure === 'git-symlink')
      await symlink(storage.repoPath, join(storage.branchPath, '.git'));
    expect(await handleBranchArchive(request('cleaned'), {})).toMatchObject({
      success: false,
      error: { code: 'CLEANUP_COMMAND_FAILED' },
    });
    expect(reports()).toEqual(['claim', 'failed']);
    expect(await readFile(join(storage.branchPath, 'cache'), 'utf8')).toBe('untouched');
  }
);

it('does not accept delegated linked-worktree payloads or extra storage fields', () => {
  const payload = request('deleted');
  expect(BranchArchivePayloadSchema.safeParse(payload).success).toBe(true);
  for (const delegatedStorage of [
    { ...storage, storageMode: 'worktree' },
    { ...storage, extra: true },
  ]) {
    expect(
      BranchArchivePayloadSchema.safeParse({
        ...payload,
        params: { ...payload.params, delegatedStorage },
      }).success
    ).toBe(false);
  }
});

it('retains unknown outcome when removal throws or its completion report is lost', async () => {
  vi.mocked(removeBranchWorkspace).mockRejectedValueOnce(new Error('uncertain removal'));
  expect(await handleBranchArchive(request('deleted'), {})).toMatchObject({
    error: { code: 'CLEANUP_OUTCOME_UNKNOWN' },
  });
  expect(reports()).toEqual(['claim', 'unknown']);
  vi.mocked(fetch).mockClear();
  vi.mocked(fetch)
    .mockResolvedValueOnce(new Response('{"ok":true}'))
    .mockRejectedValueOnce(new Error('lost report'));
  expect(await handleBranchArchive(request('deleted'), {})).toMatchObject({
    error: { code: 'CLEANUP_REPORT_UNKNOWN' },
  });
  await expect(lstat(storage.branchPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await assertNeighbors();
});
