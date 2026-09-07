import type { Branch } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { waitForBranchRefResolution } from './branch-ref-resolution.js';

function branch(overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: '01900000-0000-7000-8000-000000000001',
    repo_id: '01900000-0000-7000-8000-000000000002',
    name: 'feature',
    ref: 'feature',
    path: '/worktrees/feature',
    new_branch: true,
    sessions: [],
    created_at: '2026-01-01T00:00:00.000Z',
    last_used: '2026-01-01T00:00:00.000Z',
    archived: false,
    filesystem_status: 'creating',
    ...overrides,
  } as Branch;
}

describe('waitForBranchRefResolution', () => {
  it('returns an already-reported concrete ref and SHA without polling', async () => {
    const resolved = branch({ base_ref: 'origin/main', base_sha: 'a'.repeat(40) });
    const readBranch = vi.fn();
    await expect(waitForBranchRefResolution({ branch: resolved, readBranch })).resolves.toEqual({
      outcome: 'resolved',
      branch: resolved,
    });
    expect(readBranch).not.toHaveBeenCalled();
  });

  it('polls until the executor reports the resolved ref and SHA', async () => {
    vi.useFakeTimers();
    const creating = branch({ base_ref: 'main' });
    const resolved = branch({ base_ref: 'main', base_sha: 'b'.repeat(40) });
    const readBranch = vi.fn(async () => resolved);
    const waiting = waitForBranchRefResolution({ branch: creating, readBranch });
    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).resolves.toEqual({ outcome: 'resolved', branch: resolved });
    vi.useRealTimers();
  });

  it('surfaces a terminal resolution failure instead of returning the requested spelling', async () => {
    const failed = branch({
      filesystem_status: 'failed',
      base_ref: 'main',
      error_message: "Git ref 'main' is ambiguous",
    });
    await expect(
      waitForBranchRefResolution({ branch: failed, readBranch: vi.fn() })
    ).resolves.toEqual({ outcome: 'failed', branch: failed });
  });
});
