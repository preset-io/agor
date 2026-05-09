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
import {
  buildWorktreeAddArgs,
  createWorktree,
  deleteBranch,
  isLikelyGitToken,
  validateGitRef,
} from './index';

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
    // validateGitRef accepts `unknown`, so no cast needed.
    await expect(validateGitRef(undefined)).rejects.toThrow();
    await expect(validateGitRef(null)).rejects.toThrow();
    await expect(validateGitRef(123)).rejects.toThrow();
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
    // End-to-end sanity: createWorktree actually succeeds against a real git.
    // Use createBranch=true with sourceBranch=main, because `main` is already
    // checked out at repoPath, so `git worktree add main` would fail.
    const wt = path.join(tmpRoot, 'wt-ok');
    await createWorktree(repoPath, wt, 'feat/ok', true, false, 'main');
    const exists = await fs
      .stat(wt)
      .then((s) => s.isDirectory())
      .catch(() => false);
    expect(exists).toBe(true);
  });
});

describe('buildWorktreeAddArgs — argv shape', () => {
  it('always inserts `--` before positional arguments', () => {
    // createBranch=false, no sourceBranch
    const basic = buildWorktreeAddArgs({
      worktreePath: '/tmp/wt',
      ref: 'main',
      createBranch: false,
      fetchSucceeded: false,
    });
    const dashIdx = basic.indexOf('--');
    expect(dashIdx).toBeGreaterThanOrEqual(0);
    // Every positional (worktreePath, ref) must come after `--`.
    expect(basic.indexOf('/tmp/wt')).toBeGreaterThan(dashIdx);
    expect(basic.indexOf('main')).toBeGreaterThan(dashIdx);
  });

  it('keeps `-b <ref>` before `--` and positional path after it', () => {
    // createBranch=true — `-b` is an option flag, must be BEFORE `--`.
    const withBranch = buildWorktreeAddArgs({
      worktreePath: '/tmp/wt',
      ref: 'feat/new',
      createBranch: true,
      sourceBranch: 'main',
      fetchSucceeded: true,
    });
    const dashIdx = withBranch.indexOf('--');
    expect(dashIdx).toBeGreaterThanOrEqual(0);
    // `-b` is an option, must be before `--`.
    expect(withBranch.indexOf('-b')).toBeLessThan(dashIdx);
    // Branch name follows `-b` and is also before `--`.
    expect(withBranch.indexOf('feat/new')).toBeLessThan(dashIdx);
    // worktreePath and the source ref are positionals, must be after `--`.
    expect(withBranch.indexOf('/tmp/wt')).toBeGreaterThan(dashIdx);
    expect(withBranch.indexOf('origin/main')).toBeGreaterThan(dashIdx);
  });

  it('uses local ref (no origin/ prefix) when fetch failed', () => {
    const args = buildWorktreeAddArgs({
      worktreePath: '/tmp/wt',
      ref: 'feat/new',
      createBranch: true,
      sourceBranch: 'main',
      fetchSucceeded: false,
    });
    expect(args).toContain('main');
    expect(args).not.toContain('origin/main');
  });

  it('uses tag name verbatim when refType is tag', () => {
    const args = buildWorktreeAddArgs({
      worktreePath: '/tmp/wt',
      ref: 'feat/from-tag',
      createBranch: true,
      sourceBranch: 'v1.2.3',
      refType: 'tag',
      fetchSucceeded: true,
    });
    expect(args).toContain('v1.2.3');
    expect(args).not.toContain('origin/v1.2.3');
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
    expect(isLikelyGitToken(`ghp_${'a'.repeat(36)}`)).toBe(true);
    expect(isLikelyGitToken(`github_pat_${'A'.repeat(40)}`)).toBe(true);
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
