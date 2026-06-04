import type { HookContext } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  assertBranchGroupGrantPermissionLevel,
  groupMembershipsHooks,
  groupsHooks,
} from './groups';

function contextFor(role?: string, extraUser: Record<string, unknown> = {}): HookContext {
  return {
    params: {
      provider: 'rest',
      user: role
        ? {
            user_id: '019f0000-0000-7000-8000-00000000abcd',
            role,
            ...extraUser,
          }
        : undefined,
    },
  } as unknown as HookContext;
}

describe('groups service authorization hooks', () => {
  it('requires authentication to view groups', () => {
    expect(() => groupsHooks.before.all[0](contextFor())).toThrow(/authentication required/i);
  });

  it('allows members to view groups', () => {
    expect(() => groupsHooks.before.all[0](contextFor(ROLES.MEMBER))).not.toThrow();
  });

  it('rejects viewers from viewing groups', () => {
    expect(() => groupsHooks.before.all[0](contextFor(ROLES.VIEWER))).toThrow(
      /only members can view groups/i
    );
  });

  it('requires admins to create, update, or delete groups', () => {
    expect(() => groupsHooks.before.create[0](contextFor(ROLES.MEMBER))).toThrow(
      /only admins can manage groups/i
    );
    expect(() => groupsHooks.before.patch[0](contextFor(ROLES.MEMBER))).toThrow(
      /only admins can manage groups/i
    );
    expect(() => groupsHooks.before.remove[0](contextFor(ROLES.MEMBER))).toThrow(
      /only admins can manage groups/i
    );
  });

  it('allows admins and superadmins to manage groups', () => {
    expect(() => groupsHooks.before.create[0](contextFor(ROLES.ADMIN))).not.toThrow();
    expect(() => groupsHooks.before.patch[0](contextFor(ROLES.SUPERADMIN))).not.toThrow();
    expect(() => groupsHooks.before.remove[0](contextFor(ROLES.SUPERADMIN))).not.toThrow();
  });

  it('requires admins for membership assignment', () => {
    expect(() => groupMembershipsHooks.before.all[0](contextFor(ROLES.MEMBER))).toThrow(
      /only admins can manage groups/i
    );
    expect(() => groupMembershipsHooks.before.all[0](contextFor(ROLES.ADMIN))).not.toThrow();
  });

  it('allows service accounts to bypass human group hooks', () => {
    const context = contextFor(ROLES.VIEWER, { _isServiceAccount: true });
    expect(() => groupsHooks.before.all[0](context)).not.toThrow();
    expect(() => groupsHooks.before.create[0](context)).not.toThrow();
    expect(() => groupMembershipsHooks.before.all[0](context)).not.toThrow();
  });
});

describe('branch group grant permission validation', () => {
  it('rejects none grants; callers should remove grants instead', () => {
    expect(() => assertBranchGroupGrantPermissionLevel('none')).toThrow(/use removal/i);
  });

  it('accepts explicit visible permission grants', () => {
    expect(() => assertBranchGroupGrantPermissionLevel('view')).not.toThrow();
    expect(() => assertBranchGroupGrantPermissionLevel('session')).not.toThrow();
    expect(() => assertBranchGroupGrantPermissionLevel('prompt')).not.toThrow();
    expect(() => assertBranchGroupGrantPermissionLevel('all')).not.toThrow();
  });
});
