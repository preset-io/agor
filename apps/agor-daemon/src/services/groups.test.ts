import type { BranchRepository } from '@agor/core/db';
import type { HookContext } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  assertBranchGroupGrantPermissionLevel,
  branchGroupGrantPermissionLevelOrDefault,
  groupMembershipsHooks,
  groupsHooks,
  requireBranchGrantManager,
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

  it('rejects blank or invalid grant levels', () => {
    expect(() => branchGroupGrantPermissionLevelOrDefault('')).toThrow(/invalid/i);
    expect(() => branchGroupGrantPermissionLevelOrDefault('admin')).toThrow(/invalid/i);
  });

  it('defaults only missing grant levels to view', () => {
    expect(branchGroupGrantPermissionLevelOrDefault(undefined)).toBe('view');
    expect(branchGroupGrantPermissionLevelOrDefault('session')).toBe('session');
  });

  it('accepts explicit visible permission grants', () => {
    expect(() => assertBranchGroupGrantPermissionLevel('view')).not.toThrow();
    expect(() => assertBranchGroupGrantPermissionLevel('session')).not.toThrow();
    expect(() => assertBranchGroupGrantPermissionLevel('prompt')).not.toThrow();
    expect(() => assertBranchGroupGrantPermissionLevel('all')).not.toThrow();
  });
});

describe('branch group grant management authorization', () => {
  const branchId = '019f0000-0000-7000-8000-00000000beef';
  const userId = '019f0000-0000-7000-8000-00000000abcd';

  function managerContext(role: string): HookContext {
    return {
      params: {
        provider: 'rest',
        route: { id: branchId },
        user: {
          user_id: userId,
          role,
        },
      },
    } as unknown as HookContext;
  }

  function branchRepoFor(isOwner: boolean) {
    return {
      findById: vi.fn(async () => ({ branch_id: branchId })),
      isOwner: vi.fn(async () => isOwner),
      resolveUserPermission: vi.fn(async () => 'all'),
    } as unknown as BranchRepository & {
      isOwner: ReturnType<typeof vi.fn>;
      resolveUserPermission: ReturnType<typeof vi.fn>;
    };
  }

  it('allows direct branch owners to manage group grants', async () => {
    const repo = branchRepoFor(true);
    await expect(
      requireBranchGrantManager(repo, managerContext(ROLES.MEMBER))
    ).resolves.toBeTruthy();
  });

  it('rejects non-owners even if an effective grant would resolve to all', async () => {
    const repo = branchRepoFor(false);
    await expect(requireBranchGrantManager(repo, managerContext(ROLES.MEMBER))).rejects.toThrow(
      /only branch owners and admins/i
    );
    expect(repo.resolveUserPermission).not.toHaveBeenCalled();
  });

  it('allows admins without requiring branch ownership', async () => {
    const repo = branchRepoFor(false);
    await expect(
      requireBranchGrantManager(repo, managerContext(ROLES.ADMIN))
    ).resolves.toBeTruthy();
    expect(repo.isOwner).not.toHaveBeenCalled();
  });
});
