import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteBranchDirectory, deleteRepoDirectory } from './index';

describe('managed directory deletion roots', () => {
  let tempDir: string;
  let tenantRoot: string;
  let reposRoot: string;
  let branchesRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-tenant-delete-'));
    tenantRoot = path.join(tempDir, 'tenants', 'tenant-a');
    reposRoot = path.join(tenantRoot, 'repos');
    branchesRoot = path.join(tenantRoot, 'worktrees');
    await fs.mkdir(reposRoot, { recursive: true });
    await fs.mkdir(branchesRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('deletes paths inside explicitly supplied tenant roots', async () => {
    const repoPath = path.join(reposRoot, 'org', 'repo');
    const branchPath = path.join(branchesRoot, 'org', 'repo', 'feature');
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(branchPath, { recursive: true });

    await deleteBranchDirectory(branchPath, branchesRoot);
    await deleteRepoDirectory(repoPath, reposRoot);

    await expect(fs.access(branchPath)).rejects.toThrow();
    await expect(fs.access(repoPath)).rejects.toThrow();
  });

  it('rejects paths belonging to another tenant', async () => {
    const otherRepo = path.join(tempDir, 'tenants', 'tenant-b', 'repos', 'org', 'repo');
    const otherBranch = path.join(
      tempDir,
      'tenants',
      'tenant-b',
      'worktrees',
      'org',
      'repo',
      'feature'
    );
    await fs.mkdir(otherRepo, { recursive: true });
    await fs.mkdir(otherBranch, { recursive: true });

    await expect(deleteRepoDirectory(otherRepo, reposRoot)).rejects.toThrow(/Safety check failed/);
    await expect(deleteBranchDirectory(otherBranch, branchesRoot)).rejects.toThrow(
      /Safety check failed/
    );
  });
});
