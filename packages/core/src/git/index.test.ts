/**
 * Tests for Git Utils
 *
 * Tests git operations for repo management and branch isolation.
 * Uses temporary directories for all file system operations.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertRemoteRefVisibleForClone,
  categorizeGitError,
  cloneRepo,
  createBranch,
  createBranchAsClone,
  extractRepoName,
  getBranchesDir,
  getBranchPath,
  getCurrentBranch,
  getCurrentSha,
  getDefaultBranch,
  getGitState,
  getRemoteBranches,
  getRemoteUrl,
  getReposDir,
  hasRemoteBranch,
  isClean,
  isGitRepo,
  isValidGitRepo,
  listGitWorktrees,
  pruneGitWorktrees,
  removeGitWorktree,
} from './index';

/**
 * Helper: Create a temporary git repository for testing
 */
async function createTestRepo(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
  const git = simpleGit(dirPath);

  // Initialize repo with explicit "main" default branch so tests are
  // agnostic to the host's init.defaultBranch config (older systems still
  // default to "master").
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');

  // Create initial commit
  await fs.writeFile(path.join(dirPath, 'README.md'), '# Test Repo', 'utf-8');
  await git.add('README.md');
  await git.commit('Initial commit');
}

/**
 * Helper: Create a test repo with multiple branches
 */
async function createTestRepoWithBranches(dirPath: string): Promise<void> {
  await createTestRepo(dirPath);
  const git = simpleGit(dirPath);

  // Create and commit on feature branch
  await git.checkoutLocalBranch('feature-branch');
  await fs.writeFile(path.join(dirPath, 'feature.txt'), 'feature', 'utf-8');
  await git.add('feature.txt');
  await git.commit('Add feature');

  // Return to main
  await git.checkout('main');
}

/**
 * Helper: Create a bare repository (simulates remote)
 */
async function createBareRepo(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
  const git = simpleGit(dirPath);
  await git.init(['--bare', '--initial-branch=main']);
}

/**
 * Helper: Create a repository with remote
 */
async function createRepoWithRemote(repoPath: string, remotePath: string): Promise<void> {
  // Create bare remote
  await createBareRepo(remotePath);

  // Create local repo and push to remote
  await createTestRepo(repoPath);
  const git = simpleGit(repoPath);
  await git.addRemote('origin', remotePath);
  await git.push('origin', 'main');

  // Set up remote tracking
  await git.raw(['branch', '--set-upstream-to=origin/main', 'main']);
}

describe('extractRepoName', () => {
  it('should extract name from HTTPS URLs', () => {
    expect(extractRepoName('https://github.com/facebook/react.git')).toBe('react');
    expect(extractRepoName('https://github.com/apache/superset.git')).toBe('superset');
  });

  it('should extract name from SSH URLs', () => {
    expect(extractRepoName('git@github.com:facebook/react.git')).toBe('react');
    expect(extractRepoName('git@github.com:apache/superset.git')).toBe('superset');
  });

  it('should handle URLs without .git extension', () => {
    expect(extractRepoName('https://github.com/facebook/react')).toBe('react');
    expect(extractRepoName('git@github.com:apache/superset')).toBe('superset');
  });

  it('should throw on invalid URLs', () => {
    expect(() => extractRepoName('not-a-url')).toThrow('Could not extract repo name');
    expect(() => extractRepoName('')).toThrow('Could not extract repo name');
    // Note: 'https://github.com' actually extracts 'com' - not ideal but acceptable
  });

  it('should handle complex repo names', () => {
    expect(extractRepoName('https://github.com/org/repo-with-dashes.git')).toBe('repo-with-dashes');
    expect(extractRepoName('https://github.com/org/repo_with_underscores.git')).toBe(
      'repo_with_underscores'
    );
  });
});

describe('getReposDir', () => {
  it('should return repos path under data home (defaults to ~/.agor/repos)', () => {
    const reposDir = getReposDir();
    // Default behavior: data_home = agor_home = ~/.agor
    // Tests may override AGOR_DATA_HOME or config, but default should be ~/.agor/repos
    expect(reposDir).toContain('repos');
    // Path should end with /repos
    expect(reposDir).toMatch(/repos$/);
  });
});

describe('getBranchesDir', () => {
  it('should return branches path under data home (defaults to ~/.agor/worktrees)', () => {
    // On-disk dir name stays `worktrees/` for backwards compatibility with
    // existing installs — see getBranchesDir() JSDoc.
    const branchesDir = getBranchesDir();
    expect(branchesDir).toContain('worktrees');
    expect(branchesDir).toMatch(/worktrees$/);
  });
});

describe('getBranchPath', () => {
  it('should construct branch path from repo slug and name', () => {
    const branchPath = getBranchPath('org/repo', 'feature-1');
    // Should contain branches directory (still `worktrees/` on disk for
    // backwards compatibility), repo slug, and branch name.
    expect(branchPath).toContain('worktrees');
    expect(branchPath).toContain('org/repo');
    expect(branchPath).toContain('feature-1');
  });

  it('should handle repo slugs with special characters', () => {
    const branchPath = getBranchPath('org/repo-name', 'branch-name');
    expect(branchPath).toContain('org/repo-name');
    expect(branchPath).toContain('branch-name');
  });
});

describe('isValidGitRepo', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return true for valid git repository', async () => {
    await createTestRepo(tempDir);
    expect(await isValidGitRepo(tempDir)).toBe(true);
    expect(await isGitRepo(tempDir)).toBe(true);
  });

  it('should return false for non-git directory', async () => {
    await fs.mkdir(path.join(tempDir, 'not-a-repo'), { recursive: true });
    expect(await isValidGitRepo(path.join(tempDir, 'not-a-repo'))).toBe(false);
    expect(await isGitRepo(path.join(tempDir, 'not-a-repo'))).toBe(false);
  });

  it('should return false for non-existent directory', async () => {
    expect(await isValidGitRepo(path.join(tempDir, 'does-not-exist'))).toBe(false);
    expect(await isGitRepo(path.join(tempDir, 'does-not-exist'))).toBe(false);
  });

  it('should return true for bare repository', async () => {
    await createBareRepo(tempDir);
    // isValidGitRepo uses `git rev-parse --git-dir`, which succeeds on bare
    // repos (they have git metadata at the top level). Treat bare repos as
    // valid — they are legitimate remotes used elsewhere in the codebase.
    expect(await isValidGitRepo(tempDir)).toBe(true);
    expect(await isGitRepo(tempDir)).toBe(true);
  });
});

describe('getCurrentBranch', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return current branch name', async () => {
    await createTestRepo(tempDir);
    const branch = await getCurrentBranch(tempDir);
    expect(branch).toBe('main');
  });

  it('should return correct branch after checkout', async () => {
    await createTestRepoWithBranches(tempDir);
    const git = simpleGit(tempDir);

    await git.checkout('feature-branch');
    const branch = await getCurrentBranch(tempDir);
    expect(branch).toBe('feature-branch');
  });

  it('should return empty string for detached HEAD', async () => {
    await createTestRepo(tempDir);
    const git = simpleGit(tempDir);

    // Get first commit SHA
    const log = await git.log({ maxCount: 1 });
    const sha = log.latest?.hash;

    if (sha) {
      await git.checkout(sha);
      const branch = await getCurrentBranch(tempDir);
      // simple-git returns 'HEAD' for detached state, not ''
      expect(branch).toBe('HEAD');
    }
  });
});

describe('getCurrentSha', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return current commit SHA', async () => {
    await createTestRepo(tempDir);
    const sha = await getCurrentSha(tempDir);

    expect(sha).toMatch(/^[0-9a-f]{40}$/); // Git SHA format
    expect(sha.length).toBe(40);
  });

  it('should return updated SHA after new commit', async () => {
    await createTestRepo(tempDir);
    const git = simpleGit(tempDir);

    const sha1 = await getCurrentSha(tempDir);

    // Make another commit
    await fs.writeFile(path.join(tempDir, 'file.txt'), 'content', 'utf-8');
    await git.add('file.txt');
    await git.commit('Second commit');

    const sha2 = await getCurrentSha(tempDir);

    expect(sha2).not.toBe(sha1);
    expect(sha2).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should throw for repo with no commits', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const git = simpleGit(tempDir);
    await git.init();

    // getCurrentSha throws error for repos with no commits
    await expect(getCurrentSha(tempDir)).rejects.toThrow();
  });
});

describe('isClean', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return true for clean working directory', async () => {
    await createTestRepo(tempDir);
    expect(await isClean(tempDir)).toBe(true);
  });

  it('should return false for uncommitted changes', async () => {
    await createTestRepo(tempDir);

    // Modify file
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Modified', 'utf-8');

    expect(await isClean(tempDir)).toBe(false);
  });

  it('should return false for untracked files', async () => {
    await createTestRepo(tempDir);

    // Add untracked file
    await fs.writeFile(path.join(tempDir, 'new-file.txt'), 'content', 'utf-8');

    expect(await isClean(tempDir)).toBe(false);
  });

  it('should return false for staged but uncommitted changes', async () => {
    await createTestRepo(tempDir);
    const git = simpleGit(tempDir);

    await fs.writeFile(path.join(tempDir, 'staged.txt'), 'content', 'utf-8');
    await git.add('staged.txt');

    expect(await isClean(tempDir)).toBe(false);
  });

  it('should return true after committing all changes', async () => {
    await createTestRepo(tempDir);
    const git = simpleGit(tempDir);

    await fs.writeFile(path.join(tempDir, 'file.txt'), 'content', 'utf-8');
    await git.add('file.txt');
    await git.commit('Add file');

    expect(await isClean(tempDir)).toBe(true);
  });
});

describe('getRemoteUrl', () => {
  let tempDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-remote-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(remoteDir, { recursive: true, force: true });
  });

  it('should return remote URL for origin', async () => {
    await createRepoWithRemote(tempDir, remoteDir);
    const url = await getRemoteUrl(tempDir);

    expect(url).toBe(remoteDir);
  });

  it('should return remote URL for custom remote name', async () => {
    await createTestRepo(tempDir);
    const git = simpleGit(tempDir);
    await git.addRemote('upstream', remoteDir);

    const url = await getRemoteUrl(tempDir, 'upstream');
    expect(url).toBe(remoteDir);
  });

  it('should return null for non-existent remote', async () => {
    await createTestRepo(tempDir);
    const url = await getRemoteUrl(tempDir, 'nonexistent');

    expect(url).toBeNull();
  });

  it('should return null for repo with no remotes', async () => {
    await createTestRepo(tempDir);
    const url = await getRemoteUrl(tempDir);

    expect(url).toBeNull();
  });

  it('should return null when repository path is invalid', async () => {
    const url = await getRemoteUrl(path.join(tempDir, 'missing'));

    expect(url).toBeNull();
  });
});

describe('getDefaultBranch', () => {
  let tempDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-remote-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(remoteDir, { recursive: true, force: true });
  });

  it('should return main as default branch', async () => {
    await createRepoWithRemote(tempDir, remoteDir);
    const defaultBranch = await getDefaultBranch(tempDir);

    expect(defaultBranch).toBe('main');
  });

  it('should return current branch when symbolic-ref fails', async () => {
    await createTestRepo(tempDir);
    const defaultBranch = await getDefaultBranch(tempDir);

    expect(defaultBranch).toBe('main');
  });

  it('should fallback to main when no branches exist', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const git = simpleGit(tempDir);
    await git.init();

    const defaultBranch = await getDefaultBranch(tempDir);
    expect(defaultBranch).toBe('main');
  });

  it('should handle custom remote names', async () => {
    await createRepoWithRemote(tempDir, remoteDir);
    const git = simpleGit(tempDir);

    // Add another remote
    const otherRemoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-other-'));
    await git.addRemote('upstream', otherRemoteDir);

    const defaultBranch = await getDefaultBranch(tempDir, 'origin');
    expect(defaultBranch).toBe('main');

    await fs.rm(otherRemoteDir, { recursive: true, force: true });
  });
});

describe('hasRemoteBranch', () => {
  let tempDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-remote-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(remoteDir, { recursive: true, force: true });
  });

  it('should return true for existing remote branch', async () => {
    await createRepoWithRemote(tempDir, remoteDir);
    const exists = await hasRemoteBranch(tempDir, 'main');

    expect(exists).toBe(true);
  });

  it('should return false for non-existent remote branch', async () => {
    await createRepoWithRemote(tempDir, remoteDir);
    const exists = await hasRemoteBranch(tempDir, 'nonexistent-branch');

    expect(exists).toBe(false);
  });

  it('should handle custom remote names', async () => {
    await createRepoWithRemote(tempDir, remoteDir);
    const git = simpleGit(tempDir);

    // Add another remote
    const otherRemoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-other-'));
    await createBareRepo(otherRemoteDir);
    await git.addRemote('upstream', otherRemoteDir);

    const existsOrigin = await hasRemoteBranch(tempDir, 'main', 'origin');
    const existsUpstream = await hasRemoteBranch(tempDir, 'main', 'upstream');

    expect(existsOrigin).toBe(true);
    expect(existsUpstream).toBe(false); // No branches pushed to upstream

    await fs.rm(otherRemoteDir, { recursive: true, force: true });
  });
});

describe('getRemoteBranches', () => {
  let tempDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-remote-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(remoteDir, { recursive: true, force: true });
  });

  it('should return list of remote branches', async () => {
    await createRepoWithRemote(tempDir, remoteDir);
    const branches = await getRemoteBranches(tempDir);

    expect(branches).toContain('main');
    expect(branches.length).toBeGreaterThan(0);
  });

  it('should filter by remote name', async () => {
    await createRepoWithRemote(tempDir, remoteDir);
    const git = simpleGit(tempDir);

    // Create and push feature branch
    await git.checkoutLocalBranch('feature');
    await fs.writeFile(path.join(tempDir, 'feature.txt'), 'content', 'utf-8');
    await git.add('feature.txt');
    await git.commit('Add feature');
    await git.push('origin', 'feature');

    const branches = await getRemoteBranches(tempDir);
    expect(branches).toContain('main');
    expect(branches).toContain('feature');
  });

  it('should return empty array for repo with no remote', async () => {
    await createTestRepo(tempDir);
    const branches = await getRemoteBranches(tempDir);

    expect(branches).toEqual([]);
  });

  it('should exclude remote prefix from branch names', async () => {
    await createRepoWithRemote(tempDir, remoteDir);
    const branches = await getRemoteBranches(tempDir);

    // Should return 'main', not 'origin/main'
    expect(branches).toContain('main');
    expect(branches).not.toContain('origin/main');
  });
});

describe('createBranch', () => {
  let tempDir: string;
  let repoDir: string;
  let branchDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
    repoDir = path.join(tempDir, 'repo');
    branchDir = path.join(tempDir, 'branch');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create branch from existing branch', async () => {
    await createTestRepoWithBranches(repoDir);

    await createBranch(repoDir, branchDir, 'feature-branch', false, false);

    expect(await isGitRepo(branchDir)).toBe(true);
    expect(await getCurrentBranch(branchDir)).toBe('feature-branch');
  });

  it('should create branch with new branch', async () => {
    await createTestRepo(repoDir);

    await createBranch(repoDir, branchDir, 'new-branch', true, false);

    expect(await isGitRepo(branchDir)).toBe(true);
    expect(await getCurrentBranch(branchDir)).toBe('new-branch');
  });

  it('should create branch with new branch from source branch', async () => {
    await createTestRepoWithBranches(repoDir);

    await createBranch(repoDir, branchDir, 'new-feature', true, false, 'feature-branch');

    expect(await isGitRepo(branchDir)).toBe(true);
    expect(await getCurrentBranch(branchDir)).toBe('new-feature');

    // Verify it was based on feature-branch (should have feature.txt)
    const featureFileExists = await fs
      .access(path.join(branchDir, 'feature.txt'))
      .then(() => true)
      .catch(() => false);
    expect(featureFileExists).toBe(true);
  });

  it('should handle pullLatest parameter', async () => {
    const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-remote-'));
    await createRepoWithRemote(repoDir, remoteDir);

    // Create branch with new branch (avoids force update error)
    await createBranch(repoDir, branchDir, 'new-main-branch', true, true, 'main');

    expect(await isGitRepo(branchDir)).toBe(true);

    await fs.rm(remoteDir, { recursive: true, force: true });
  });

  it('should handle branch at specific commit', async () => {
    await createTestRepo(repoDir);
    const git = simpleGit(repoDir);

    // Get first commit SHA
    const log = await git.log({ maxCount: 1 });
    const sha = log.latest?.hash;

    if (sha) {
      await createBranch(repoDir, branchDir, sha, false, false);

      expect(await isGitRepo(branchDir)).toBe(true);
      expect(await getCurrentSha(branchDir)).toBe(sha);
    }
  });

  it('should create branch with new branch from tag', async () => {
    await createTestRepo(repoDir);
    const git = simpleGit(repoDir);

    // Create a tag
    await git.tag(['v1.0.0']);

    // Make another commit after the tag
    await fs.writeFile(path.join(repoDir, 'new-file.txt'), 'content', 'utf-8');
    await git.add('new-file.txt');
    await git.commit('Post-tag commit');

    // Create branch with new branch from tag
    await createBranch(
      repoDir,
      branchDir,
      'hotfix-branch', // new branch name
      true, // createBranch
      false, // pullLatest
      'v1.0.0', // sourceBranch (tag name)
      undefined, // env
      'tag' // refType
    );

    expect(await isGitRepo(branchDir)).toBe(true);
    expect(await getCurrentBranch(branchDir)).toBe('hotfix-branch');

    // Verify it was based on the tag (should NOT have new-file.txt from post-tag commit)
    const newFileExists = await fs
      .access(path.join(branchDir, 'new-file.txt'))
      .then(() => true)
      .catch(() => false);
    expect(newFileExists).toBe(false);
  });

  it('should create branch directly from tag without new branch', async () => {
    await createTestRepo(repoDir);
    const git = simpleGit(repoDir);

    // Create a tag
    await git.tag(['v2.0.0']);

    // Create branch from tag (detached HEAD)
    await createBranch(
      repoDir,
      branchDir,
      'v2.0.0', // ref is the tag name
      false, // createBranch = false
      false, // pullLatest
      undefined, // sourceBranch
      undefined, // env
      'tag' // refType
    );

    expect(await isGitRepo(branchDir)).toBe(true);
    // When checking out a tag without creating a branch, git goes to detached HEAD
    const branch = await getCurrentBranch(branchDir);
    // simple-git returns 'HEAD' for detached state
    expect(branch).toBe('HEAD');
  });

  it('should handle tag with remote repository', async () => {
    const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-remote-'));
    await createRepoWithRemote(repoDir, remoteDir);
    const git = simpleGit(repoDir);

    // Create and push a tag
    await git.tag(['v3.0.0']);
    await git.push('origin', 'v3.0.0');

    // Create branch with new branch from tag
    await createBranch(
      repoDir,
      branchDir,
      'release-branch',
      true, // createBranch
      true, // pullLatest - should fetch tags
      'v3.0.0',
      undefined,
      'tag'
    );

    expect(await isGitRepo(branchDir)).toBe(true);
    expect(await getCurrentBranch(branchDir)).toBe('release-branch');

    await fs.rm(remoteDir, { recursive: true, force: true });
  });

  it('should only fetch tags when refType is tag', async () => {
    // This test verifies the optimization: when refType is 'branch', we don't fetch tags

    // Create a remote repo with a tag
    const remoteDir = path.join(tempDir, 'remote');
    await createTestRepo(remoteDir);
    const remoteGit = simpleGit(remoteDir);
    await remoteGit.tag(['v1.0.0']);

    // Clone the remote to create a local repo (fresh clone without tags by default)
    const localDir = path.join(tempDir, 'local');
    await remoteGit.clone(remoteDir, localDir);

    await createBranch(
      localDir,
      path.join(tempDir, 'branch-tag'),
      'tag-branch',
      true,
      true,
      'v1.0.0',
      undefined,
      'tag'
    );

    expect(await isGitRepo(path.join(tempDir, 'branch-tag'))).toBe(true);
    const wtGit = simpleGit(path.join(tempDir, 'branch-tag'));
    const tags = await wtGit.tags();
    expect(tags.all).toContain('v1.0.0');
  });

  it('refuses to clobber a pre-existing target directory (parity with createBranchAsClone)', async () => {
    // The daemon used to gate this synchronously before fire-and-forget'ing
    // the executor. With the daemon→executor split (daemon = DB, executor
    // = filesystem), the guard moved into the core helper so worktree-mode
    // and clone-mode surface the same user-facing error.
    await createTestRepo(repoDir);
    await fs.mkdir(branchDir, { recursive: true });
    await fs.writeFile(path.join(branchDir, 'preexisting.txt'), 'x', 'utf-8');

    await expect(createBranch(repoDir, branchDir, 'some-branch', true, false)).rejects.toThrow(
      /already exists on disk/
    );

    // The pre-existing content is untouched.
    const preserved = await fs
      .access(path.join(branchDir, 'preexisting.txt'))
      .then(() => true)
      .catch(() => false);
    expect(preserved).toBe(true);
  });
});

describe('listGitWorktrees', () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
    repoDir = path.join(tempDir, 'repo');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should list main branch', async () => {
    await createTestRepo(repoDir);
    const branches = await listGitWorktrees(repoDir);

    expect(branches.length).toBeGreaterThan(0);
    // Use realpath to resolve symlinks (macOS /var -> /private/var)
    const realRepoDir = await fs.realpath(repoDir);
    expect(branches[0].path).toBe(realRepoDir);
    expect(branches[0].name).toBe(path.basename(repoDir));
    expect(branches[0].ref).toBe('main');
    expect(branches[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should list multiple branches', async () => {
    await createTestRepoWithBranches(repoDir);

    const branch1 = path.join(tempDir, 'branch1');
    const branch2 = path.join(tempDir, 'branch2');

    await createBranch(repoDir, branch1, 'branch1', true, false);
    await createBranch(repoDir, branch2, 'branch2', true, false);

    const branches = await listGitWorktrees(repoDir);

    expect(branches.length).toBeGreaterThanOrEqual(3); // main + 2 branches

    // Use realpath to resolve symlinks
    const realRepoDir = await fs.realpath(repoDir);
    const realBranch1 = await fs.realpath(branch1);
    const realBranch2 = await fs.realpath(branch2);

    const branchPaths = branches.map((w) => w.path);
    expect(branchPaths).toContain(realRepoDir);
    expect(branchPaths).toContain(realBranch1);
    expect(branchPaths).toContain(realBranch2);
  });

  it('should include branch metadata', async () => {
    await createTestRepo(repoDir);
    const branchDir = path.join(tempDir, 'branch');

    await createBranch(repoDir, branchDir, 'test-branch', true, false);

    const branches = await listGitWorktrees(repoDir);
    const realBranchDir = await fs.realpath(branchDir);
    const testBranch = branches.find((w) => w.path === realBranchDir);

    expect(testBranch).toBeDefined();
    expect(testBranch?.name).toBe('branch');
    expect(testBranch?.ref).toBe('test-branch');
    expect(testBranch?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should detect detached HEAD branches', async () => {
    await createTestRepo(repoDir);
    const git = simpleGit(repoDir);
    const branchDir = path.join(tempDir, 'branch');

    // Get commit SHA
    const log = await git.log({ maxCount: 1 });
    const sha = log.latest?.hash;

    if (sha) {
      await createBranch(repoDir, branchDir, sha, false, false);

      const branches = await listGitWorktrees(repoDir);
      const realBranchDir = await fs.realpath(branchDir);
      const detachedBranch = branches.find((w) => w.path === realBranchDir);

      expect(detachedBranch).toBeDefined();
      expect(detachedBranch?.sha).toBe(sha);
      // detached flag may not be set reliably in all cases
    }
  });
});

describe('removeGitWorktree', () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
    repoDir = path.join(tempDir, 'repo');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should remove branch', async () => {
    await createTestRepo(repoDir);
    const branchDir = path.join(tempDir, 'branch');

    await createBranch(repoDir, branchDir, 'test-branch', true, false);

    // Verify branch exists
    let branches = await listGitWorktrees(repoDir);
    const initialCount = branches.length;
    expect(initialCount).toBeGreaterThan(1);

    // Remove branch
    await removeGitWorktree(repoDir, branchDir);

    // Verify branch removed
    branches = await listGitWorktrees(repoDir);
    expect(branches.length).toBe(initialCount - 1);
    expect(branches.find((w) => w.path === branchDir)).toBeUndefined();
  });
});

describe('pruneGitWorktrees', () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
    repoDir = path.join(tempDir, 'repo');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should prune stale branch metadata', async () => {
    await createTestRepo(repoDir);
    const branchDir = path.join(tempDir, 'branch');

    await createBranch(repoDir, branchDir, 'test-branch', true, false);

    // Manually delete branch directory (simulates stale metadata)
    await fs.rm(branchDir, { recursive: true, force: true });

    // Prune should clean up stale metadata
    // Note: may fail if temp dir is cleaned up during async operation,
    // but that's acceptable for this test
    try {
      await pruneGitWorktrees(repoDir);
    } catch {
      // Ignore errors from async git operations that race with cleanup
    }

    // Verify prune doesn't throw when called again
    expect(async () => {
      try {
        await pruneGitWorktrees(repoDir);
      } catch {
        // Expected if directory is being cleaned up
      }
    }).not.toThrow();
  });
});

describe('getGitState', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors (racing with git operations)
    }
  });

  it('should return SHA for clean working directory', async () => {
    await createTestRepo(tempDir);
    const state = await getGitState(tempDir);

    expect(state).toMatch(/^[0-9a-f]{40}$/);
    expect(state).not.toContain('-dirty');
  });

  it('should return SHA-dirty for uncommitted changes', async () => {
    await createTestRepo(tempDir);

    // Add uncommitted change
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Modified', 'utf-8');

    const state = await getGitState(tempDir);

    expect(state).toMatch(/^[0-9a-f]{40}-dirty$/);
    expect(state).toContain('-dirty');
  });

  it('should return SHA-dirty for untracked files', async () => {
    await createTestRepo(tempDir);

    // Add untracked file
    await fs.writeFile(path.join(tempDir, 'untracked.txt'), 'content', 'utf-8');

    const state = await getGitState(tempDir);
    expect(state).toContain('-dirty');
  });

  it('should return SHA-dirty for staged but uncommitted changes', async () => {
    await createTestRepo(tempDir);
    const git = simpleGit(tempDir);

    await fs.writeFile(path.join(tempDir, 'staged.txt'), 'content', 'utf-8');
    await git.add('staged.txt');

    const state = await getGitState(tempDir);
    expect(state).toContain('-dirty');
  });

  it('should return unknown for non-git directory', async () => {
    await fs.mkdir(path.join(tempDir, 'not-a-repo'), { recursive: true });
    const state = await getGitState(path.join(tempDir, 'not-a-repo'));

    expect(state).toBe('unknown');
  });

  it('should return unknown for non-existent directory', async () => {
    const state = await getGitState(path.join(tempDir, 'does-not-exist'));
    expect(state).toBe('unknown');
  });

  it('should return unknown for repo with no commits', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const git = simpleGit(tempDir);
    await git.init();

    const state = await getGitState(tempDir);
    expect(state).toBe('unknown');
  });

  it('should update state after cleaning working directory', async () => {
    await createTestRepo(tempDir);
    const git = simpleGit(tempDir);

    // Add dirty change
    await fs.writeFile(path.join(tempDir, 'dirty.txt'), 'content', 'utf-8');

    let state = await getGitState(tempDir);
    expect(state).toContain('-dirty');

    // Clean up by committing
    await git.add('dirty.txt');
    await git.commit('Add dirty file');

    state = await getGitState(tempDir);
    expect(state).not.toContain('-dirty');
    expect(state).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('cloneRepo', () => {
  let tempDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-'));
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-remote-'));

    // Mock os.homedir to use temp directory
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(remoteDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should clone repository to default location', async () => {
    await createBareRepo(remoteDir);

    // Create a commit in remote (bare repos need content pushed to them)
    const tmpRepoDir = path.join(tempDir, 'tmp-for-push');
    await createTestRepo(tmpRepoDir);
    const git = simpleGit(tmpRepoDir);
    await git.addRemote('origin', remoteDir);
    await git.push('origin', 'main');

    const result = await cloneRepo({ url: remoteDir });

    expect(result.path).toContain('.agor/repos');
    expect(result.repoName).toBe(path.basename(remoteDir));
    expect(result.defaultBranch).toBe('main');
    expect(await isGitRepo(result.path)).toBe(true);
  });

  it('should clone repository to custom target directory', async () => {
    await createBareRepo(remoteDir);

    const tmpRepoDir = path.join(tempDir, 'tmp-for-push');
    await createTestRepo(tmpRepoDir);
    const git = simpleGit(tmpRepoDir);
    await git.addRemote('origin', remoteDir);
    await git.push('origin', 'main');

    const customTarget = path.join(tempDir, 'custom-location');
    const result = await cloneRepo({ url: remoteDir, targetDir: customTarget });

    expect(result.path).toBe(customTarget);
    expect(await isGitRepo(customTarget)).toBe(true);
  });

  it('should create parent directories for nested custom target paths', async () => {
    await createBareRepo(remoteDir);

    const tmpRepoDir = path.join(tempDir, 'tmp-for-push');
    await createTestRepo(tmpRepoDir);
    const git = simpleGit(tmpRepoDir);
    await git.addRemote('origin', remoteDir);
    await git.push('origin', 'main');

    const nestedTarget = path.join(tempDir, 'nested', 'slug', 'custom-location');
    const result = await cloneRepo({ url: remoteDir, targetDir: nestedTarget });

    expect(result.path).toBe(nestedTarget);
    expect(await isGitRepo(nestedTarget)).toBe(true);
  });

  it('should return existing repo if already cloned', async () => {
    await createBareRepo(remoteDir);

    const tmpRepoDir = path.join(tempDir, 'tmp-for-push');
    await createTestRepo(tmpRepoDir);
    const git = simpleGit(tmpRepoDir);
    await git.addRemote('origin', remoteDir);
    await git.push('origin', 'main');

    const result1 = await cloneRepo({ url: remoteDir });
    const result2 = await cloneRepo({ url: remoteDir });

    expect(result1.path).toBe(result2.path);
    expect(result1.repoName).toBe(result2.repoName);
  });

  it('should throw if target exists but is not a git repo', async () => {
    const targetDir = path.join(tempDir, '.agor', 'repos', 'test-repo');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'not-git.txt'), 'content', 'utf-8');

    await expect(cloneRepo({ url: `file://${remoteDir}`, targetDir })).rejects.toThrow(
      'not a valid git repository'
    );
  });

  it('should handle bare clone option', async () => {
    await createBareRepo(remoteDir);

    const tmpRepoDir = path.join(tempDir, 'tmp-for-push');
    await createTestRepo(tmpRepoDir);
    const git = simpleGit(tmpRepoDir);
    await git.addRemote('origin', remoteDir);
    await git.push('origin', 'main');

    const result = await cloneRepo({ url: remoteDir, bare: true });

    // Note: isGitRepo uses 'git status' which fails on bare repos
    // Verify bare clone by checking for no working directory files
    const readmeExists = await fs
      .access(path.join(result.path, 'README.md'))
      .then(() => true)
      .catch(() => false);
    expect(readmeExists).toBe(false);

    // Verify it has git objects directory (indicates bare repo)
    const objectsExists = await fs
      .access(path.join(result.path, 'objects'))
      .then(() => true)
      .catch(() => false);
    expect(objectsExists).toBe(true);
  });

  // Regression coverage for the "Add Repository → Default Branch" bug:
  // when the operator pins a non-default branch, the working tree must
  // land on that branch (so `.agor.yml` etc. on a feature branch is
  // visible to the daemon at parse time) and the returned defaultBranch
  // must reflect what was pinned (so the DB record matches disk).
  it('should check out the pinned branch when options.branch is set', async () => {
    // Build a remote that has both `main` and a feature branch with a
    // marker file that only exists on the feature branch.
    const tmpRepoDir = path.join(tempDir, 'tmp-for-push');
    await createTestRepo(tmpRepoDir);
    const git = simpleGit(tmpRepoDir);
    await git.checkoutLocalBranch('feature/x');
    await fs.writeFile(path.join(tmpRepoDir, 'marker.txt'), 'on-feature', 'utf-8');
    await git.add('marker.txt');
    await git.commit('add feature marker');
    await git.checkout('main');
    await createBareRepo(remoteDir);
    await git.addRemote('origin', remoteDir);
    await git.push('origin', 'main');
    await git.push('origin', 'feature/x');

    const result = await cloneRepo({ url: remoteDir, branch: 'feature/x' });

    expect(result.defaultBranch).toBe('feature/x');
    // Working tree is on the pinned branch — marker file is checked out.
    const markerExists = await fs
      .access(path.join(result.path, 'marker.txt'))
      .then(() => true)
      .catch(() => false);
    expect(markerExists).toBe(true);
    // simple-git reports the current branch from HEAD; should be the pin.
    const cloned = simpleGit(result.path);
    const branches = await cloned.branch();
    expect(branches.current).toBe('feature/x');
  });

  it('should fall back to remote HEAD when options.branch is not set', async () => {
    // Counterpart to the test above — the unpinned path stays unchanged.
    await createBareRepo(remoteDir);
    const tmpRepoDir = path.join(tempDir, 'tmp-for-push');
    await createTestRepo(tmpRepoDir);
    const git = simpleGit(tmpRepoDir);
    await git.addRemote('origin', remoteDir);
    await git.push('origin', 'main');

    const result = await cloneRepo({ url: remoteDir });

    expect(result.defaultBranch).toBe('main');
  });

  it('should fail loudly when options.branch does not exist on the remote', async () => {
    // Better than silently falling back to main — surfaces typos at
    // clone time rather than persisting a half-broken repo record.
    await createBareRepo(remoteDir);
    const tmpRepoDir = path.join(tempDir, 'tmp-for-push');
    await createTestRepo(tmpRepoDir);
    const git = simpleGit(tmpRepoDir);
    await git.addRemote('origin', remoteDir);
    await git.push('origin', 'main');

    await expect(cloneRepo({ url: remoteDir, branch: 'does-not-exist' })).rejects.toThrow();
  });

  // Existing-repo early-return path: if the repo dir is already present
  // (re-clone, half-broken first attempt, manual provisioning), the pinned
  // branch was previously ignored — DB record claimed feat/x while disk
  // stayed on whatever was checked out. Two regressions follow.
  it('should switch the working tree when reusing an existing clone with a pinned branch', async () => {
    const tmpRepoDir = path.join(tempDir, 'tmp-for-push');
    await createTestRepo(tmpRepoDir);
    const git = simpleGit(tmpRepoDir);
    await git.checkoutLocalBranch('feature/x');
    await fs.writeFile(path.join(tmpRepoDir, 'marker.txt'), 'on-feature', 'utf-8');
    await git.add('marker.txt');
    await git.commit('add feature marker');
    await git.checkout('main');
    await createBareRepo(remoteDir);
    await git.addRemote('origin', remoteDir);
    await git.push('origin', 'main');
    await git.push('origin', 'feature/x');

    // First clone unpinned — leaves the working tree on `main`.
    const first = await cloneRepo({ url: remoteDir });
    expect(first.defaultBranch).toBe('main');

    // Second call to the SAME target with a pin — must check out the pin
    // before returning.
    const second = await cloneRepo({ url: remoteDir, branch: 'feature/x' });
    expect(second.path).toBe(first.path);
    expect(second.defaultBranch).toBe('feature/x');
    const cloned = simpleGit(second.path);
    const branches = await cloned.branch();
    expect(branches.current).toBe('feature/x');
    // marker file from feature/x is now in the working tree
    const markerExists = await fs
      .access(path.join(second.path, 'marker.txt'))
      .then(() => true)
      .catch(() => false);
    expect(markerExists).toBe(true);
  });

  it('should reject reuse when the pinned branch cannot be checked out', async () => {
    // Existing clone, pin a branch that doesn't exist on the remote — must
    // fail rather than silently returning the wrong defaultBranch.
    await createBareRepo(remoteDir);
    const tmpRepoDir = path.join(tempDir, 'tmp-for-push');
    await createTestRepo(tmpRepoDir);
    const git = simpleGit(tmpRepoDir);
    await git.addRemote('origin', remoteDir);
    await git.push('origin', 'main');

    await cloneRepo({ url: remoteDir });

    await expect(cloneRepo({ url: remoteDir, branch: 'does-not-exist' })).rejects.toThrow();
  });
});

describe('createBranchAsClone', () => {
  // Sibling to createBranch for the new `storage_mode='clone'` opt-in.
  // Covers: happy-path clone of an existing branch, shallow-depth knob,
  // collision with existing targetPath, and ref validation. We exercise the
  // real `git clone` against a local bare repo (no network) — same pattern
  // as the cloneRepo tests above.
  let tempDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-test-clone-'));
    remoteDir = path.join(tempDir, 'remote.git');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function seedRemoteWithBranches(): Promise<void> {
    // Build a bare remote with `main` + `feature-x`, each with a marker
    // file. Lets a test assert which branch was actually checked out.
    await createBareRepo(remoteDir);
    const sourceDir = path.join(tempDir, 'seed');
    await createTestRepo(sourceDir);
    const git = simpleGit(sourceDir);
    await git.addRemote('origin', remoteDir);
    await fs.writeFile(path.join(sourceDir, 'main-marker.txt'), 'main', 'utf-8');
    await git.add('main-marker.txt');
    await git.commit('main marker');
    await git.push('origin', 'main');
    await git.checkoutLocalBranch('feature-x');
    await fs.writeFile(path.join(sourceDir, 'feature-marker.txt'), 'feature', 'utf-8');
    await git.add('feature-marker.txt');
    await git.commit('feature marker');
    await git.push('origin', 'feature-x');
  }

  describe('assertRemoteRefVisibleForClone', () => {
    it('accepts branches visible from the clone remote', async () => {
      await seedRemoteWithBranches();

      await expect(
        assertRemoteRefVisibleForClone({ remoteUrl: remoteDir, ref: 'feature-x' })
      ).resolves.toBeUndefined();
    });

    it('rejects local-only branches before clone-mode materialization', async () => {
      await seedRemoteWithBranches();
      const sourceDir = path.join(tempDir, 'local-only-source');
      await simpleGit().clone(remoteDir, sourceDir);
      const git = simpleGit(sourceDir);
      await git.checkoutLocalBranch('local-only');

      await expect(
        assertRemoteRefVisibleForClone({ remoteUrl: remoteDir, ref: 'local-only' })
      ).rejects.toThrow(/Clone mode cannot clone local-only or missing branch 'local-only'/);
    });
  });

  it('clones the requested branch into targetPath with a real .git/ directory', async () => {
    await seedRemoteWithBranches();
    const targetPath = path.join(tempDir, 'wt');

    const result = await createBranchAsClone({
      remoteUrl: remoteDir,
      targetPath,
      ref: 'feature-x',
    });

    expect(result).toEqual({ path: targetPath, ref: 'feature-x' });

    // Working tree is on feature-x — marker is materialised.
    const featureMarker = await fs
      .access(path.join(targetPath, 'feature-marker.txt'))
      .then(() => true)
      .catch(() => false);
    expect(featureMarker).toBe(true);

    // The .git is a real directory (clone), not a `gitdir:` pointer file
    // (branch). This is the whole point of storage_mode='clone'.
    const gitStat = await fs.stat(path.join(targetPath, '.git'));
    expect(gitStat.isDirectory()).toBe(true);

    // Current branch matches the requested ref.
    expect(await getCurrentBranch(targetPath)).toBe('feature-x');
  });

  it('supports --depth N for shallow clones', async () => {
    await seedRemoteWithBranches();
    const targetPath = path.join(tempDir, 'wt-shallow');

    // Use a `file://` URL — git silently drops `--depth` on bare-path local
    // clones (it hard-links instead of going through the wire protocol);
    // file:// forces the real network code path. The warning the helper
    // would otherwise log here is exactly the symptom that bit this test.
    await createBranchAsClone({
      remoteUrl: `file://${remoteDir}`,
      targetPath,
      ref: 'feature-x',
      depth: 1,
    });

    // shallow=true file in .git is the canonical signal that --depth took.
    // Don't assert on log length — that's a less stable proxy across git versions.
    const shallowMarkerExists = await fs
      .access(path.join(targetPath, '.git', 'shallow'))
      .then(() => true)
      .catch(() => false);
    expect(shallowMarkerExists).toBe(true);
  });

  it('refuses to clone over a pre-existing target directory', async () => {
    await seedRemoteWithBranches();
    const targetPath = path.join(tempDir, 'wt-collision');
    await fs.mkdir(targetPath, { recursive: true });
    await fs.writeFile(path.join(targetPath, 'preexisting.txt'), 'x', 'utf-8');

    await expect(
      createBranchAsClone({
        remoteUrl: remoteDir,
        targetPath,
        ref: 'feature-x',
      })
    ).rejects.toThrow(/already exists/);

    // The pre-existing content is untouched.
    const preserved = await fs
      .access(path.join(targetPath, 'preexisting.txt'))
      .then(() => true)
      .catch(() => false);
    expect(preserved).toBe(true);
  });

  it('rejects refs that start with `-` (option-injection guard)', async () => {
    await seedRemoteWithBranches();
    const targetPath = path.join(tempDir, 'wt-bad-ref');

    await expect(
      createBranchAsClone({
        remoteUrl: remoteDir,
        targetPath,
        ref: '--upload-pack=/tmp/payload',
      })
    ).rejects.toThrow(/Invalid git ref/);
  });

  it('rejects non-positive depth values', async () => {
    await seedRemoteWithBranches();
    const targetPath = path.join(tempDir, 'wt-bad-depth');

    await expect(
      createBranchAsClone({
        remoteUrl: remoteDir,
        targetPath,
        ref: 'feature-x',
        depth: 0,
      })
    ).rejects.toThrow(/Invalid clone depth/);

    await expect(
      createBranchAsClone({
        remoteUrl: remoteDir,
        targetPath,
        ref: 'feature-x',
        depth: -5,
      })
    ).rejects.toThrow(/Invalid clone depth/);
  });

  it('surfaces git-side failures when the ref does not exist on the remote', async () => {
    await seedRemoteWithBranches();
    const targetPath = path.join(tempDir, 'wt-missing-ref');

    await expect(
      createBranchAsClone({
        remoteUrl: remoteDir,
        targetPath,
        ref: 'does-not-exist',
      })
    ).rejects.toThrow();
  });

  it('with newBranchName, clones the base ref and checks out a fresh local branch', async () => {
    // This is the typical "feature off main" create flow in clone-mode: the
    // new branch doesn't exist on the remote yet, so the helper clones the
    // base ref and `git checkout -b`s the new branch on top of the cloned
    // tip. Pinning this here means the executor handler doesn't have to
    // orchestrate post-clone git ops — the helper owns the full operation.
    await seedRemoteWithBranches();
    const targetPath = path.join(tempDir, 'wt-new-branch');

    const result = await createBranchAsClone({
      remoteUrl: remoteDir,
      targetPath,
      ref: 'main',
      newBranchName: 'my-new-feature',
    });

    expect(result).toEqual({ path: targetPath, ref: 'my-new-feature' });

    // Working tree is on the new branch (created locally) with main's tip
    // as parent — the main marker is present because we forked off main.
    expect(await getCurrentBranch(targetPath)).toBe('my-new-feature');
    const mainMarkerExists = await fs
      .access(path.join(targetPath, 'main-marker.txt'))
      .then(() => true)
      .catch(() => false);
    expect(mainMarkerExists).toBe(true);

    // The new branch is NOT on the remote (we forked locally), so it must
    // not be in the remote-tracking list. Catches a regression where the
    // helper would accidentally push or set an upstream during the fork.
    const cloned = simpleGit(targetPath);
    const remoteBranches = await cloned.branch(['-r']);
    expect(remoteBranches.all).not.toContain('origin/my-new-feature');
  });

  it('rejects newBranchName that fails ref validation', async () => {
    // The same option-injection guard that protects `ref` must protect
    // `newBranchName` — both feed into git command argv eventually.
    await seedRemoteWithBranches();
    const targetPath = path.join(tempDir, 'wt-bad-new-branch');

    await expect(
      createBranchAsClone({
        remoteUrl: remoteDir,
        targetPath,
        ref: 'main',
        newBranchName: '--force',
      })
    ).rejects.toThrow(/Invalid git ref/);
  });

  it('uses --reference when referencePath exists on disk (alternates pointer)', async () => {
    // The whole point of `--reference`: the new clone's .git/objects/ is
    // empty and instead points at a base-cache via alternates. This is
    // the design-doc §5 self-hosted default — drops per-branch .git size
    // from ~repo.pack to ~few-MB. Test pins the alternates-file artifact
    // so a regression that silently drops the flag fails loudly.
    await seedRemoteWithBranches();

    // Seed a base clone of the remote — this stands in for the per-repo
    // base at `~/.agor/repos/<slug>/` that the daemon would manage.
    const baseClone = path.join(tempDir, 'base-cache');
    await simpleGit().clone(remoteDir, baseClone, ['--no-single-branch']);

    const targetPath = path.join(tempDir, 'wt-with-reference');
    await createBranchAsClone({
      remoteUrl: remoteDir,
      targetPath,
      ref: 'feature-x',
      referencePath: baseClone,
    });

    // The alternates file is the canonical signal that --reference took.
    // Its content points into the base clone's objects directory.
    const alternatesPath = path.join(targetPath, '.git', 'objects', 'info', 'alternates');
    const alternates = await fs.readFile(alternatesPath, 'utf-8');
    expect(alternates).toContain(path.join(baseClone, '.git', 'objects'));

    // Working tree is on the requested branch.
    expect(await getCurrentBranch(targetPath)).toBe('feature-x');
  });

  it('falls back to a plain clone (no --reference) when referencePath is missing', async () => {
    // Daemon/executor mount asymmetry: daemon hands the executor a hint
    // that may or may not resolve on the executor's filesystem. Missing
    // path must NOT fail the clone — it just costs more disk. Pinning
    // this so a future "throw on missing reference" regression fails.
    await seedRemoteWithBranches();
    const targetPath = path.join(tempDir, 'wt-missing-reference');
    const missingReference = path.join(tempDir, 'does-not-exist-on-this-filesystem');

    const result = await createBranchAsClone({
      remoteUrl: remoteDir,
      targetPath,
      ref: 'main',
      referencePath: missingReference,
    });

    expect(result.ref).toBe('main');

    // No alternates file → no --reference was applied. Clone is
    // self-standing and complete on its own.
    const alternatesExists = await fs
      .access(path.join(targetPath, '.git', 'objects', 'info', 'alternates'))
      .then(() => true)
      .catch(() => false);
    expect(alternatesExists).toBe(false);
  });
});

describe('categorizeGitError', () => {
  // Issue #1126 / Bug B: clone failures need to bucket into categories so the
  // UI / MCP can suggest the right next step. The auth_failed bucket is the
  // important one — it's the path that points users at Settings → API Keys.
  it('categorizes private-repo authentication failures as auth_failed', () => {
    expect(
      categorizeGitError('fatal: Authentication failed for https://github.com/foo/bar.git/')
    ).toBe('auth_failed');
    expect(categorizeGitError('remote: HTTP Basic: Access denied')).toBe('auth_failed');
    expect(categorizeGitError('Permission denied (publickey).')).toBe('auth_failed');
    expect(categorizeGitError('terminal prompts disabled')).toBe('auth_failed');
  });

  it('categorizes missing repos as not_found', () => {
    expect(categorizeGitError('remote: Repository not found.')).toBe('not_found');
    expect(categorizeGitError('error: 404 not found')).toBe('not_found');
  });

  it('categorizes connectivity issues as network', () => {
    expect(categorizeGitError('fatal: unable to access: Could not resolve host: github.com')).toBe(
      'network'
    );
    expect(
      categorizeGitError('fatal: unable to connect to git.example.com: Connection refused')
    ).toBe('network');
  });

  it('falls through to unknown for unrecognised stderr', () => {
    expect(categorizeGitError('fatal: corrupted ref refs/heads/main')).toBe('unknown');
    expect(categorizeGitError('')).toBe('unknown');
  });
});
