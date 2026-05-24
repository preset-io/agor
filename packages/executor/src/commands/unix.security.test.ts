/**
 * Defence-in-depth validation tests for executor unix commands.
 *
 * Covers:
 *  - fixBranchGitDirPermissionsBasic rejects branch names with
 *    shell metacharacters / path traversal / leading dash / over-length.
 *    It must not touch the filesystem in that case, so we do not need a
 *    real sudo environment.
 */

import { assertChpasswdInputSafe } from '@agor/core/unix';
import { describe, expect, it } from 'vitest';
import { fixBranchGitDirPermissionsBasic } from './unix';

describe('fixBranchGitDirPermissionsBasic — branch name validation', () => {
  const repoPath = '/tmp/repo-that-does-not-exist-for-this-test';

  it('rejects names with command-injection metacharacters', async () => {
    await expect(fixBranchGitDirPermissionsBasic(repoPath, 'foo;rm -rf /')).rejects.toThrow(
      /Invalid branch name/
    );
    await expect(fixBranchGitDirPermissionsBasic(repoPath, '$(id)')).rejects.toThrow(
      /Invalid branch name/
    );
    await expect(fixBranchGitDirPermissionsBasic(repoPath, '`id`')).rejects.toThrow(
      /Invalid branch name/
    );
    await expect(fixBranchGitDirPermissionsBasic(repoPath, 'foo"bar')).rejects.toThrow(
      /Invalid branch name/
    );
    await expect(fixBranchGitDirPermissionsBasic(repoPath, "foo'bar")).rejects.toThrow(
      /Invalid branch name/
    );
    await expect(fixBranchGitDirPermissionsBasic(repoPath, 'foo\\nbar')).rejects.toThrow(
      /Invalid branch name/
    );
    // Literal newline, CR, NUL must also be rejected (not just the backslash-n
    // escape above — that already fails the alnum check).
    await expect(fixBranchGitDirPermissionsBasic(repoPath, 'foo\nbar')).rejects.toThrow(
      /Invalid branch name/
    );
    await expect(fixBranchGitDirPermissionsBasic(repoPath, 'foo\rbar')).rejects.toThrow(
      /Invalid branch name/
    );
    await expect(fixBranchGitDirPermissionsBasic(repoPath, 'foo\u0000bar')).rejects.toThrow(
      /Invalid branch name/
    );
  });

  it('rejects names with leading dash (option injection)', async () => {
    await expect(fixBranchGitDirPermissionsBasic(repoPath, '-rf')).rejects.toThrow(
      /Invalid branch name/
    );
    await expect(fixBranchGitDirPermissionsBasic(repoPath, '--help')).rejects.toThrow(
      /Invalid branch name/
    );
  });

  it('rejects path traversal', async () => {
    await expect(fixBranchGitDirPermissionsBasic(repoPath, '../etc')).rejects.toThrow(
      /Invalid branch name/
    );
    await expect(fixBranchGitDirPermissionsBasic(repoPath, 'foo/bar')).rejects.toThrow(
      /Invalid branch name/
    );
    await expect(fixBranchGitDirPermissionsBasic(repoPath, './foo')).rejects.toThrow(
      /Invalid branch name/
    );
  });

  it('rejects names that exceed length budget', async () => {
    await expect(fixBranchGitDirPermissionsBasic(repoPath, 'a'.repeat(65))).rejects.toThrow(
      /Invalid branch name/
    );
  });

  it('rejects empty name', async () => {
    await expect(fixBranchGitDirPermissionsBasic(repoPath, '')).rejects.toThrow(
      /Invalid branch name/
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
