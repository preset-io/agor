import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertManagedBranchPath, deriveManagedBranchPath } from './workspace-paths';

const cleanup: string[] = [];
afterEach(async () =>
  Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
);

describe('managed branch workspace paths', () => {
  it.each(['/absolute', '../other', 'feature/../../other', 'feature\\..\\other'])(
    'rejects unsafe branch identity %s',
    (name) => expect(() => deriveManagedBranchPath('/managed/tenant-a', 'org/repo', name)).toThrow()
  );

  it('rejects a stored path from another tenant root', async () => {
    await expect(
      assertManagedBranchPath({
        root: '/managed/tenant-b/worktrees',
        repoSlug: 'org/repo',
        branchName: 'feature',
        storedPath: '/managed/tenant-a/worktrees/org/repo/feature',
      })
    ).rejects.toThrow(/trusted storage layout/);
  });

  it('rejects a symlinked ancestor that escapes the managed root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'agor-workspace-path-'));
    cleanup.push(base);
    const root = join(base, 'tenant-a', 'worktrees');
    const outside = join(base, 'tenant-b');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, 'org'));

    await expect(
      assertManagedBranchPath({
        root,
        repoSlug: 'org/repo',
        branchName: 'feature',
        storedPath: join(root, 'org', 'repo', 'feature'),
      })
    ).rejects.toThrow(/outside the managed root/);
  });
});
