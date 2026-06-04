/**
 * Groups services.
 *
 * Admin-managed groups and memberships used by group-aware Branch RBAC.
 */

import type { BranchRepository } from '@agor/core/db';
import { type Database, GroupRepository } from '@agor/core/db';
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type {
  BranchGroupGrantWithGroup,
  BranchID,
  BranchPermissionLevel,
  Group,
  GroupMembership,
  HookContext,
  Params,
  UserID,
} from '@agor/core/types';
import { BRANCH_PERMISSION_LEVELS, hasMinimumRole, ROLES } from '@agor/core/types';
import { PERMISSION_RANK } from '../utils/branch-authorization.js';

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

function assertPermissionLevel(value: unknown): asserts value is BranchPermissionLevel {
  if (
    typeof value !== 'string' ||
    !BRANCH_PERMISSION_LEVELS.includes(value as BranchPermissionLevel)
  ) {
    throw new BadRequest('Invalid branch permission level');
  }
}

export function assertBranchGroupGrantPermissionLevel(
  value: unknown
): asserts value is BranchPermissionLevel {
  assertPermissionLevel(value);
  if (value === 'none') {
    throw new BadRequest("Use removal instead of a branch group grant with permission 'none'");
  }
}

export function branchGroupGrantPermissionLevelOrDefault(value: unknown): BranchPermissionLevel {
  const nextCan = value ?? 'view';
  assertBranchGroupGrantPermissionLevel(nextCan);
  return nextCan;
}

export function createGroupsService(db: Database) {
  const repo = new GroupRepository(db);
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
      return repo.create({
        name: data.name || '',
        slug: data.slug,
        description: data.description,
        created_by: paramsUser(params)?.user_id as UserID | undefined,
      });
    },
    async patch(id: string, data: Partial<Group>): Promise<Group> {
      return repo.update(id, {
        name: data.name,
        slug: data.slug,
        description: data.description,
        archived: data.archived,
      });
    },
    async remove(id: string): Promise<Group> {
      return repo.delete(id);
    },
  };
}

export function createGroupMembershipsService(db: Database) {
  const repo = new GroupRepository(db);
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
      if (!data.group_id || !data.user_id)
        throw new BadRequest('group_id and user_id are required');
      return repo.addMember(
        data.group_id,
        data.user_id,
        paramsUser(params)?.user_id as UserID | undefined
      );
    },
    async remove(id: string, params?: Params): Promise<GroupMembership> {
      const groupId =
        (params?.query?.group_id as string | undefined) ||
        (paramsRoute(params)?.groupId as string | undefined);
      const userId = (params?.query?.user_id as string | undefined) || id;
      if (!groupId || !userId) throw new BadRequest('group_id and user_id are required');
      const removed = await repo.removeMember(groupId, userId);
      if (!removed) throw new BadRequest(`Membership not found: ${groupId}/${userId}`);
      return removed;
    },
  };
}

async function requireBranchGrantViewer(
  branchRepo: BranchRepository,
  context: HookContext
): Promise<HookContext> {
  if (!context.params.provider) return context;
  if (context.params.user?._isServiceAccount) return context;
  const user = context.params.user;
  if (!user) throw new NotAuthenticated('Authentication required');
  if (hasMinimumRole(user.role, ROLES.ADMIN)) return context;

  const branchId = context.params.route?.id;
  if (!branchId) throw new BadRequest('Branch ID is required');
  const branch = await branchRepo.findById(branchId);
  if (!branch) throw new BadRequest(`Branch not found: ${branchId}`);
  const effective = await branchRepo.resolveUserPermission(branch, user.user_id as UserID);
  if (PERMISSION_RANK[effective] < PERMISSION_RANK.view) {
    throw new Forbidden('You need view permission to see branch group grants');
  }
  return context;
}

export async function requireBranchGrantManager(
  branchRepo: BranchRepository,
  context: HookContext
): Promise<HookContext> {
  if (!context.params.provider) return context;
  if (context.params.user?._isServiceAccount) return context;
  const user = context.params.user;
  if (!user) throw new NotAuthenticated('Authentication required');
  if (hasMinimumRole(user.role, ROLES.ADMIN)) return context;

  const branchId = context.params.route?.id;
  if (!branchId) throw new BadRequest('Branch ID is required');
  const branch = await branchRepo.findById(branchId);
  if (!branch) throw new BadRequest(`Branch not found: ${branchId}`);
  const isOwner = await branchRepo.isOwner(branch.branch_id as BranchID, user.user_id as UserID);
  if (!isOwner) {
    throw new Forbidden('Only branch owners and admins can manage branch group grants');
  }
  return context;
}

export function setupBranchGroupGrantsService(
  app: import('@agor/core/feathers').Application,
  db: Database,
  branchRepo: BranchRepository
) {
  const repo = new GroupRepository(db);
  app.use(
    'branches/:id/group-grants',
    {
      async find(params?: Params): Promise<BranchGroupGrantWithGroup[]> {
        const branchId = paramsRoute(params)?.id;
        if (!branchId) throw new BadRequest('Branch ID is required');
        return repo.listBranchGrants(branchId);
      },
      async create(
        data: {
          group_id?: string;
          can?: BranchPermissionLevel;
          fs_access?: 'none' | 'read' | 'write' | null;
        },
        params?: Params
      ): Promise<BranchGroupGrantWithGroup> {
        const branchId = paramsRoute(params)?.id;
        if (!branchId || !data.group_id)
          throw new BadRequest('branch id and group_id are required');
        const nextCan = branchGroupGrantPermissionLevelOrDefault(data.can);
        return repo.upsertBranchGrant({
          branch_id: branchId,
          group_id: data.group_id,
          can: nextCan,
          fs_access: data.fs_access,
          created_by: paramsUser(params)?.user_id as UserID | undefined,
        });
      },
      async patch(
        id: string,
        data: { can?: BranchPermissionLevel; fs_access?: 'none' | 'read' | 'write' | null },
        params?: Params
      ): Promise<BranchGroupGrantWithGroup> {
        const branchId = paramsRoute(params)?.id;
        if (!branchId) throw new BadRequest('Branch ID is required');
        const current = (await repo.listBranchGrants(branchId)).find((g) => g.group_id === id);
        if (!current) throw new BadRequest(`Branch group grant not found: ${id}`);
        const nextCan = data.can ?? current.can;
        assertBranchGroupGrantPermissionLevel(nextCan);
        return repo.upsertBranchGrant({
          branch_id: branchId,
          group_id: id,
          can: nextCan,
          fs_access: data.fs_access === undefined ? current.fs_access : data.fs_access,
          created_by: paramsUser(params)?.user_id as UserID | undefined,
        });
      },
      async remove(id: string, params?: Params): Promise<BranchGroupGrantWithGroup> {
        const branchId = paramsRoute(params)?.id;
        if (!branchId) throw new BadRequest('Branch ID is required');
        const removed = await repo.removeBranchGrant(branchId, id);
        if (!removed) throw new BadRequest(`Branch group grant not found: ${id}`);
        return removed;
      },
    },
    { methods: ['find', 'create', 'patch', 'remove'] }
  );

  app.service('branches/:id/group-grants').hooks({
    before: {
      find: [(context: HookContext) => requireBranchGrantViewer(branchRepo, context)],
      create: [(context: HookContext) => requireBranchGrantManager(branchRepo, context)],
      patch: [(context: HookContext) => requireBranchGrantManager(branchRepo, context)],
      remove: [(context: HookContext) => requireBranchGrantManager(branchRepo, context)],
    },
  });
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
