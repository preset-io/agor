import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRANCH_ARCHIVE_COMMAND,
  BRANCH_CLEANUP_COMMAND,
  DEFAULT_BRANCH_CLEANUP_COMMAND,
} from '@agor/core/types';
import { simpleGit } from '@agor/git';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BranchArchivePayloadSchema, type BranchCleanPayload } from '../payload-types';
import { handleBranchArchive, handleBranchClean } from './branch-cleanup';

function payload(cwd: string, command = DEFAULT_BRANCH_CLEANUP_COMMAND): BranchCleanPayload {
  return {
    command: BRANCH_CLEANUP_COMMAND,
    daemonUrl: 'http://127.0.0.1/fixture-only',
    sessionToken: 'fixture-only-token',
    params: {
      branchId: randomUUID(),
      operationId: randomUUID(),
      generation: 1,
      executionId: randomUUID(),
      deadlineAt: Date.now() + 5000,
      filesystemAction: 'cleaned',
      cwd,
      principalBranchAccess: 'write',
      cleanup: { command },
    },
  };
}
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
  )
);
afterEach(() => vi.unstubAllGlobals());

it('shares ignored-only cleanup inline with archive, without returning file listings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agor-cleanup-executor-test-'));
  try {
    await simpleGit(directory).init();
    await writeFile(join(directory, '.gitignore'), '*.disposable\n');
    await writeFile(join(directory, 'secret.disposable'), 'private');
    await writeFile(join(directory, 'keep'), 'retained');
    const request = payload(directory);
    expect(await handleBranchArchive({ ...request, command: BRANCH_ARCHIVE_COMMAND }, {})).toEqual({
      success: true,
    });
    await expect(readFile(join(directory, 'secret.disposable'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(directory, 'keep'), 'utf8')).toBe('retained');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('never starts custom cleanup, including commands that create detached children', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agor-detached-cleanup-test-'));
  try {
    const command = `printf started > started; node -e 'const c=require("node:child_process").spawn(process.execPath,["-e", "setTimeout(()=>require(\\"node:fs\\").writeFileSync(\\"late\\",\\"unsafe\\"),100)"],{detached:true,stdio:"ignore"});c.unref()'`;
    expect(await handleBranchClean(payload(directory, command), {})).toMatchObject({
      success: false,
      error: { code: 'CLEANUP_COMMAND_FAILED' },
    });
    await expect(readFile(join(directory, 'started'))).rejects.toMatchObject({ code: 'ENOENT' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(readFile(join(directory, 'late'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(init!.body as string).action)
    ).toEqual(['claim', 'failed']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects preview, unclaimed execution and missing workspaces without creating them', async () => {
  const directory = join(tmpdir(), `agor-cleanup-absent-${randomUUID()}`);
  const request = payload(directory);
  expect(await handleBranchClean(request, { dryRun: true })).toMatchObject({
    error: { code: 'CLEANUP_PREVIEW_UNSUPPORTED' },
  });
  vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 403 }));
  expect(await handleBranchClean(request, {})).toMatchObject({
    error: { code: 'CLEANUP_NOT_CLAIMED' },
  });
  expect(await handleBranchClean(request, {})).toMatchObject({
    error: { code: 'CLEANUP_COMMAND_FAILED' },
  });
  await expect(readFile(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not clean on rejected claim, or claim success for lost completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agor-cleanup-report-test-'));
  try {
    await simpleGit(directory).init();
    await writeFile(join(directory, '.gitignore'), 'cache\n');
    await writeFile(join(directory, 'cache'), 'ignored');
    const request = payload(directory);
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 409 }));
    await handleBranchClean(request, {});
    expect(await readFile(join(directory, 'cache'), 'utf8')).toBe('ignored');
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      .mockRejectedValueOnce(new Error('lost completion'));
    expect(await handleBranchClean(request, {})).toMatchObject({
      error: { code: 'CLEANUP_REPORT_UNKNOWN' },
    });
    await expect(readFile(join(directory, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('removal payload cannot contain a branch-shell mount or arbitrary cleanup command', () => {
  const clean = payload('/fixture');
  const {
    cwd: _cwd,
    principalBranchAccess: _access,
    cleanup: _cleanup,
    ...identity
  } = clean.params;
  const request = {
    ...clean,
    command: BRANCH_ARCHIVE_COMMAND,
    params: {
      ...identity,
      filesystemAction: 'deleted',
      removal: {
        branchPath: '/fixture',
        branchesRoot: '/root',
        repoPath: '/repo',
        storageMode: 'clone',
      },
    },
  };
  expect(BranchArchivePayloadSchema.safeParse(request).success).toBe(true);
  expect(
    BranchArchivePayloadSchema.safeParse({
      ...request,
      params: { ...request.params, cwd: '/fixture' },
    }).success
  ).toBe(false);
  expect(
    BranchArchivePayloadSchema.safeParse({
      ...request,
      params: { ...request.params, cleanup: { command: 'arbitrary' } },
    }).success
  ).toBe(false);
});

it.each(['clone', 'worktree'] as const)(
  'archive removes a real %s workspace while retaining neighbors and SDK data',
  async (storageMode) => {
    const root = await mkdtemp(join(tmpdir(), 'agor-archive-remove-test-'));
    try {
      const repoPath = join(root, 'repo');
      const branchesRoot = join(root, 'branches');
      const branchPath = join(branchesRoot, 'victim');
      const neighbor = join(branchesRoot, 'neighbor');
      const home = join(root, 'sdk-home');
      await Promise.all([mkdir(repoPath), mkdir(branchesRoot), mkdir(home)]);
      await mkdir(neighbor);
      await writeFile(join(home, 'retained'), 'sdk');
      const git = simpleGit(repoPath);
      await git.init();
      await git.addConfig('user.name', 'Archive fixture');
      await git.addConfig('user.email', 'archive@example.test');
      await git.commit('fixture', { '--allow-empty': null });
      if (storageMode === 'worktree')
        await git.raw(['worktree', 'add', '-b', 'victim', branchPath]);
      else await mkdir(branchPath);
      await writeFile(join(branchPath, 'discard'), 'workspace');
      const request = payload(branchPath);
      const {
        cwd: _cwd,
        principalBranchAccess: _access,
        cleanup: _cleanup,
        ...identity
      } = request.params;
      expect(
        await handleBranchArchive(
          {
            ...request,
            command: BRANCH_ARCHIVE_COMMAND,
            params: {
              ...identity,
              filesystemAction: 'deleted',
              removal: { branchPath, branchesRoot, repoPath, storageMode },
            },
          },
          {}
        )
      ).toEqual({ success: true });
      await expect(readFile(join(branchPath, 'discard'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(home, 'retained'), 'utf8')).toBe('sdk');
      await writeFile(join(neighbor, 'still-here'), 'retained');
      if (storageMode === 'worktree') expect((await git.branchLocal()).all).toContain('victim');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
