/**
 * User type utilities tests
 *
 * Tests normalizeRole backwards compatibility for deprecated 'owner' → 'superadmin'.
 */

import { describe, expect, it } from 'vitest';
import {
  canAssignUserRole,
  compareRoleAuthority,
  hasMinimumRole,
  hasRoleAuthorityOver,
  normalizeRole,
  ROLES,
} from './user';

describe('normalizeRole', () => {
  it('converts owner to superadmin', () => {
    expect(normalizeRole('owner')).toBe('superadmin');
  });

  it('passes through superadmin unchanged', () => {
    expect(normalizeRole('superadmin')).toBe('superadmin');
  });

  it('passes through admin unchanged', () => {
    expect(normalizeRole('admin')).toBe('admin');
  });

  it('passes through member unchanged', () => {
    expect(normalizeRole('member')).toBe('member');
  });

  it('passes through viewer unchanged', () => {
    expect(normalizeRole('viewer')).toBe('viewer');
  });

  it('defaults undefined to member', () => {
    expect(normalizeRole(undefined)).toBe('member');
  });
});

describe('role authority ordering', () => {
  const ordered = [ROLES.VIEWER, ROLES.MEMBER, ROLES.ADMIN, ROLES.SUPERADMIN] as const;

  it('orders every role from viewer through superadmin', () => {
    for (const [actorIndex, actor] of ordered.entries()) {
      for (const [targetIndex, target] of ordered.entries()) {
        expect(hasRoleAuthorityOver(actor, target)).toBe(actorIndex >= targetIndex);
        expect(canAssignUserRole(actor, target)).toBe(actorIndex >= targetIndex);
        expect(Math.sign(compareRoleAuthority(actor, target))).toBe(
          Math.sign(actorIndex - targetIndex)
        );
      }
    }
  });

  it('keeps owner as a read-compatible superadmin alias', () => {
    expect(compareRoleAuthority('owner', ROLES.SUPERADMIN)).toBe(0);
    expect(hasRoleAuthorityOver('owner', ROLES.ADMIN)).toBe(true);
  });

  it('does not grant authority to a missing or unknown role', () => {
    expect(hasMinimumRole(undefined, ROLES.VIEWER)).toBe(false);
    expect(hasMinimumRole('not-a-role', ROLES.VIEWER)).toBe(false);
    expect(hasRoleAuthorityOver(undefined, ROLES.VIEWER)).toBe(false);
    expect(hasRoleAuthorityOver('not-a-role', ROLES.VIEWER)).toBe(false);
    expect(hasRoleAuthorityOver('not-a-role', 'not-a-role')).toBe(false);
    expect(canAssignUserRole('not-a-role', 'not-a-role')).toBe(false);
  });
});
