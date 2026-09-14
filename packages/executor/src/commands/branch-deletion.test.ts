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
  it.each([false, true])(
    'removes owned clone/home and preserves neighbors; unknown upload=%s',
    async (unknownUpload) => {
      const { mkdtemp, mkdir, writeFile, stat, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { handleBranchDelete } = await import('./branch-deletion');
      const root = await mkdtemp(join(tmpdir(), 'agor-delete-fixture-'));
      const id = '01900000-0000-7000-8000-000000000001';
      const workspace = join(root, 'branches', 'victim');
      const home = join(root, 'homes', id);
      const neighbor = join(root, 'branches', 'neighbor');
      const actions: string[] = [];
      try {
        for (const dir of [workspace, home, neighbor]) {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'fixture.txt'), 'fixture');
        }
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url, request) => {
            const body = JSON.parse(String(request.body));
            actions.push(body.action);
            expect(body.branch_id).toBe(id);
            if (body.action === 'upload' && unknownUpload)
              throw new Error('fixture transport loss');
            return new Response(JSON.stringify({ remaining: false }), { status: 200 });
          })
        );
        const result = await handleBranchDelete(
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
              branchHome: home,
              branchHomesRoot: join(root, 'homes'),
              storageMode: 'clone',
            },
          },
          {}
        );
        expect(result.success).toBe(!unknownUpload);
        await expect(stat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await stat(neighbor)).isDirectory()).toBe(true);
        expect(actions).toEqual(
          unknownUpload
            ? ['claim', 'quiesce', 'upload']
            : ['claim', 'quiesce', 'upload', 'storage', 'data', 'finalize']
        );
      } finally {
        vi.unstubAllGlobals();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
