/**
 * Branch Authorization Tests
 *
 * Tests for superadmin role, allow_superadmin config flag, and branch RBAC behavior.
 * Covers the security invariants introduced by the superadmin role feature.
 */

import type { Branch, BranchPermissionLevel, HookContext, Session } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  ensureCanPromptInSession,
  hasBranchPermission,
  isSuperAdmin,
  resolveBranchPermission,
} from './branch-authorization';

/** Minimal branch fixture for permission tests */
function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: 'wt-test-0001' as Branch['branch_id'],
    repo_id: 'repo-test-0001' as Branch['repo_id'],
    name: 'test-branch',
    branch: 'test-branch',
    path: '/tmp/test',
    others_can: 'view',
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Branch;
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

describe('hasBranchPermission', () => {
  describe('owner behavior', () => {
    it('owner always has all permission regardless of others_can', () => {
      const wt = makeBranch({ others_can: 'none' });
      expect(hasBranchPermission(wt, USER_ID, true, 'all')).toBe(true);
      expect(hasBranchPermission(wt, USER_ID, true, 'prompt')).toBe(true);
      expect(hasBranchPermission(wt, USER_ID, true, 'view')).toBe(true);
    });
  });

  describe('superadmin behavior', () => {
    it('superadmin has full access to branches with others_can=none', () => {
      const wt = makeBranch({ others_can: 'none' });
      expect(hasBranchPermission(wt, USER_ID, false, 'all', ROLES.SUPERADMIN)).toBe(true);
      expect(hasBranchPermission(wt, USER_ID, false, 'prompt', ROLES.SUPERADMIN)).toBe(true);
      expect(hasBranchPermission(wt, USER_ID, false, 'view', ROLES.SUPERADMIN)).toBe(true);
    });

    it('superadmin has full access regardless of others_can level', () => {
      for (const othersCan of ['none', 'view', 'session', 'prompt', 'all'] as const) {
        const wt = makeBranch({ others_can: othersCan });
        expect(hasBranchPermission(wt, USER_ID, false, 'all', ROLES.SUPERADMIN)).toBe(true);
      }
    });

    it('deprecated owner role gets same superadmin full access', () => {
      const wt = makeBranch({ others_can: 'none' });
      expect(hasBranchPermission(wt, USER_ID, false, 'all', 'owner')).toBe(true);
      expect(hasBranchPermission(wt, USER_ID, false, 'prompt', 'owner')).toBe(true);
      expect(hasBranchPermission(wt, USER_ID, false, 'view', 'owner')).toBe(true);
    });
  });

  describe('allow_superadmin=false disables bypass', () => {
    it('superadmin denied view on others_can=none when flag disabled', () => {
      const wt = makeBranch({ others_can: 'none' });
      expect(hasBranchPermission(wt, USER_ID, false, 'view', ROLES.SUPERADMIN, false)).toBe(false);
    });

    it('superadmin treated as regular user when flag disabled', () => {
      const wt = makeBranch({ others_can: 'view' });
      // Can view because others_can=view (not because of superadmin)
      expect(hasBranchPermission(wt, USER_ID, false, 'view', ROLES.SUPERADMIN, false)).toBe(true);
      // Cannot prompt because others_can=view only
      expect(hasBranchPermission(wt, USER_ID, false, 'prompt', ROLES.SUPERADMIN, false)).toBe(
        false
      );
    });
  });

  describe('non-owner permission levels', () => {
    it.each<[BranchPermissionLevel, BranchPermissionLevel, boolean]>([
      ['all', 'all', true],
      ['all', 'prompt', true],
      ['all', 'session', true],
      ['all', 'view', true],
      ['prompt', 'prompt', true],
      ['prompt', 'session', true],
      ['prompt', 'view', true],
      ['prompt', 'all', false],
      ['session', 'session', true],
      ['session', 'view', true],
      ['session', 'prompt', false],
      ['session', 'all', false],
      ['view', 'view', true],
      ['view', 'session', false],
      ['view', 'prompt', false],
      ['view', 'all', false],
      ['none', 'view', false],
      ['none', 'session', false],
      ['none', 'prompt', false],
      ['none', 'all', false],
    ])('others_can=%s, required=%s → %s', (othersCan, required, expected) => {
      const wt = makeBranch({ others_can: othersCan });
      expect(hasBranchPermission(wt, USER_ID, false, required, ROLES.MEMBER)).toBe(expected);
    });
  });
});

describe('resolveBranchPermission', () => {
  it('owner resolves to all', () => {
    const wt = makeBranch({ others_can: 'none' });
    expect(resolveBranchPermission(wt, USER_ID, true)).toBe('all');
  });

  it('superadmin resolves to all on others_can=none', () => {
    const wt = makeBranch({ others_can: 'none' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.SUPERADMIN)).toBe('all');
  });

  it('superadmin resolves to all regardless of others_can', () => {
    const wt = makeBranch({ others_can: 'prompt' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.SUPERADMIN)).toBe('all');
  });

  it('member gets others_can level', () => {
    const wt = makeBranch({ others_can: 'prompt' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.MEMBER)).toBe('prompt');
  });

  it('member gets none when others_can=none', () => {
    const wt = makeBranch({ others_can: 'none' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.MEMBER)).toBe('none');
  });

  it('member gets session when others_can=session', () => {
    const wt = makeBranch({ others_can: 'session' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.MEMBER)).toBe('session');
  });

  it('superadmin resolves to all even with others_can=session', () => {
    const wt = makeBranch({ others_can: 'session' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.SUPERADMIN)).toBe('all');
  });
});

const OTHER_USER_ID = 'user-other-0002' as import('@agor/core/types').UUID;

/** Minimal HookContext mock for ensureCanPromptInSession tests */
function makeHookContext(overrides: {
  branch: Branch;
  session: Partial<Session>;
  userId: string;
  isOwner?: boolean;
  userRole?: string;
}): HookContext {
  return {
    params: {
      provider: 'rest',
      user: {
        user_id: overrides.userId,
        role: overrides.userRole ?? ROLES.MEMBER,
      },
      branch: overrides.branch,
      session: overrides.session,
      isBranchOwner: overrides.isOwner ?? false,
    },
  } as unknown as HookContext;
}

describe('ensureCanPromptInSession', () => {
  const hook = ensureCanPromptInSession();

  describe('session tier — own sessions', () => {
    it('allows prompting own session with session permission', () => {
      const wt = makeBranch({ others_can: 'session' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: USER_ID },
        userId: USER_ID,
      });
      expect(() => hook(ctx)).not.toThrow();
    });

    it('denies prompting another users session with session permission', () => {
      const wt = makeBranch({ others_can: 'session' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: OTHER_USER_ID },
        userId: USER_ID,
      });
      expect(() => hook(ctx)).toThrow(/you can only prompt sessions you created/i);
    });
  });

  describe('prompt tier — any session', () => {
    it('allows prompting another users session with prompt permission', () => {
      const wt = makeBranch({ others_can: 'prompt' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: OTHER_USER_ID },
        userId: USER_ID,
      });
      expect(() => hook(ctx)).not.toThrow();
    });
  });

  describe('view tier — denied', () => {
    it('denies prompting own session with view permission', () => {
      const wt = makeBranch({ others_can: 'view' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: USER_ID },
        userId: USER_ID,
      });
      expect(() => hook(ctx)).toThrow(/need 'prompt' permission/i);
    });
  });

  describe('owner bypass', () => {
    it('owner can prompt any session regardless of others_can', () => {
      const wt = makeBranch({ others_can: 'none' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: OTHER_USER_ID },
        userId: USER_ID,
        isOwner: true,
      });
      expect(() => hook(ctx)).not.toThrow();
    });
  });

  describe('internal calls bypass', () => {
    it('skips check for internal calls (no provider)', () => {
      const wt = makeBranch({ others_can: 'none' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: OTHER_USER_ID },
        userId: USER_ID,
      });
      // Remove provider to simulate internal call
      ctx.params.provider = undefined;
      expect(() => hook(ctx)).not.toThrow();
    });
  });
});
