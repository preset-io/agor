/**
 * Groups services.
 *
 * Admin-managed groups and memberships used by group-aware Branch RBAC.
 */

import type { BoardRepository, BranchRepository } from '@agor/core/db';
import {
  eq,
  GroupRepository,
  runWithTenantDatabaseTransaction,
  select,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  users,
} from '@agor/core/db';
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  BoardID,
  Branch,
  BranchID,
  EffectiveBranchAccess,
  EffectiveCapabilityPolicyAccess,
  Group,
  GroupMembership,
  HookContext,
  Params,
  User,
  UserID,
} from '@agor/core/types';
import {
  BOARD_POLICY_CAPABILITIES,
  hasMinimumRole,
  hasRoleAuthorityOver,
  ROLES,
} from '@agor/core/types';
import { isSuperAdmin, PERMISSION_RANK } from '../utils/branch-authorization.js';
import {
  lockTenantAuthorizationFence,
  resolveCurrentTenantAuthorityActor,
} from './tenant-authorization-fence.js';

function requireMember(context: HookContext): HookContext {
  if (!context.params.provider) return context;
  if (context.params.user?._isServiceAccount) return context;
  if (!context.params.user) throw new NotAuthenticated('Authentication required');
  if (!hasMinimumRole(context.params.user.role, ROLES.MEMBER)) {
    throw new Forbidden('Only members can view groups');
  }
  return context;
}

function requireAdmin(context: HookContext): HookContext {
  if (!context.params.provider) return context;
  if (context.params.user?._isServiceAccount) return context;
  if (!context.params.user) throw new NotAuthenticated('Authentication required');
  if (!hasMinimumRole(context.params.user.role, ROLES.ADMIN)) {
    throw new Forbidden('Only admins can manage groups');
  }
  return context;
}

function paramsUser(params: Params | undefined): { user_id?: string } | undefined {
  return (params as { user?: { user_id?: string } } | undefined)?.user;
}

function paramsRoute(params: Params | undefined): Record<string, string | undefined> | undefined {
  return (params as { route?: Record<string, string | undefined> } | undefined)?.route;
}

/**
 * Public Group transport surface. The service is a plain object, not a
 * DrizzleService, and defines no `update`; pinning the list keeps it that way.
 */
export const GROUPS_SERVICE_TRANSPORT_METHODS = [
  'find',
  'get',
  'create',
  'patch',
  'remove',
] as const;

/** Nested ACL services expose only their meaningful verbs. */
export const GROUP_MEMBERSHIPS_SERVICE_TRANSPORT_METHODS = ['find', 'create', 'remove'] as const;

export function createGroupsService(db: TenantScopeAwareDatabase) {
  const repo = new GroupRepository(db);
  const requireCurrentAdmin = async (operationDb: TenantScopedDatabase, params?: Params) => {
    const current = await resolveCurrentTenantAuthorityActor(operationDb, params, {
      allowActorlessTrusted: true,
    });
    if (current && !current.service && !hasMinimumRole(current.role, ROLES.ADMIN)) {
      throw new Forbidden('Only admins can manage groups');
    }
    return current;
  };
  return {
    async find(params?: Params): Promise<Group[]> {
      const archived = params?.query?.archived as boolean | undefined;
      return repo.findAll({ archived });
    },
    async get(id: string): Promise<Group> {
      const group = await repo.findById(id);
      if (!group) throw new BadRequest(`Group not found: ${id}`);
      return group;
    },
    async create(data: Partial<Group>, params?: Params): Promise<Group> {
      return runWithTenantDatabaseTransaction(
        db,
        (params as AuthenticatedParams | undefined)?.tenant?.tenant_id,
        async (operationDb) => {
          await lockTenantAuthorizationFence(operationDb, params);
          const current = await requireCurrentAdmin(operationDb, params);
          return new GroupRepository(operationDb).create({
            name: data.name || '',
            slug: data.slug,
            description: data.description,
            created_by: current?.user_id,
          });
        }
      );
    },
    async patch(id: string, data: Partial<Group>, params?: Params): Promise<Group> {
      return runWithTenantDatabaseTransaction(
        db,
        (params as AuthenticatedParams | undefined)?.tenant?.tenant_id,
        async (operationDb) => {
          await lockTenantAuthorizationFence(operationDb, params);
          await requireCurrentAdmin(operationDb, params);
          return new GroupRepository(operationDb).update(id, {
            name: data.name,
            slug: data.slug,
            description: data.description,
            archived: data.archived,
          });
        }
      );
    },
    async remove(id: string, params?: Params): Promise<Group> {
      return runWithTenantDatabaseTransaction(
        db,
        (params as AuthenticatedParams | undefined)?.tenant?.tenant_id,
        async (operationDb) => {
          await lockTenantAuthorizationFence(operationDb, params);
          await requireCurrentAdmin(operationDb, params);
          return new GroupRepository(operationDb).delete(id);
        }
      );
    },
  };
}

export function createGroupMembershipsService(db: TenantScopeAwareDatabase) {
  const repo = new GroupRepository(db);

  const assertCanManageMembershipTarget = async (
    operationDb: TenantScopedDatabase,
    userId: string,
    params?: Params
  ) => {
    const authenticated = params as AuthenticatedParams | undefined;
    await lockTenantAuthorizationFence(operationDb, params);
    // Actor-less provider-less calls are the explicit trusted provisioning
    // seam. A provider-less call that carries a human actor is still a user
    // action and must not acquire internal-call authority by changing transport.
    if (!params?.provider && !authenticated?.user) return;
    if (authenticated?.user?._isServiceAccount) return;
    const actorId = authenticated?.user?.user_id;
    if (!actorId) throw new NotAuthenticated('Authentication required');

    // Load both sides under the active tenant/RLS scope. Missing and
    // cross-tenant targets intentionally produce the same response as an
    // authority failure so this write path cannot enumerate identities.
    const [actor, target] = await Promise.all([
      select(operationDb).from(users).where(eq(users.user_id, actorId)).one(),
      select(operationDb).from(users).where(eq(users.user_id, userId)).one(),
    ]);
    if (
      !actor ||
      !target ||
      !hasMinimumRole(actor.role, ROLES.ADMIN) ||
      !hasRoleAuthorityOver(actor.role, target.role)
    ) {
      throw new Forbidden('You do not have authority to manage this user');
    }
  };

  return {
    async find(params?: Params): Promise<GroupMembership[]> {
      return repo.listMemberships({
        group_id: params?.query?.group_id as string | undefined,
        user_id: params?.query?.user_id as string | undefined,
      });
    },
    async create(
      data: { group_id?: string; user_id?: string },
      params?: Params
    ): Promise<GroupMembership> {
      const groupId = data.group_id;
      const userId = data.user_id;
      if (!groupId || !userId) throw new BadRequest('group_id and user_id are required');
      return runWithTenantDatabaseTransaction(
        db,
        (params as AuthenticatedParams | undefined)?.tenant?.tenant_id,
        async (operationDb) => {
          await assertCanManageMembershipTarget(operationDb, userId, params);
          return new GroupRepository(operationDb).addMember(
            groupId,
            userId,
            paramsUser(params)?.user_id as UserID | undefined
          );
        }
      );
    },
    async remove(id: string, params?: Params): Promise<GroupMembership> {
      const groupId =
        (params?.query?.group_id as string | undefined) ||
        (paramsRoute(params)?.groupId as string | undefined);
      const userId = (params?.query?.user_id as string | undefined) || id;
      if (!groupId || !userId) throw new BadRequest('group_id and user_id are required');
      return runWithTenantDatabaseTransaction(
        db,
        (params as AuthenticatedParams | undefined)?.tenant?.tenant_id,
        async (operationDb) => {
          await assertCanManageMembershipTarget(operationDb, userId, params);
          const removed = await new GroupRepository(operationDb).removeMember(groupId, userId);
          if (!removed) throw new BadRequest(`Membership not found: ${groupId}/${userId}`);
          return removed;
        }
      );
    },
  };
}

export function setupBranchEffectiveAccessService(
  app: import('@agor/core/feathers').Application,
  branchRepo: BranchRepository,
  options: { allowSuperadmin?: boolean } = {}
) {
  app.use(
    'branches/:id/effective-access',
    {
      async find(params?: Params): Promise<EffectiveBranchAccess> {
        const authParams = params as
          | (Params & { user?: { user_id: string; role: string; _isServiceAccount?: boolean } })
          | undefined;
        if (authParams?.provider && authParams.user?._isServiceAccount) {
          return { can: 'all', is_owner: false, source: 'superadmin' };
        }

        const user = authParams?.user;
        if (!user) throw new NotAuthenticated('Authentication required');

        const branchId = paramsRoute(params)?.id;
        if (!branchId) throw new BadRequest('Branch ID is required');

        const branch = await branchRepo.findById(branchId);
        if (!branch) throw new BadRequest(`Branch not found: ${branchId}`);

        if (isSuperAdmin(user.role, options.allowSuperadmin ?? true)) {
          return { can: 'all', is_owner: false, source: 'superadmin' };
        }

        const userId = user.user_id as UserID;
        const effective = await branchRepo.resolveUserAccess(branch, userId);
        const can = effective.can;

        if (PERMISSION_RANK[can] < PERMISSION_RANK.view) {
          throw new Forbidden('You need view permission to see branch access');
        }

        return effective;
      },
    },
    { methods: ['find'] }
  );
}

const SUPERADMIN_BOARD_ACCESS: EffectiveCapabilityPolicyAccess = {
  capabilities: [...BOARD_POLICY_CAPABILITIES],
  fs_access: 'none',
  source: 'primary_owner',
  group_ids: [],
  is_primary_owner: false,
};

/**
 * Board analog of `setupBranchEffectiveAccessService`. Boards were the
 * newer resource in the capability-policy remodel, so their effective
 * access is already the normalized `EffectiveCapabilityPolicyAccess` shape
 * (no legacy `others_can`-tier translation needed).
 */
export function setupBoardEffectiveAccessService(
  app: import('@agor/core/feathers').Application,
  boardRepo: BoardRepository,
  options: { allowSuperadmin?: boolean } = {}
) {
  app.use(
    'boards/:id/effective-access',
    {
      async find(params?: Params): Promise<EffectiveCapabilityPolicyAccess> {
        const authParams = params as
          | (Params & { user?: { user_id: string; role: string; _isServiceAccount?: boolean } })
          | undefined;
        if (authParams?.provider && authParams.user?._isServiceAccount) {
          return SUPERADMIN_BOARD_ACCESS;
        }

        const user = authParams?.user;
        if (!user) throw new NotAuthenticated('Authentication required');

        const boardId = paramsRoute(params)?.id;
        if (!boardId) throw new BadRequest('Board ID is required');

        const board = await boardRepo.findById(boardId);
        if (!board) throw new BadRequest(`Board not found: ${boardId}`);

        if (isSuperAdmin(user.role, options.allowSuperadmin ?? true)) {
          return SUPERADMIN_BOARD_ACCESS;
        }

        const userId = user.user_id as UserID;
        const effective = await boardRepo.resolveUserAccess(board, userId);

        if (!effective.capabilities.includes('board.view')) {
          throw new Forbidden('You need view permission to see board access');
        }

        return effective;
      },
    },
    { methods: ['find'] }
  );
}

export function setupBoardAlignedBranchesService(
  app: import('@agor/core/feathers').Application,
  branchRepo: BranchRepository
) {
  app.use(
    'boards/:id/aligned-branches',
    {
      async find(params?: Params): Promise<Branch[]> {
        const authParams = params as
          | (Params & { user?: { user_id: string; role: string; _isServiceAccount?: boolean } })
          | undefined;
        if (authParams?.provider && !authParams.user?._isServiceAccount) {
          const user = authParams.user;
          if (!user) throw new NotAuthenticated('Authentication required');
          if (!hasMinimumRole(user.role, ROLES.ADMIN)) {
            throw new Forbidden('Only admins can list board-aligned branches');
          }
        }

        const boardId = paramsRoute(params)?.id;
        if (!boardId) throw new BadRequest('Board ID is required');
        return branchRepo.findBoardAlignedBranches(boardId as BoardID);
      },
    },
    { methods: ['find'] }
  );
}

export function setupBranchFsAccessUsersService(
  app: import('@agor/core/feathers').Application,
  branchRepo: BranchRepository
) {
  app.use(
    'branches/:id/fs-access-users',
    {
      async find(params?: Params): Promise<User[]> {
        const authParams = params as
          | (Params & { user?: { user_id: string; role: string; _isServiceAccount?: boolean } })
          | undefined;
        if (authParams?.provider && !authParams.user?._isServiceAccount) {
          const user = authParams.user;
          if (!user) throw new NotAuthenticated('Authentication required');
          if (!hasMinimumRole(user.role, ROLES.ADMIN)) {
            throw new Forbidden('Only admins can list branch filesystem access users');
          }
        }

        const branchId = paramsRoute(params)?.id;
        if (!branchId) throw new BadRequest('Branch ID is required');
        const userIds = await branchRepo.findExplicitFsAccessUserIds(branchId as BranchID);
        const usersService = app.service('users');
        const users = await Promise.all(
          userIds.map(async (userId): Promise<User | null> => {
            try {
              return (await usersService.get(userId)) as User;
            } catch (error) {
              console.error(`Failed to fetch branch filesystem access user ${userId}:`, error);
              return null;
            }
          })
        );
        return users.filter((user): user is User => user !== null);
      },
    },
    { methods: ['find'] }
  );
}

export const groupsHooks = {
  before: {
    all: [requireMember],
    create: [requireAdmin],
    patch: [requireAdmin],
    remove: [requireAdmin],
  },
};

export const groupMembershipsHooks = {
  before: {
    all: [requireAdmin],
  },
};
