import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BranchRepository, type Database, generateId, RepoRepository } from '@agor/core/db';
import type { BranchID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { resolveBranchWorkspacePath } from './branch-workspace-path';

async function seedBranch(db: Database, branchPath: string) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `workspace-path-${generateId()}`,
    name: 'Workspace Path Test Repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: path.dirname(branchPath),
    default_branch: 'main',
  });
  return new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: `workspace-path-${generateId()}`,
    ref: 'refs/heads/workspace-path',
    branch_unique_id: 1,
    path: branchPath,
    created_by: 'user-owner' as UUID,
    others_can: 'session',
  });
}

describe('resolveBranchWorkspacePath', () => {
  dbTest('rejects a derived sidecar path that is a symlink outside the branch', async ({ db }) => {
    const branchRoot = mkdtempSync(path.join(tmpdir(), 'agor-workspace-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'agor-sidecar-outside-'));
    try {
      const branch = await seedBranch(db, branchRoot);
      writeFileSync(path.join(branchRoot, 'doc.md'), '# Doc');
      writeFileSync(path.join(outside, 'stolen.json'), '{}');
      symlinkSync(path.join(outside, 'stolen.json'), path.join(branchRoot, 'doc.md.agor-kb.json'));

      await expect(
        resolveBranchWorkspacePath({
          branchRepo: new BranchRepository(db),
          branchId: branch.branch_id,
          subpath: 'doc.md.agor-kb.json',
          userId: 'user-reviewer',
          userRole: 'member',
        })
      ).rejects.toThrow(/escapes branch root/i);
    } finally {
      rmSync(branchRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
