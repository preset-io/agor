import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertBranchWorkspaceMarker,
  deleteBranchDirectory,
  deleteRepoDirectory,
  removeBranchWorkspace,
  resolveManagedBranchWorkspacePath,
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
  it('shares verified clone removal without touching SDK homes or neighboring tenants', async () => {
    const victim = path.join(branchesRoot, 'org', 'repo', 'victim');
    const home = path.join(tenantRoot, 'branch-homes', 'victim');
    await fs.mkdir(victim, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    const options = {
      branchPath: victim,
      branchesRoot,
      repoPath: reposRoot,
      storageMode: 'clone' as const,
      branchId: 'victim-id',
    };
    await removeBranchWorkspace(options);
    await removeBranchWorkspace(options);
    await expect(fs.stat(victim)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(home)).isDirectory()).toBe(true);
    await fs.mkdir(path.join(reposRoot, 'org', 'repo'), { recursive: true });
    await expect(
      removeBranchWorkspace({
        ...options,
        branchPath: path.join(reposRoot, 'org', 'repo'),
        repoPath: path.join(reposRoot, 'org', 'repo'),
        branchesRoot: tenantRoot,
      })
    ).rejects.toThrow('shared base repository');
    await expect(
      removeBranchWorkspace({ ...options, repoPath: path.join(tenantRoot, 'missing-repo') })
    ).resolves.toBeUndefined();
    await expect(
      removeBranchWorkspace({
        ...options,
        repoPath: path.join(tenantRoot, 'missing-repo'),
        storageMode: 'worktree',
      })
    ).rejects.toThrow();
    await fs.mkdir(path.join(victim, 'base'), { recursive: true });
    await expect(
      removeBranchWorkspace({ ...options, repoPath: path.join(victim, 'base') })
    ).rejects.toThrow('shared base repository');
    const alias = path.join(reposRoot, 'alias');
    await fs.symlink(victim, alias);
    await expect(
      removeBranchWorkspace({ ...options, repoPath: path.join(alias, 'missing') })
    ).rejects.toThrow('shared base repository');
  });

  it('rejects symlink and foreign-tenant targets through shared workspace removal', async () => {
    const victim = path.join(branchesRoot, 'org', 'repo', 'victim');
    const foreign = path.join(tempDir, 'tenants', 'tenant-b', 'workspace');
    await fs.mkdir(foreign, { recursive: true });
    await fs.mkdir(path.dirname(victim), { recursive: true });
    await fs.symlink(foreign, victim);
    const options = {
      branchPath: victim,
      branchesRoot,
      repoPath: reposRoot,
      storageMode: 'worktree' as const,
      branchId: 'victim-id',
    };
    await expect(removeBranchWorkspace(options)).rejects.toThrow('symlink');
    await expect(removeBranchWorkspace({ ...options, branchPath: foreign })).rejects.toThrow(
      'Safety check'
    );
    expect((await fs.stat(foreign)).isDirectory()).toBe(true);
  });

  // A row that shares another branch's directory must never remove it.
  it.each([
    ['clone', (workspace: string) => path.join(workspace, '.git')],
    ['worktree', (workspace: string) => path.join(reposRoot, 'base', '.git', 'worktrees', 'v')],
  ] as const)('refuses a %s workspace marked for another branch', async (_mode, gitDirOf) => {
    const workspace = path.join(branchesRoot, 'org', 'repo', 'victim');
    const gitDir = gitDirOf(workspace);
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    if (gitDir !== path.join(workspace, '.git'))
      await fs.writeFile(path.join(workspace, '.git'), `gitdir: ${gitDir}\n`);
    await fs.writeFile(path.join(gitDir, 'agor-branch-id'), 'victim-id\n');
    const options = {
      branchPath: workspace,
      branchesRoot,
      repoPath: path.join(reposRoot, 'missing'),
      storageMode: 'clone' as const,
    };
    await expect(assertBranchWorkspaceMarker(workspace, 'attacker-id')).rejects.toThrow(
      'belongs to another branch'
    );
    await expect(removeBranchWorkspace({ ...options, branchId: 'attacker-id' })).rejects.toThrow(
      'belongs to another branch'
    );
    expect((await fs.stat(workspace)).isDirectory()).toBe(true);
    await removeBranchWorkspace({ ...options, branchId: 'victim-id' });
    await expect(fs.stat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still removes a workspace from before markers existed', async () => {
    const workspace = path.join(branchesRoot, 'org', 'repo', 'legacy');
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await expect(assertBranchWorkspaceMarker(workspace, 'legacy-id')).resolves.toBeUndefined();
  });

  it('never treats an org or repository directory as a branch workspace', async () => {
    const repoDir = path.join(branchesRoot, 'org', 'repo');
    await fs.mkdir(path.join(repoDir, 'feature'), { recursive: true });
    for (const shallow of [path.join(branchesRoot, 'org'), repoDir]) {
      await expect(resolveManagedBranchWorkspacePath(shallow, branchesRoot)).rejects.toThrow(
        '<org>/<repo>/<branch>'
      );
      await expect(
        removeBranchWorkspace({
          branchPath: shallow,
          branchesRoot,
          repoPath: reposRoot,
          storageMode: 'clone',
          branchId: 'victim-id',
        })
      ).rejects.toThrow('<org>/<repo>/<branch>');
    }
    await expect(
      resolveManagedBranchWorkspacePath(path.join(repoDir, 'feature'), branchesRoot)
    ).resolves.toBe(path.join(await fs.realpath(branchesRoot), 'org', 'repo', 'feature'));
    expect((await fs.stat(repoDir)).isDirectory()).toBe(true);
  });
});
