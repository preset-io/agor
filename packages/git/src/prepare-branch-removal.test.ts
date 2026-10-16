import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteBranchDirectory, prepareBranchDirectoryForRemoval } from './index';

describe.skipIf(process.platform === 'win32')('prepareBranchDirectoryForRemoval', () => {
  let tempDir: string;
  let branchesRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-prepare-removal-'));
    branchesRoot = path.join(tempDir, 'worktrees');
    await fs.mkdir(branchesRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.chmod(path.join(tempDir, 'outside'), 0o700).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('restores write access on owned read-only directories so removal completes', async () => {
    const branchPath = path.join(branchesRoot, 'victim');
    const cache = path.join(branchPath, 'go', 'pkg', 'mod', 'module@v1');
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'file.go'), 'package fixture');
    await fs.chmod(cache, 0o500);
    await fs.chmod(path.dirname(cache), 0o500);
    await expect(deleteBranchDirectory(branchPath, branchesRoot)).rejects.toMatchObject({
      code: 'EACCES',
    });

    expect(await prepareBranchDirectoryForRemoval(branchPath, branchesRoot)).toEqual({
      blockedDirectories: 0,
      blockedOwnerUids: [],
    });
    await deleteBranchDirectory(branchPath, branchesRoot);
    await expect(fs.lstat(branchPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never follows symlinks out of the branch', async () => {
    const branchPath = path.join(branchesRoot, 'victim');
    const outside = path.join(tempDir, 'outside');
    await fs.mkdir(branchPath, { recursive: true });
    await fs.mkdir(path.join(outside, 'child'), { recursive: true });
    await fs.chmod(outside, 0o500);
    await fs.symlink(outside, path.join(branchPath, 'link'));

    await prepareBranchDirectoryForRemoval(branchPath, branchesRoot);
    expect((await fs.stat(outside)).mode & 0o777).toBe(0o500);
  });

  it('needs no preparation for an already-removed branch', async () => {
    expect(
      await prepareBranchDirectoryForRemoval(path.join(branchesRoot, 'gone'), branchesRoot)
    ).toEqual({ blockedDirectories: 0, blockedOwnerUids: [] });
  });

  it('keeps the managed-root safety check', async () => {
    await expect(
      prepareBranchDirectoryForRemoval(path.join(tempDir, 'elsewhere'), branchesRoot)
    ).rejects.toThrow('Safety check failed');
  });
});
