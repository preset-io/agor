import type { Branch, BranchID } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRANCH_FILESYSTEM_READY_POLL_INTERVAL_MS,
  waitForBranchFilesystemReady,
} from './branch-filesystem-readiness.js';

function branch(
  filesystemStatus: Branch['filesystem_status'],
  overrides: Partial<Branch> = {}
): Branch {
  return {
    branch_id: '01900000-0000-7000-8000-000000000001' as BranchID,
    repo_id: '01900000-0000-7000-8000-000000000002',
    branch_unique_id: 1,
    name: 'feature',
    branch: 'feature',
    path: '/tmp/feature',
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
    created_by: '01900000-0000-7000-8000-000000000003',
    archived: false,
    filesystem_status: filesystemStatus,
    ...overrides,
  } as Branch;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('waitForBranchFilesystemReady', () => {
  it.each(['worktree', 'clone'] as const)(
    'returns an already-ready %s branch immediately',
    async (storageMode) => {
      const ready = branch('ready', { storage_mode: storageMode });
      const readBranch = vi.fn(async () => ready);

      const result = await waitForBranchFilesystemReady({
        branchId: 'short-id',
        readBranch,
        now: () => 0,
      });

      expect(result).toMatchObject({
        outcome: 'ready',
        branch: ready,
        elapsedMs: 0,
        timeoutMs: 45_000,
      });
      expect(readBranch).toHaveBeenCalledOnce();
    }
  );

  it('polls once per second and switches to the canonical ID after the first read', async () => {
    vi.useFakeTimers();
    const creating = branch('creating');
    const ready = branch('ready');
    const readBranch = vi.fn().mockResolvedValueOnce(creating).mockResolvedValueOnce(ready);

    const waiting = waitForBranchFilesystemReady({ branchId: '01900000', readBranch });
    await vi.advanceTimersByTimeAsync(BRANCH_FILESYSTEM_READY_POLL_INTERVAL_MS);

    await expect(waiting).resolves.toMatchObject({ outcome: 'ready', branch: ready });
    expect(readBranch.mock.calls).toEqual([['01900000'], ['01900000-0000-7000-8000-000000000001']]);
  });

  it('returns the authoritative failed branch and persisted error', async () => {
    const failed = branch('failed', { error_message: 'safe materialization failure' });

    await expect(
      waitForBranchFilesystemReady({ branchId: failed.branch_id, readBranch: async () => failed })
    ).resolves.toMatchObject({ outcome: 'failed', branch: failed });
  });

  it.each([
    ['archived', branch('ready', { archived: true })],
    ['preserved', branch('preserved')],
    ['cleaned', branch('cleaned')],
    ['deleted', branch('deleted')],
  ] as const)('returns %s as an unavailable terminal state', async (reason, terminalBranch) => {
    await expect(
      waitForBranchFilesystemReady({
        branchId: terminalBranch.branch_id,
        readBranch: async () => terminalBranch,
      })
    ).resolves.toMatchObject({
      outcome: 'unavailable',
      unavailableReason: reason,
      branch: terminalBranch,
    });
  });

  it('times out without mutating or retrying a still-creating branch', async () => {
    vi.useFakeTimers();
    const creating = branch('creating');
    const readBranch = vi.fn(async () => creating);

    const waiting = waitForBranchFilesystemReady({
      branchId: creating.branch_id,
      readBranch,
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(waiting).resolves.toMatchObject({
      outcome: 'timeout',
      branch: creating,
      timeoutMs: 1_000,
    });
    expect(readBranch).toHaveBeenCalledTimes(2);
  });

  it('cleans up its timer when the MCP request is cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const creating = branch('creating');
    const waiting = waitForBranchFilesystemReady({
      branchId: creating.branch_id,
      readBranch: async () => creating,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);

    controller.abort(new Error('client disconnected'));

    await expect(waiting).rejects.toThrow('client disconnected');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes cancellation after an in-flight service read finishes', async () => {
    let finishRead!: (value: Branch) => void;
    const read = new Promise<Branch>((resolve) => {
      finishRead = resolve;
    });
    const controller = new AbortController();
    const waiting = waitForBranchFilesystemReady({
      branchId: 'short-id',
      readBranch: () => read,
      signal: controller.signal,
    });

    controller.abort(new Error('cancelled'));
    finishRead(branch('ready'));

    await expect(waiting).rejects.toThrow('cancelled');
  });

  it('propagates tenant/RBAC read failures without polling again', async () => {
    const readBranch = vi.fn(async () => {
      throw new Error('Forbidden');
    });

    await expect(
      waitForBranchFilesystemReady({ branchId: 'other-tenant', readBranch })
    ).rejects.toThrow('Forbidden');
    expect(readBranch).toHaveBeenCalledOnce();
  });

  it.each([999, 300_001, 1_000.5])('rejects invalid timeout %s', async (timeoutMs) => {
    await expect(
      waitForBranchFilesystemReady({
        branchId: 'branch-id',
        readBranch: async () => branch('ready'),
        timeoutMs,
      })
    ).rejects.toThrow(/timeoutMs must be an integer from 1000 to 300000/);
  });
});
