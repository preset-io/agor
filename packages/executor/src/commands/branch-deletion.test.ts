import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BranchDeletionOperations, runBranchDeletion } from './branch-deletion';

afterEach(() => vi.useRealTimers());
function fixture() {
  const calls: string[] = [];
  const step = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  const operations: BranchDeletionOperations = {
    claim: step('claim'),
    heartbeat: step('heartbeat'),
    removeStorage: step('storage'),
    deleteDataBatch: vi.fn(async () => {
      calls.push('batch');
      return { remaining: false };
    }),
    finalize: step('finalize'),
    reportFailure: step('failure'),
  };
  return { operations, calls };
}
describe('executor-owned branch deletion', () => {
  it('verifies storage, drains bounded batches, and finalizes last', async () => {
    const { operations, calls } = fixture();
    vi.mocked(operations.deleteDataBatch).mockImplementationOnce(async () => {
      calls.push('batch');
      return { remaining: true };
    });
    expect(await runBranchDeletion(operations)).toEqual({ outcome: 'deleted' });
    expect(calls).toEqual(['claim', 'storage', 'batch', 'batch', 'finalize']);
  });
  it.each(['claim', 'removeStorage', 'deleteDataBatch', 'finalize'] as const)(
    'stops after %s fails without replaying destructive work',
    async (name) => {
      const { operations } = fixture();
      vi.mocked(operations[name]).mockRejectedValueOnce(
        new Error('secret path/token must not escape')
      );
      const result = await runBranchDeletion(operations);
      expect(result.outcome).toBe('unknown');
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(operations[name]).toHaveBeenCalledTimes(1);
      if (name === 'claim') {
        expect(operations.removeStorage).not.toHaveBeenCalled();
        expect(operations.reportFailure).not.toHaveBeenCalled();
      } else {
        expect(operations.reportFailure).toHaveBeenCalledTimes(1);
        if (name !== 'finalize') expect(operations.finalize).not.toHaveBeenCalled();
      }
    }
  );
  it('does not hide an unknown outcome when its failure report is lost', async () => {
    const { operations } = fixture();
    vi.mocked(operations.removeStorage).mockRejectedValueOnce(new Error('partial removal'));
    vi.mocked(operations.reportFailure).mockRejectedValueOnce(new Error('daemon replaced'));
    expect(await runBranchDeletion(operations)).toMatchObject({
      outcome: 'unknown',
      stage: 'storage',
    });
    expect(operations.deleteDataBatch).not.toHaveBeenCalled();
  });
  it('stops after storage settles if heartbeat authority was lost, and clears its timer', async () => {
    vi.useFakeTimers();
    const { operations } = fixture();
    let finishStorage!: () => void;
    vi.mocked(operations.removeStorage).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStorage = resolve;
        })
    );
    vi.mocked(operations.heartbeat).mockRejectedValue(new Error('credential rejected'));
    const result = runBranchDeletion(operations, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(operations.reportFailure).not.toHaveBeenCalled();
    finishStorage();
    expect(await result).toMatchObject({ outcome: 'unknown', stage: 'storage' });
    expect(operations.deleteDataBatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('concrete deletion command with disposable storage', () => {
  it.each([
    { unknownUpload: false, slow: false, malformedData: false },
    { unknownUpload: false, slow: false, malformedData: false, archive: true },
    { unknownUpload: false, slow: false, malformedData: false, archive: true, worktree: true },
    { unknownUpload: false, slow: false, malformedData: false, missingHome: true },
    { unknownUpload: false, slow: false, malformedData: false, missingHome: true, worktree: true },
    { unknownUpload: false, slow: false, malformedData: false, unsafeHome: 'foreign' },
    { unknownUpload: false, slow: false, malformedData: false, unsafeHome: 'symlink' },
    { unknownUpload: false, slow: false, malformedData: false, unsafeHome: 'missing_root' },
    { unknownUpload: true, slow: false, malformedData: false },
    { unknownUpload: false, slow: true, malformedData: false },
    { unknownUpload: false, slow: false, malformedData: true },
  ])(
    'deletes only verified storage: %j',
    async ({ unknownUpload, slow, malformedData, missingHome, unsafeHome, worktree, archive }) => {
      const { mkdtemp, mkdir, writeFile, stat, rm, symlink } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { handleBranchDelete } = await import('./branch-deletion');
      const root = await mkdtemp(join(tmpdir(), 'agor-delete-fixture-'));
      const id = '01900000-0000-7000-8000-000000000001';
      const workspace = join(root, 'branches', 'victim');
      const home = join(root, 'homes', id);
      const neighbor = join(root, 'branches', 'neighbor');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const actions: string[] = [];
      let releaseQuiesce: (() => void) | undefined;
      let renewed = false;
      try {
        for (const dir of [workspace, ...(missingHome ? [] : [home]), neighbor]) {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'fixture.txt'), 'fixture');
        }
        await mkdir(join(root, 'base'));
        if (worktree) {
          const { simpleGit } = await import('@agor/git');
          const base = join(root, 'base');
          const git = simpleGit(base);
          await git.init();
          await git.addConfig('user.email', 'fixture@example.invalid');
          await git.addConfig('user.name', 'Disposable fixture');
          await writeFile(join(base, 'tracked'), 'fixture');
          await git.add('.');
          await git.commit('fixture');
          await rm(workspace, { recursive: true });
          await git.raw(['worktree', 'add', '-b', 'victim', workspace]);
        }
        if (unsafeHome === 'symlink') {
          await rm(join(root, 'homes'), { recursive: true });
          await symlink(join(root, 'branches'), join(root, 'homes'));
        }
        if (slow) vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url, request) => {
            const body = JSON.parse(String(request.body));
            if (body.action !== 'heartbeat') actions.push(body.action);
            if (renewed) expect(request.headers.Authorization).toBe('Bearer renewed-fixture-token');
            if (body.action === 'heartbeat') {
              renewed = true;
              return new Response(
                JSON.stringify({ ok: true, sessionToken: 'renewed-fixture-token' })
              );
            }
            if (slow && body.action === 'quiesce')
              await new Promise<void>((resolve) => {
                releaseQuiesce = resolve;
              });
            expect(body.branch_id).toBe(id);
            if (body.action === 'data' && malformedData) return new Response('{}');
            if (body.action === 'upload' && unknownUpload)
              throw new Error('fixture transport loss');
            return new Response(JSON.stringify({ remaining: false }), { status: 200 });
          })
        );
        if (archive) {
          const { handleGitBranchRemove } = await import('./git');
          const result = await handleGitBranchRemove(
            {
              command: 'git.branch.remove',
              params: {
                branchId: id,
                branchPath: workspace,
                branchesRoot: join(root, 'branches'),
                repoPath: join(root, 'base'),
                storageMode: worktree ? 'worktree' : 'clone',
                deleteBranch: false,
              },
            },
            {}
          );
          expect(result.success).toBe(true);
          await expect(stat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
          expect((await stat(home)).isDirectory()).toBe(true);
          expect((await stat(neighbor)).isDirectory()).toBe(true);
          expect(actions).toEqual([]);
          return;
        }
        const pending = handleBranchDelete(
          {
            command: 'branch.delete',
            daemonUrl: 'https://daemon.invalid',
            sessionToken: 'fixture-not-a-credential',
            params: {
              branchId: id,
              operationId: id,
              generation: 1,
              executionId: id,
              branchPath: workspace,
              branchesRoot: join(root, 'branches'),
              repoPath: join(root, 'base'),
              branchHome:
                unsafeHome === 'missing_root' ? join(root, 'other-tenant', 'homes', id) : home,
              tenantDataRoot:
                unsafeHome === 'foreign' || unsafeHome === 'missing_root'
                  ? join(root, 'other-tenant')
                  : root,
              storageMode: worktree ? 'worktree' : 'clone',
            },
          },
          {}
        );
        if (slow) {
          // Keep one daemon step in flight longer than the initial 15-minute
          // credential while the existing worker heartbeat renews authority.
          while (!releaseQuiesce) await new Promise((resolve) => setImmediate(resolve));
          await vi.advanceTimersByTimeAsync(20 * 60_000);
          releaseQuiesce();
        }
        const result = await pending;
        if (unsafeHome) {
          expect(result.success).toBe(false);
          expect((await stat(workspace)).isDirectory()).toBe(true);
          expect((await stat(neighbor)).isDirectory()).toBe(true);
          expect(actions).toEqual(['claim', 'quiesce', 'failed']);
          expect(log).toHaveBeenCalledWith(
            `[branch.delete] event=storage_failed step=validate_sdk_home code=${unsafeHome === 'missing_root' ? 'ENOENT' : 'verification_failed'}`
          );
          expect(JSON.stringify(log.mock.calls)).not.toContain(root);
          return;
        }
        expect(result.success).toBe(!unknownUpload && !malformedData);
        await expect(stat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await stat(neighbor)).isDirectory()).toBe(true);
        if (worktree) {
          const { listGitWorktrees } = await import('@agor/git');
          expect(
            (await listGitWorktrees(join(root, 'base'))).some((entry) => entry.path === workspace)
          ).toBe(false);
          expect(await stat(join(root, 'base', 'tracked'))).toBeDefined();
        }
        expect(actions).toEqual(
          unknownUpload
            ? ['claim', 'quiesce', 'upload']
            : malformedData
              ? ['claim', 'quiesce', 'upload', 'storage', 'data']
              : ['claim', 'quiesce', 'upload', 'storage', 'data', 'finalize']
        );
      } finally {
        log.mockRestore();
        vi.unstubAllGlobals();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
