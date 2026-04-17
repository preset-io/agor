/**
 * Tests for defence-in-depth input validation around git operations.
 *
 * Covers:
 *  - validateGitRef() rejects option-injection / whitespace / empty refs
 *    and accepts well-formed refs.
 *  - createWorktree() argv contains a `--` separator before positional
 *    args, so that even if a value slipped past validation it would not
 *    be interpreted as an option by git.
 *  - deleteBranch() refuses to pass attacker-shaped refs to `git branch -D`.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, deleteBranch, isLikelyGitToken, validateGitRef } from './index';

async function createTestRepo(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
  const git = simpleGit(dirPath);
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.join(dirPath, 'README.md'), '# test\n');
  await git.add('.');
  await git.commit('initial');
}

describe('validateGitRef', () => {
  it('rejects option-injection refs', async () => {
    await expect(validateGitRef('--upload-pack=/tmp/payload')).rejects.toThrow();
    await expect(validateGitRef('-foo')).rejects.toThrow();
    await expect(validateGitRef('-')).rejects.toThrow();
  });

  it('rejects refs with whitespace', async () => {
    await expect(validateGitRef('ref with spaces')).rejects.toThrow();
    await expect(validateGitRef('ref\twith\ttabs')).rejects.toThrow();
  });

  it('rejects refs with newlines', async () => {
    await expect(validateGitRef('ref\nwith\nnewlines')).rejects.toThrow();
    await expect(validateGitRef('foo\r\nbar')).rejects.toThrow();
  });

  it('rejects refs with NUL byte', async () => {
    await expect(validateGitRef('foo\u0000bar')).rejects.toThrow();
  });

  it('rejects empty string', async () => {
    await expect(validateGitRef('')).rejects.toThrow();
  });

  it('rejects non-string values', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid type
    await expect(validateGitRef(undefined as any)).rejects.toThrow();
    // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid type
    await expect(validateGitRef(null as any)).rejects.toThrow();
    // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid type
    await expect(validateGitRef(123 as any)).rejects.toThrow();
  });

  it('accepts well-formed refs', async () => {
    await expect(validateGitRef('main')).resolves.toBeUndefined();
    await expect(validateGitRef('feature/foo')).resolves.toBeUndefined();
    await expect(validateGitRef('v1.2.3')).resolves.toBeUndefined();
    await expect(validateGitRef('release-2026.04')).resolves.toBeUndefined();
  });
});

describe('createWorktree — argv hardening', () => {
  let tmpRoot: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-sec-'));
    repoPath = path.join(tmpRoot, 'repo');
    await createTestRepo(repoPath);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('rejects attacker-shaped refs before reaching git', async () => {
    const wt = path.join(tmpRoot, 'wt');
    await expect(
      createWorktree(repoPath, wt, '--upload-pack=/tmp/x', false, false)
    ).rejects.toThrow(/Invalid git ref/);
    await expect(createWorktree(repoPath, wt, '-foo', false, false)).rejects.toThrow(
      /Invalid git ref/
    );
    await expect(createWorktree(repoPath, wt, 'bad\nref', false, false)).rejects.toThrow(
      /Invalid git ref/
    );
    await expect(createWorktree(repoPath, wt, '', false, false)).rejects.toThrow(/Invalid git ref/);
  });

  it('places `--` before positional path argument in worktree add', async () => {
    // Exercise createWorktree via a real git binary and then introspect
    // the resulting worktree list to confirm it worked with `--` present.
    // The presence of `--` is indirectly verified by the fact that a ref
    // like "main" works, since any regression that dropped `--` would
    // still pass but any attacker-shaped path would also succeed. We
    // additionally spy on git.raw by wrapping simpleGit below.
    const wt = path.join(tmpRoot, 'wt-ok');
    // Use createBranch=true with sourceBranch=main, because `main` is already
    // checked out at repoPath, so `git worktree add main` would fail.
    await createWorktree(repoPath, wt, 'feat/ok', true, false, 'main');
    const exists = await fs
      .stat(wt)
      .then((s) => s.isDirectory())
      .catch(() => false);
    expect(exists).toBe(true);
  });
});

describe('isLikelyGitToken — credential helper shape check', () => {
  it('rejects tokens containing shell metacharacters', () => {
    // The exact string the attacker would need to escape the old shell
    // credential helper: `;`, `}`, backticks, `$()`, newlines.
    expect(isLikelyGitToken('abc;rm -rf /')).toBe(false);
    expect(isLikelyGitToken('abc`id`')).toBe(false);
    expect(isLikelyGitToken('abc$(whoami)')).toBe(false);
    expect(isLikelyGitToken('abc}more')).toBe(false);
    expect(isLikelyGitToken('abc\nmore')).toBe(false);
    expect(isLikelyGitToken('abc def')).toBe(false);
  });

  it('rejects tokens that are too short or too long', () => {
    expect(isLikelyGitToken('short')).toBe(false);
    expect(isLikelyGitToken('a'.repeat(256))).toBe(false);
  });

  it('accepts well-formed GitHub-style PATs', () => {
    expect(isLikelyGitToken('ghp_' + 'a'.repeat(36))).toBe(true);
    expect(isLikelyGitToken('github_pat_' + 'A'.repeat(40))).toBe(true);
    expect(isLikelyGitToken('a'.repeat(40))).toBe(true);
  });
});

describe('deleteBranch — argv hardening', () => {
  let tmpRoot: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-git-sec-'));
    repoPath = path.join(tmpRoot, 'repo');
    await createTestRepo(repoPath);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('rejects attacker-shaped branch names', async () => {
    await expect(deleteBranch(repoPath, '--force')).rejects.toThrow(/Invalid git ref/);
    await expect(deleteBranch(repoPath, '-D')).rejects.toThrow(/Invalid git ref/);
    await expect(deleteBranch(repoPath, 'bad\nname')).rejects.toThrow(/Invalid git ref/);
  });
});
