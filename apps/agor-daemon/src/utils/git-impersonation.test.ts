/**
 * Regression test for #1140 — `repo clone fails when user is not sudoer`.
 *
 * In the open-access default (`worktree_rbac: false`, `unix_user_mode:
 * simple`) no supplemental Unix groups are ever created, so wrapping git
 * operations in `sudo -u` is pure overhead. Worse: it breaks for users
 * who never configured passwordless sudoers, with the daemon failing to
 * clone repos against `user not in sudoers`.
 *
 * The resolver must return `undefined` in that case so callers spawn the
 * git process directly. Sudo wrapping kicks in only when groups exist
 * (RBAC enabled or non-simple unix_user_mode).
 */

import type { Database } from '@agor/core/db';
import type { UserID, Worktree, WorktreeID } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsUnixGroupRefreshNeeded = vi.fn(() => false);
const mockGetDaemonUser = vi.fn<() => string | undefined>(() => 'agorpg');

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/config');
  return {
    ...actual,
    isUnixGroupRefreshNeeded: () => mockIsUnixGroupRefreshNeeded(),
    getDaemonUser: () => mockGetDaemonUser(),
  };
});

// validateResolvedUnixUser is a no-op for `simple` mode (the resolver always
// passes that), but stub it anyway so the test never depends on real Unix
// user lookups via getent/id, even if the production call switches modes.
vi.mock('@agor/core/unix', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/unix');
  return {
    ...actual,
    validateResolvedUnixUser: vi.fn(),
  };
});

import {
  resolveGitImpersonationForUser,
  resolveGitImpersonationForWorktree,
} from './git-impersonation';

const fakeDb = {} as Database;
const fakeUserId = 'user-123' as UserID;
const fakeWorktree = {
  worktree_id: 'wt-1' as WorktreeID,
  created_by: fakeUserId,
} as Worktree;

beforeEach(() => {
  mockIsUnixGroupRefreshNeeded.mockReset();
  mockGetDaemonUser.mockReset();
  mockGetDaemonUser.mockReturnValue('agorpg');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveGitImpersonationForUser', () => {
  it('returns undefined in open-access default (no RBAC, simple mode) — #1140', async () => {
    mockIsUnixGroupRefreshNeeded.mockReturnValue(false);
    const result = await resolveGitImpersonationForUser(fakeDb, fakeUserId);
    expect(result).toBeUndefined();
  });

  it('returns daemon user when group refresh is needed (RBAC or insulated/strict)', async () => {
    mockIsUnixGroupRefreshNeeded.mockReturnValue(true);
    const result = await resolveGitImpersonationForUser(fakeDb, fakeUserId);
    expect(result).toBe('agorpg');
  });

  it('returns undefined when group refresh is needed but daemon user not configured', async () => {
    mockIsUnixGroupRefreshNeeded.mockReturnValue(true);
    mockGetDaemonUser.mockReturnValue(undefined);
    const result = await resolveGitImpersonationForUser(fakeDb, fakeUserId);
    expect(result).toBeUndefined();
  });
});

describe('resolveGitImpersonationForWorktree', () => {
  it('returns undefined in open-access default (no RBAC, simple mode) — #1140', async () => {
    mockIsUnixGroupRefreshNeeded.mockReturnValue(false);
    const result = await resolveGitImpersonationForWorktree(fakeDb, fakeWorktree);
    expect(result).toBeUndefined();
  });

  it('delegates to resolveGitImpersonationForUser using worktree.created_by', async () => {
    mockIsUnixGroupRefreshNeeded.mockReturnValue(true);
    const result = await resolveGitImpersonationForWorktree(fakeDb, fakeWorktree);
    expect(result).toBe('agorpg');
  });
});
