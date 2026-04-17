/**
 * Defence-in-depth validation tests for executor unix commands.
 *
 * Covers:
 *  - fixWorktreeGitDirPermissionsBasic rejects worktree names with
 *    shell metacharacters / path traversal / leading dash / over-length.
 *    It must not touch the filesystem in that case, so we do not need a
 *    real sudo environment.
 */

import { assertChpasswdInputSafe } from '@agor/core/unix';
import { describe, expect, it } from 'vitest';
import { fixWorktreeGitDirPermissionsBasic } from './unix';

describe('fixWorktreeGitDirPermissionsBasic — worktree name validation', () => {
  const repoPath = '/tmp/repo-that-does-not-exist-for-this-test';

  it('rejects names with command-injection metacharacters', async () => {
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, 'foo;rm -rf /')).rejects.toThrow(
      /Invalid worktree name/
    );
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, '$(id)')).rejects.toThrow(
      /Invalid worktree name/
    );
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, '`id`')).rejects.toThrow(
      /Invalid worktree name/
    );
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, 'foo"bar')).rejects.toThrow(
      /Invalid worktree name/
    );
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, "foo'bar")).rejects.toThrow(
      /Invalid worktree name/
    );
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, 'foo\\nbar')).rejects.toThrow(
      /Invalid worktree name/
    );
    // Literal newline, CR, NUL must also be rejected (not just the backslash-n
    // escape above — that already fails the alnum check).
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, 'foo\nbar')).rejects.toThrow(
      /Invalid worktree name/
    );
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, 'foo\rbar')).rejects.toThrow(
      /Invalid worktree name/
    );
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, 'foo\u0000bar')).rejects.toThrow(
      /Invalid worktree name/
    );
  });

  it('rejects names with leading dash (option injection)', async () => {
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, '-rf')).rejects.toThrow(
      /Invalid worktree name/
    );
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, '--help')).rejects.toThrow(
      /Invalid worktree name/
    );
  });

  it('rejects path traversal', async () => {
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, '../etc')).rejects.toThrow(
      /Invalid worktree name/
    );
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, 'foo/bar')).rejects.toThrow(
      /Invalid worktree name/
    );
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, './foo')).rejects.toThrow(
      /Invalid worktree name/
    );
  });

  it('rejects names that exceed length budget', async () => {
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, 'a'.repeat(65))).rejects.toThrow(
      /Invalid worktree name/
    );
  });

  it('rejects empty name', async () => {
    await expect(fixWorktreeGitDirPermissionsBasic(repoPath, '')).rejects.toThrow(
      /Invalid worktree name/
    );
  });
});

describe('assertChpasswdInputSafe — stdin-injection guard', () => {
  it('rejects a username containing ":" (chpasswd field separator)', () => {
    expect(() => assertChpasswdInputSafe('alice:evil', 'pw')).toThrow(/chpasswd field separator/);
    expect(() => assertChpasswdInputSafe('root:', 'pw')).toThrow(/chpasswd field separator/);
  });

  it('rejects a password containing a newline (line-injection)', () => {
    expect(() => assertChpasswdInputSafe('alice', 'pw\nroot:evil')).toThrow(/newline or NUL byte/);
    expect(() => assertChpasswdInputSafe('alice', 'pw\r\nroot:evil')).toThrow(
      /newline or NUL byte/
    );
  });

  it('rejects a password containing a NUL byte', () => {
    expect(() => assertChpasswdInputSafe('alice', 'pw\u0000more')).toThrow(/newline or NUL byte/);
  });

  it('rejects an empty username', () => {
    expect(() => assertChpasswdInputSafe('', 'pw')).toThrow(/unix_username is empty/);
  });

  it('rejects an empty password', () => {
    expect(() => assertChpasswdInputSafe('alice', '')).toThrow(/password is empty/);
  });

  it('rejects non-string inputs', () => {
    expect(() => assertChpasswdInputSafe(undefined as unknown as string, 'pw')).toThrow();
    expect(() => assertChpasswdInputSafe('alice', null as unknown as string)).toThrow();
  });

  it('accepts well-formed inputs', () => {
    expect(() => assertChpasswdInputSafe('alice', 'correct horse battery staple')).not.toThrow();
    expect(() => assertChpasswdInputSafe('agor_u123', 'x')).not.toThrow();
  });
});
