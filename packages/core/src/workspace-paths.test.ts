import { describe, expect, it } from 'vitest';
import { assertManagedBranchPath, deriveManagedBranchPath } from './workspace-paths';

describe('managed branch workspace paths', () => {
  it.each(['/absolute', '../other', 'feature/../../other', 'feature\\..\\other'])(
    'rejects unsafe branch identity %s',
    (name) => expect(() => deriveManagedBranchPath('/managed/tenant-a', 'org/repo', name)).toThrow()
  );

  it('rejects a stored path from another tenant root', () => {
    expect(() =>
      assertManagedBranchPath({
        root: '/managed/tenant-b/worktrees',
        repoSlug: 'org/repo',
        branchName: 'feature',
        storedPath: '/managed/tenant-a/worktrees/org/repo/feature',
      })
    ).toThrow(/trusted storage layout/);
  });
});
