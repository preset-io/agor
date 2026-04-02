/**
 * Worktree Authorization Tests
 *
 * Tests for superadmin role, allow_superadmin config flag, and worktree RBAC behavior.
 * Covers the security invariants introduced by the superadmin role feature.
 */

import type { Worktree, WorktreePermissionLevel } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  hasWorktreePermission,
  isSuperAdmin,
  resolveWorktreePermission,
} from './worktree-authorization';

/** Minimal worktree fixture for permission tests */
function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktree_id: 'wt-test-0001' as Worktree['worktree_id'],
    repo_id: 'repo-test-0001' as Worktree['repo_id'],
    name: 'test-worktree',
    branch: 'test-branch',
    path: '/tmp/test',
    others_can: 'view',
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Worktree;
}

const USER_ID = 'user-test-0001' as import('@agor/core/types').UUID;

describe('isSuperAdmin', () => {
  it('returns true for superadmin role', () => {
    expect(isSuperAdmin(ROLES.SUPERADMIN)).toBe(true);
  });

  it('returns true for deprecated owner role (backwards compat)', () => {
    expect(isSuperAdmin('owner')).toBe(true);
  });

  it('returns false for admin role', () => {
    expect(isSuperAdmin(ROLES.ADMIN)).toBe(false);
  });

  it('returns false for member role', () => {
    expect(isSuperAdmin(ROLES.MEMBER)).toBe(false);
  });

  it('returns false for undefined role', () => {
    expect(isSuperAdmin(undefined)).toBe(false);
  });

  describe('when allow_superadmin=false', () => {
    it('returns false even for superadmin role', () => {
      expect(isSuperAdmin(ROLES.SUPERADMIN, false)).toBe(false);
    });

    it('returns false even for owner role', () => {
      expect(isSuperAdmin('owner', false)).toBe(false);
    });
  });
});

describe('hasWorktreePermission', () => {
  describe('owner behavior', () => {
    it('owner always has all permission regardless of others_can', () => {
      const wt = makeWorktree({ others_can: 'none' });
      expect(hasWorktreePermission(wt, USER_ID, true, 'all')).toBe(true);
      expect(hasWorktreePermission(wt, USER_ID, true, 'prompt')).toBe(true);
      expect(hasWorktreePermission(wt, USER_ID, true, 'view')).toBe(true);
    });
  });

  describe('superadmin behavior', () => {
    it('superadmin can view worktrees with others_can=none', () => {
      const wt = makeWorktree({ others_can: 'none' });
      expect(hasWorktreePermission(wt, USER_ID, false, 'view', ROLES.SUPERADMIN)).toBe(true);
    });

    it('superadmin CANNOT prompt worktrees with others_can=none (must own first)', () => {
      const wt = makeWorktree({ others_can: 'none' });
      expect(hasWorktreePermission(wt, USER_ID, false, 'prompt', ROLES.SUPERADMIN)).toBe(false);
    });

    it('superadmin CANNOT get all permission on worktrees with others_can=none', () => {
      const wt = makeWorktree({ others_can: 'none' });
      expect(hasWorktreePermission(wt, USER_ID, false, 'all', ROLES.SUPERADMIN)).toBe(false);
    });

    it('superadmin can prompt worktrees with others_can=prompt', () => {
      const wt = makeWorktree({ others_can: 'prompt' });
      expect(hasWorktreePermission(wt, USER_ID, false, 'prompt', ROLES.SUPERADMIN)).toBe(true);
    });

    it('deprecated owner role gets same superadmin bypass', () => {
      const wt = makeWorktree({ others_can: 'none' });
      expect(hasWorktreePermission(wt, USER_ID, false, 'view', 'owner')).toBe(true);
      expect(hasWorktreePermission(wt, USER_ID, false, 'prompt', 'owner')).toBe(false);
    });
  });

  describe('allow_superadmin=false disables bypass', () => {
    it('superadmin denied view on others_can=none when flag disabled', () => {
      const wt = makeWorktree({ others_can: 'none' });
      expect(hasWorktreePermission(wt, USER_ID, false, 'view', ROLES.SUPERADMIN, false)).toBe(
        false
      );
    });

    it('superadmin treated as regular user when flag disabled', () => {
      const wt = makeWorktree({ others_can: 'view' });
      // Can view because others_can=view (not because of superadmin)
      expect(hasWorktreePermission(wt, USER_ID, false, 'view', ROLES.SUPERADMIN, false)).toBe(true);
      // Cannot prompt because others_can=view only
      expect(hasWorktreePermission(wt, USER_ID, false, 'prompt', ROLES.SUPERADMIN, false)).toBe(
        false
      );
    });
  });

  describe('non-owner permission levels', () => {
    it.each<[WorktreePermissionLevel, WorktreePermissionLevel, boolean]>([
      ['all', 'all', true],
      ['all', 'prompt', true],
      ['all', 'view', true],
      ['prompt', 'prompt', true],
      ['prompt', 'view', true],
      ['prompt', 'all', false],
      ['view', 'view', true],
      ['view', 'prompt', false],
      ['view', 'all', false],
      ['none', 'view', false],
      ['none', 'prompt', false],
      ['none', 'all', false],
    ])('others_can=%s, required=%s → %s', (othersCan, required, expected) => {
      const wt = makeWorktree({ others_can: othersCan });
      expect(hasWorktreePermission(wt, USER_ID, false, required, ROLES.MEMBER)).toBe(expected);
    });
  });
});

describe('resolveWorktreePermission', () => {
  it('owner resolves to all', () => {
    const wt = makeWorktree({ others_can: 'none' });
    expect(resolveWorktreePermission(wt, USER_ID, true)).toBe('all');
  });

  it('superadmin resolves to at least view on others_can=none', () => {
    const wt = makeWorktree({ others_can: 'none' });
    expect(resolveWorktreePermission(wt, USER_ID, false, ROLES.SUPERADMIN)).toBe('view');
  });

  it('superadmin inherits higher permission from others_can', () => {
    const wt = makeWorktree({ others_can: 'prompt' });
    expect(resolveWorktreePermission(wt, USER_ID, false, ROLES.SUPERADMIN)).toBe('prompt');
  });

  it('member gets others_can level', () => {
    const wt = makeWorktree({ others_can: 'prompt' });
    expect(resolveWorktreePermission(wt, USER_ID, false, ROLES.MEMBER)).toBe('prompt');
  });

  it('member gets none when others_can=none', () => {
    const wt = makeWorktree({ others_can: 'none' });
    expect(resolveWorktreePermission(wt, USER_ID, false, ROLES.MEMBER)).toBe('none');
  });
});
