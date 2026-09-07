/**
 * Regression: retry provisioning must be repairable after a prior FAILED
 * attempt left an empty directory at the branch path (the executor's fallback
 * `mkdirSync`). Before the fix, `createBranch` refused any pre-existing
 * directory, so a failed attempt permanently wedged the branch — retry looped
 * on "Target directory already exists" / "branch already in use" forever.
 *
 * `git worktree add` accepts an empty target, so provisioning must too. These
 * tests exercise the real git CLI via simple-git against a disposable repo.
 * Privacy: generic placeholder names only.
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBranch } from './index';

describe('createBranch — empty-directory tolerance (retry idempotency)', () => {
  let tempDir: string;
  let basePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-create-branch-'));
    basePath = path.join(tempDir, 'base');
    await fs.mkdir(basePath, { recursive: true });
    const git = simpleGit(basePath);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'dev@example.com');
    await git.addConfig('user.name', 'Dev');
    await fs.writeFile(path.join(basePath, 'README.md'), '# Sample App\n');
    await git.add('.');
    await git.commit('initial commit');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('materializes a worktree into a pre-existing EMPTY directory (failed-attempt leftover)', async () => {
    const target = path.join(tempDir, 'worktrees', 'feature-x');
    await fs.mkdir(target, { recursive: true }); // simulate the fallback mkdir
    expect(existsSync(target)).toBe(true);

    await createBranch(basePath, target, 'feature-x', true, false, 'main', {}, 'branch');

    // Now a valid checkout on the new branch.
    expect(existsSync(path.join(target, '.git'))).toBe(true);
    const head = (await simpleGit(target).revparse(['--abbrev-ref', 'HEAD'])).trim();
    expect(head).toBe('feature-x');
  });

  it('still REFUSES a pre-existing NON-EMPTY directory (never clobbers real content)', async () => {
    const target = path.join(tempDir, 'worktrees', 'occupied');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'important.txt'), 'user data');

    await expect(
      createBranch(basePath, target, 'occupied', true, false, 'main', {}, 'branch')
    ).rejects.toThrow(/not empty/i);

    // The user's file is untouched.
    expect(existsSync(path.join(target, 'important.txt'))).toBe(true);
  });

  it('materializes when the target directory does not exist at all (baseline)', async () => {
    const target = path.join(tempDir, 'worktrees', 'fresh');
    await createBranch(basePath, target, 'fresh', true, false, 'main', {}, 'branch');
    const head = (await simpleGit(target).revparse(['--abbrev-ref', 'HEAD'])).trim();
    expect(head).toBe('fresh');
  });
});
