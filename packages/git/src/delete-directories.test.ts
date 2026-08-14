import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPrivilegedBranchDeleteArgs,
  deleteBranchDirectory,
  deleteRepoDirectory,
} from './index';

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

  it('refuses a symlinked branch root even when its target stays inside the allowed root', async () => {
    const realBranch = path.join(branchesRoot, 'org', 'repo', 'real-feature');
    const linkedBranch = path.join(branchesRoot, 'org', 'repo', 'linked-feature');
    await fs.mkdir(realBranch, { recursive: true });
    await fs.symlink(realBranch, linkedBranch, 'dir');

    await expect(deleteBranchDirectory(linkedBranch, branchesRoot)).rejects.toThrow(/symlink/i);
    await expect(fs.access(realBranch)).resolves.toBeUndefined();
  });

  it('refuses a branch path that traverses a symlink below the allowed root', async () => {
    const realRepo = path.join(branchesRoot, 'real-org', 'repo');
    const linkedOrg = path.join(branchesRoot, 'linked-org');
    const branchPath = path.join(linkedOrg, 'repo', 'feature');
    await fs.mkdir(path.join(realRepo, 'feature'), { recursive: true });
    await fs.symlink(path.join(branchesRoot, 'real-org'), linkedOrg, 'dir');

    await expect(deleteBranchDirectory(branchPath, branchesRoot)).rejects.toThrow(/symlink/i);
    await expect(fs.access(path.join(realRepo, 'feature'))).resolves.toBeUndefined();
  });

  it('uses the privileged deletion runner and independently verifies absence', async () => {
    const branchPath = path.join(branchesRoot, 'org', 'repo', 'feature');
    await fs.mkdir(branchPath, { recursive: true });
    let invoked = false;
    const privilegedDelete = async (target: string) => {
      invoked = true;
      expect(target).toBe(branchPath);
      await fs.rm(target, { recursive: true, force: true });
    };

    await deleteBranchDirectory(branchPath, branchesRoot, {
      privileged: true,
      privilegedDelete,
    });

    expect(invoked).toBe(true);
    await expect(fs.access(branchPath)).rejects.toThrow();
  });

  it('recovers from a deep node_modules-style directory that clips group write access', async () => {
    const branchPath = path.join(branchesRoot, 'org', 'repo', 'acl-fixture');
    const protectedDirectory = path.join(branchPath, 'node_modules', 'sqlite3', 'build', 'Release');
    await fs.mkdir(protectedDirectory, { recursive: true });
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        fs.writeFile(path.join(protectedDirectory, `native-${index}.node`), 'fixture')
      )
    );
    await fs.chmod(protectedDirectory, 0o550);

    // This is the production failure mode: recursive removal reaches the deep
    // directory, but cannot unlink its contents after the ACL mask/mode clips
    // write access.
    await expect(deleteBranchDirectory(branchPath, branchesRoot)).rejects.toMatchObject({
      code: 'EACCES',
    });

    await deleteBranchDirectory(branchPath, branchesRoot, {
      privileged: true,
      privilegedDelete: async (target) => {
        await fs.chmod(protectedDirectory, 0o770);
        await fs.rm(target, { recursive: true, force: true });
      },
    });

    await expect(fs.access(branchPath)).rejects.toThrow();
  });

  it('does not report success when the privileged command leaves the root behind', async () => {
    const branchPath = path.join(branchesRoot, 'org', 'repo', 'feature');
    await fs.mkdir(branchPath, { recursive: true });

    await expect(
      deleteBranchDirectory(branchPath, branchesRoot, {
        privileged: true,
        privilegedDelete: async () => undefined,
      })
    ).rejects.toThrow(/could not be verified/i);
    await expect(fs.access(branchPath)).resolves.toBeUndefined();
  });

  it('treats an already absent branch root as an idempotent success', async () => {
    const branchPath = path.join(branchesRoot, 'org', 'repo', 'missing');
    let invoked = false;

    await deleteBranchDirectory(branchPath, branchesRoot, {
      privileged: true,
      privilegedDelete: async () => {
        invoked = true;
      },
    });

    expect(invoked).toBe(false);
  });
});

describe('privileged branch deletion command', () => {
  it('keeps the exact validated root in one argv position after the option separator', () => {
    const target = '/safe/worktrees/repo/feature;touch should-not-run';

    expect(buildPrivilegedBranchDeleteArgs(target)).toEqual([
      '-n',
      '/usr/bin/rm',
      '-rf',
      '--one-file-system',
      '--preserve-root=all',
      '--',
      target,
    ]);
  });
});
