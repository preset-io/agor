/**
 * Regression test for #1140 — `repo clone fails when user is not sudoer` —
 * and its sister bug #1143 — same failure mode in `git.branch.remove`.
 *
 * In simple Unix mode no supplemental Unix groups are created, even when
 * app-level `branch_rbac` is enabled, so wrapping git operations in
 * `sudo -u` is pure overhead. Worse: it breaks for users who never configured
 * passwordless sudoers, with the daemon failing to clone repos (or remove
 * branches) against `user not in sudoers`.
 *
 * The gate must live INSIDE the resolver — not at the call site — so every
 * caller is covered uniformly. #1141 fixed clone + branch.add + (later)
 * branch.remove by sprinkling `rbacEnabled ? ... : undefined` at each
 * caller; #1143 hoists the gate into `resolveGitImpersonationFor*` so the
 * next caller added can't repeat the mistake.
 */

import type { Database } from '@agor/core/db';
import type { Branch, BranchID, UserID } from '@agor/core/types';
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

import {
  resolveGitImpersonationForBranch,
  resolveGitImpersonationForUser,
} from './git-impersonation';

const fakeDb = {} as Database;
const fakeUserId = 'user-123' as UserID;
const fakeBranch = {
  branch_id: 'wt-1' as BranchID,
  created_by: fakeUserId,
} as Branch;

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

  it('returns daemon user when group refresh is needed (insulated/strict)', async () => {
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

  // The resolver is the SOLE gate — callers (including service-account paths
  // that don't carry a userId) should be able to invoke it unconditionally.
  // This pins that contract so a future caller that drops the inline
  // `userId ?` check (as repos.ts did in #1143) doesn't regress.
  it('accepts an undefined userId and still applies the group-refresh gate', async () => {
    mockIsUnixGroupRefreshNeeded.mockReturnValue(false);
    const noUser = await resolveGitImpersonationForUser(fakeDb, undefined);
    expect(noUser).toBeUndefined();

    mockIsUnixGroupRefreshNeeded.mockReturnValue(true);
    const refreshNeeded = await resolveGitImpersonationForUser(fakeDb, undefined);
    expect(refreshNeeded).toBe('agorpg');
  });
});

describe('resolveGitImpersonationForBranch', () => {
  // The branch-remove path (BranchesService.remove → git.branch.remove
  // executor spawn) calls this resolver. Pre-#1143 the call site had its
  // own `isBranchRbacEnabled() ? ... : undefined` gate; this test pins
  // the contract that the resolver itself returns undefined in simple mode
  // so the caller no longer needs to duplicate the check.
  it('returns undefined in open-access default — #1140 (clone) + #1143 (branch.remove)', async () => {
    mockIsUnixGroupRefreshNeeded.mockReturnValue(false);
    const result = await resolveGitImpersonationForBranch(fakeDb, fakeBranch);
    expect(result).toBeUndefined();
  });

  it('delegates to resolveGitImpersonationForUser using branch.created_by', async () => {
    mockIsUnixGroupRefreshNeeded.mockReturnValue(true);
    const result = await resolveGitImpersonationForBranch(fakeDb, fakeBranch);
    expect(result).toBe('agorpg');
  });
});
