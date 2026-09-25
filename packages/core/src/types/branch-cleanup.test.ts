import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPO_CLEANUP_POLICY,
  getBranchCleanupBlockReason,
  resolveRepoCleanupPolicy,
  validateRepoCleanupPolicy,
} from './branch-cleanup';

describe('repository cleanup policy', () => {
  it('fails closed for missing policy and uses uppercase X only after opt-in', () => {
    expect(resolveRepoCleanupPolicy()).toEqual({
      enabled: false,
      command: 'git clean -fdX',
      allow_branch_protection: true,
    });
    expect(getBranchCleanupBlockReason(undefined, false)).toBe(
      'Cleanup is disabled for this repository.'
    );
    expect(
      getBranchCleanupBlockReason({ ...DEFAULT_REPO_CLEANUP_POLICY, enabled: true }, false)
    ).toBeUndefined();
  });

  it('overrides effective protection without mutating the saved preference', () => {
    const policy = { ...DEFAULT_REPO_CLEANUP_POLICY, enabled: true };
    expect(getBranchCleanupBlockReason(policy, true)).toContain('protected');
    expect(
      getBranchCleanupBlockReason({ ...policy, allow_branch_protection: false }, true)
    ).toBeUndefined();
    expect(getBranchCleanupBlockReason(policy, true)).toContain('protected');
    expect(
      getBranchCleanupBlockReason(
        { ...policy, enabled: false, allow_branch_protection: false },
        true
      )
    ).toContain('disabled');
  });

  it('accepts disabled drafts and arbitrary bounded commands, without expanding templates', () => {
    expect(validateRepoCleanupPolicy({ ...DEFAULT_REPO_CLEANUP_POLICY, command: '' }).command).toBe(
      ''
    );
    const command = './scripts/cleanup.sh && echo "{{branch.path}}"';
    expect(
      validateRepoCleanupPolicy({ ...DEFAULT_REPO_CLEANUP_POLICY, enabled: true, command }).command
    ).toBe(command);
  });

  it.each([
    null,
    [],
    { enabled: true },
    { ...DEFAULT_REPO_CLEANUP_POLICY, enabled: 'true' },
    { ...DEFAULT_REPO_CLEANUP_POLICY, enabled: true, command: '  ' },
    { ...DEFAULT_REPO_CLEANUP_POLICY, command: 'x'.repeat(4097) },
    { ...DEFAULT_REPO_CLEANUP_POLICY, command: 'echo\0unsafe' },
    { ...DEFAULT_REPO_CLEANUP_POLICY, force: true },
    { ...DEFAULT_REPO_CLEANUP_POLICY, cwd: '/other-tenant' },
  ])('rejects malformed configuration and public overrides: %j', (value) => {
    expect(() => validateRepoCleanupPolicy(value)).toThrow();
  });
});
