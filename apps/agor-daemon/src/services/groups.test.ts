import {
  type BoardRepository,
  type BranchRepository,
  GroupRepository,
  getCurrentTenantDatabaseScope,
} from '@agor/core/db';
import type {
  AuthenticatedParams,
  EffectiveCapabilityPolicyAccess,
  HookContext,
  User,
} from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  createGroupMembershipsService,
  createGroupsService,
  groupMembershipsHooks,
  groupsHooks,
  setupBoardEffectiveAccessService,
  setupBranchEffectiveAccessService,
} from './groups';
import { UsersService } from './users';

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

describe('group membership target authority', () => {
  dbTest('rejects stale admin claims and providerless human mutation calls', async ({ db }) => {
    const users = new UsersService(db);
    const groups = createGroupsService(db);
    const member = await users.create({
      email: 'stale-group-admin@example.test',
      password: 'test-password-1234',
      role: 'member',
    });
    const staleAdmin = {
      user: { user_id: member.user_id, email: member.email, role: 'admin' },
    } as AuthenticatedParams;

    await expect(groups.create({ name: 'Stale claim group' }, staleAdmin)).rejects.toMatchObject({
      code: 403,
    });
    await expect(
      groups.create({ name: 'Stale REST claim group' }, { ...staleAdmin, provider: 'rest' })
    ).rejects.toMatchObject({ code: 403 });
  });

  dbTest('enforces actor authority over the membership target', async ({ db }) => {
    const users = new UsersService(db);
    const memberships = createGroupMembershipsService(db);
    const group = await new GroupRepository(db).create({ name: 'Authority group' });
    const superadmin = await users.create({
      email: 'group-superadmin@example.test',
      password: 'test-password-1234',
      role: 'superadmin',
    });
    const admin = await users.create({
      email: 'group-admin@example.test',
      password: 'test-password-1234',
      role: 'admin',
    });
    const member = await users.create({
      email: 'group-member@example.test',
      password: 'test-password-1234',
      role: 'member',
    });
    const params = (actor: User): AuthenticatedParams => ({
      provider: 'rest',
      user: { user_id: actor.user_id, email: actor.email, role: actor.role },
    });
    const directParams = (actor: User): AuthenticatedParams =>
      ({
        user: { user_id: actor.user_id, email: actor.email, role: actor.role },
      }) as AuthenticatedParams;

    await expect(
      memberships.create({ group_id: group.group_id, user_id: superadmin.user_id }, params(admin))
    ).rejects.toMatchObject({ code: 403 });
    await expect(
      memberships.create(
        { group_id: group.group_id, user_id: superadmin.user_id },
        directParams(admin)
      )
    ).rejects.toMatchObject({ code: 403 });

    await memberships.create({ group_id: group.group_id, user_id: superadmin.user_id });
    await expect(
      memberships.remove(superadmin.user_id, {
        ...params(admin),
        query: { group_id: group.group_id },
      })
    ).rejects.toMatchObject({ code: 403 });
    await expect(
      memberships.remove(superadmin.user_id, {
        ...directParams(admin),
        query: { group_id: group.group_id },
      })
    ).rejects.toMatchObject({ code: 403 });

    await expect(
      memberships.create({ group_id: group.group_id, user_id: admin.user_id }, params(superadmin))
    ).resolves.toMatchObject({ user_id: admin.user_id });
    await expect(
      memberships.create({ group_id: group.group_id, user_id: member.user_id }, params(admin))
    ).resolves.toMatchObject({ user_id: member.user_id });
  });

  dbTest(
    'keeps the authority decision and membership write in one SQLite transaction',
    async ({ db }) => {
      const users = new UsersService(db);
      const memberships = createGroupMembershipsService(db);
      const group = await new GroupRepository(db).create({ name: 'Atomic authority group' });
      const admin = await users.create({
        email: 'atomic-group-admin@example.test',
        password: 'test-password-1234',
        role: 'admin',
      });
      const member = await users.create({
        email: 'atomic-group-member@example.test',
        password: 'test-password-1234',
        role: 'member',
      });
      const addMember = GroupRepository.prototype.addMember;
      const transactionStates: Array<boolean | undefined> = [];
      const addMemberSpy = vi
        .spyOn(GroupRepository.prototype, 'addMember')
        .mockImplementation(function (...args) {
          transactionStates.push(getCurrentTenantDatabaseScope()?.transactionActive);
          return addMember.apply(this, args);
        });

      try {
        await memberships.create({ group_id: group.group_id, user_id: member.user_id }, {
          user: { user_id: admin.user_id, email: admin.email, role: admin.role },
        } as AuthenticatedParams);
      } finally {
        addMemberSpy.mockRestore();
      }

      expect(transactionStates).toEqual([true]);
    }
  );
});

describe('normalized branch effective-access service', () => {
  const branchId = '019f0000-0000-7000-8000-00000000beef';
  const userId = '019f0000-0000-7000-8000-00000000abcd';

  function install(access: {
    can: 'none' | 'view' | 'session' | 'prompt' | 'all';
    fs_access?: 'none' | 'read' | 'write';
    is_owner: boolean;
    source: 'owner' | 'group' | 'others';
  }) {
    let service:
      | {
          find(params: {
            route: { id: string };
            user: { user_id: string; role: string };
          }): Promise<unknown>;
        }
      | undefined;
    const app = {
      use: vi.fn((_path: string, value: typeof service) => {
        service = value;
      }),
    };
    const repo = {
      findById: vi.fn(async () => ({ branch_id: branchId })),
      resolveUserAccess: vi.fn(async () => access),
    } as unknown as BranchRepository;
    setupBranchEffectiveAccessService(app as never, repo);
    if (!service) throw new Error('effective-access service was not registered');
    return { service, repo };
  }

  function params(role: string) {
    return {
      route: { id: branchId },
      user: {
        user_id: userId,
        role,
      },
    };
  }

  it('returns the normalized resolver result, including group and filesystem access', async () => {
    const effective = {
      can: 'session' as const,
      fs_access: 'read' as const,
      is_owner: false,
      source: 'group' as const,
    };
    const { service, repo } = install(effective);

    await expect(service.find(params(ROLES.MEMBER))).resolves.toEqual(effective);
    expect(repo.resolveUserAccess).toHaveBeenCalledOnce();
  });

  it('fails closed when the normalized policy grants no view access', async () => {
    const { service } = install({
      can: 'none',
      fs_access: 'none',
      is_owner: false,
      source: 'others',
    });
    await expect(service.find(params(ROLES.MEMBER))).rejects.toThrow(/view permission/i);
  });

  it('retains the configured superadmin bypass without consulting policy rows', async () => {
    const { service, repo } = install({ can: 'none', is_owner: false, source: 'others' });
    await expect(service.find(params(ROLES.SUPERADMIN))).resolves.toMatchObject({
      can: 'all',
      source: 'superadmin',
    });
    expect(repo.resolveUserAccess).not.toHaveBeenCalled();
  });

  it('requires an authenticated principal', async () => {
    const { service } = install({ can: 'view', is_owner: false, source: 'others' });
    await expect(
      service.find({
        provider: 'rest',
        route: { id: branchId },
        user: undefined as never,
      })
    ).rejects.toThrow(/authentication required/i);
  });
});

describe('normalized board effective-access service', () => {
  const boardId = '019f0000-0000-7000-8000-00000000c0de';
  const userId = '019f0000-0000-7000-8000-00000000abcd';

  function install(access: EffectiveCapabilityPolicyAccess) {
    let service:
      | {
          find(params: {
            route: { id: string };
            user: { user_id: string; role: string };
          }): Promise<unknown>;
        }
      | undefined;
    const app = {
      use: vi.fn((_path: string, value: typeof service) => {
        service = value;
      }),
    };
    const repo = {
      findById: vi.fn(async () => ({ board_id: boardId })),
      resolveUserAccess: vi.fn(async () => access),
    } as unknown as BoardRepository;
    setupBoardEffectiveAccessService(app as never, repo);
    if (!service) throw new Error('effective-access service was not registered');
    return { service, repo };
  }

  function params(role: string) {
    return {
      route: { id: boardId },
      user: {
        user_id: userId,
        role,
      },
    };
  }

  it('returns the normalized resolver result, including group and filesystem access', async () => {
    const effective: EffectiveCapabilityPolicyAccess = {
      capabilities: ['board.view', 'board.edit'],
      fs_access: 'none',
      source: 'group',
      group_ids: ['019f0000-0000-7000-8000-00000000f00d' as never],
      is_primary_owner: false,
    };
    const { service, repo } = install(effective);

    await expect(service.find(params(ROLES.MEMBER))).resolves.toEqual(effective);
    expect(repo.resolveUserAccess).toHaveBeenCalledOnce();
  });

  it('fails closed when the normalized policy grants no view capability', async () => {
    const { service } = install({
      capabilities: [],
      fs_access: 'none',
      source: 'others',
      group_ids: [],
      is_primary_owner: false,
    });
    await expect(service.find(params(ROLES.MEMBER))).rejects.toThrow(/view permission/i);
  });

  it('retains the configured superadmin bypass without consulting policy rows', async () => {
    const { service, repo } = install({
      capabilities: [],
      fs_access: 'none',
      source: 'others',
      group_ids: [],
      is_primary_owner: false,
    });
    await expect(service.find(params(ROLES.SUPERADMIN))).resolves.toMatchObject({
      capabilities: expect.arrayContaining(['board.view', 'board.edit']),
      source: 'primary_owner',
    });
    expect(repo.resolveUserAccess).not.toHaveBeenCalled();
  });

  it('requires an authenticated principal', async () => {
    const { service } = install({
      capabilities: ['board.view'],
      fs_access: 'none',
      source: 'others',
      group_ids: [],
      is_primary_owner: false,
    });
    await expect(
      service.find({
        provider: 'rest',
        route: { id: boardId },
        user: undefined as never,
      })
    ).rejects.toThrow(/authentication required/i);
  });
});
