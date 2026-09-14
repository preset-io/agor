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

  it('never follows a branch symlink into a neighboring branch in the same root', async () => {
    const neighbor = path.join(branchesRoot, 'neighbor');
    const victim = path.join(branchesRoot, 'victim');
    await fs.mkdir(neighbor);
    await fs.writeFile(path.join(neighbor, 'keep'), 'shared neighbor');
    await fs.symlink(neighbor, victim);
    await expect(deleteBranchDirectory(victim, branchesRoot)).rejects.toThrow('symlink');
    expect(await fs.readFile(path.join(neighbor, 'keep'), 'utf8')).toBe('shared neighbor');
  });

  it('rejects symlinked ancestors, including an otherwise missing target', async () => {
    const neighbor = path.join(branchesRoot, 'neighbor');
    await fs.mkdir(neighbor);
    const alias = path.join(branchesRoot, 'alias');
    await fs.symlink(neighbor, alias);
    await expect(deleteBranchDirectory(path.join(alias, 'missing'), branchesRoot)).rejects.toThrow(
      'symlink'
    );
    await expect(fs.stat(neighbor)).resolves.toBeDefined();
  });

  it('allows absent descendants on retry but not an unavailable managed root', async () => {
    await expect(
      deleteBranchDirectory(path.join(branchesRoot, 'missing', 'feature'), branchesRoot)
    ).resolves.toBeUndefined();
    await expect(
      deleteBranchDirectory(
        path.join(tempDir, 'unavailable', 'feature'),
        path.join(tempDir, 'unavailable')
      )
    ).rejects.toThrow();
    await expect(deleteBranchDirectory(branchesRoot, branchesRoot)).rejects.toThrow(
      'directory itself'
    );
  });
});
