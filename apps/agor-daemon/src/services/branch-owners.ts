/**
 * Branch Owners Service
 *
 * Manages branch ownership via the branch_owners junction table.
 * Exposed as a nested route: branches/:id/owners
 *
 * Operations:
 * - GET /branches/:id/owners - List all owners of a branch
 * - POST /branches/:id/owners - Add an owner to a branch
 * - DELETE /branches/:id/owners/:userId - Remove an owner from a branch
 *
 * Authorization:
 * - Only branch owners can manage other owners (requires 'all' permission)
 *
 * Unix Integration:
 * - When Unix filesystem isolation is enabled, owner changes fire-and-forget sync to executor
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import type { BranchRepository } from '@agor/core/db';
import { shortId } from '@agor/core/db';
import { type Application, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, BranchID, HookContext, User, UUID } from '@agor/core/types';
import { isSuperAdmin, PERMISSION_RANK } from '../utils/branch-authorization.js';
import {
  createServiceToken,
  getDaemonUrl,
  serviceTokenScopeForParams,
  spawnExecutorFireAndForget,
} from '../utils/spawn-executor.js';

interface BranchOwnerCreateData {
  user_id: string;
}

interface BranchOwnerParams {
  route?: {
    id: string; // branch_id
    userId?: string; // for removal endpoint
  };
}

/**
 * Authorization hook - ensure user has 'view' permission to see owners
 */
function requireViewPermission(branchRepo: BranchRepository, allowSuperadmin = true) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    // Service accounts (executor) bypass RBAC
    if (context.params.user?._isServiceAccount) {
      return context;
    }

    const userId = context.params.user?.user_id;

    if (!userId) {
      throw new NotAuthenticated('Authentication required');
    }

    const branchId = context.params.route?.id;
    if (!branchId) {
      throw new Error('Branch ID is required');
    }

    // Superadmins can view owners of any branch
    const userRole = context.params.user?.role;
    if (isSuperAdmin(userRole, allowSuperadmin)) {
      return context;
    }

    // Load branch and check permission
    const branch = await branchRepo.findById(branchId);
    if (!branch) {
      throw new Forbidden(`Branch not found: ${branchId}`);
    }

    const isOwner = await branchRepo.isOwner(branch.branch_id, userId as UUID);

    // Check if user has at least 'view' permission, including group grants.
    const effectivePermission = isOwner
      ? 'all'
      : await branchRepo.resolveUserPermission(branch, userId as UUID);

    if (PERMISSION_RANK[effectivePermission] < PERMISSION_RANK.view) {
      throw new Forbidden('You do not have permission to view this branch');
    }

    return context;
  };
}

/**
 * Authorization hook - ensure user is a branch owner (for create/remove)
 */
function requireBranchOwner(branchRepo: BranchRepository, allowSuperadmin = true) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    // Service accounts (executor) bypass RBAC
    if (context.params.user?._isServiceAccount) {
      return context;
    }

    const userId = context.params.user?.user_id;

    if (!userId) {
      throw new NotAuthenticated('Authentication required');
    }

    const branchId = context.params.route?.id;
    if (!branchId) {
      throw new Error('Branch ID is required');
    }

    // Superadmins can manage owners on any branch (self-assign ownership)
    const userRole = context.params.user?.role;
    if (isSuperAdmin(userRole, allowSuperadmin)) {
      return context;
    }

    // Check if user is an owner of this branch
    const isOwner = await branchRepo.isOwner(branchId as UUID, userId as UUID);
    if (!isOwner) {
      throw new Forbidden('Only branch owners can manage owners');
    }

    return context;
  };
}

/**
 * Configuration options for branch owners service
 */
export interface BranchOwnersServiceConfig {
  /** JWT secret for creating service tokens (required for Unix integration) */
  jwtSecret?: string;
  /** Daemon Unix user (for group membership) */
  daemonUser?: string;
  /** Whether Unix filesystem isolation is enabled */
  unixFsIsolationEnabled?: boolean;
  /** Whether superadmin bypass is enabled (default: true) */
  allowSuperadmin?: boolean;
}

/**
 * Setup branch owners service
 *
 * Registers a single nested route: branches/:id/owners
 * - GET /branches/:id/owners - List all owners
 * - POST /branches/:id/owners - Add an owner
 * - DELETE /branches/:id/owners/:userId - Remove an owner (userId passed as id parameter)
 */
export function setupBranchOwnersService(
  app: Application,
  branchRepo: BranchRepository,
  config: BranchOwnersServiceConfig = {}
) {
  app.use(
    'branches/:id/owners',
    {
      async find(params: BranchOwnerParams): Promise<User[]> {
        const branchId = params.route?.id;
        if (!branchId) {
          throw new Error('Branch ID is required');
        }

        // Get owner IDs
        const ownerIds = await branchRepo.getOwners(branchId as UUID);

        // Fetch user details for each owner (access service lazily)
        const usersService = app.service('users');
        const owners = await Promise.all(
          ownerIds.map(async (userId): Promise<User | null> => {
            try {
              return (await usersService.get(userId)) as User;
            } catch (error) {
              console.error(`Failed to fetch user ${userId}:`, error);
              return null;
            }
          })
        );

        // Filter out any null users
        return owners.filter((user): user is User => user !== null);
      },

      async create(data: BranchOwnerCreateData, params: BranchOwnerParams): Promise<User> {
        const branchId = params.route?.id;
        if (!branchId) {
          throw new Error('Branch ID is required');
        }

        const { user_id } = data;
        if (!user_id) {
          throw new Error('user_id is required');
        }

        await branchRepo.addOwner(branchId as UUID, user_id as UUID);

        // Return the user that was added (access service lazily)
        const usersService = app.service('users');
        const user = await usersService.get(user_id);
        return user;
      },

      async remove(id: string, params: BranchOwnerParams): Promise<User> {
        const branchId = params.route?.id;
        const userId = id; // The userId is passed as the id parameter

        if (!branchId) {
          throw new Error('Branch ID is required');
        }
        if (!userId) {
          throw new Error('User ID is required');
        }

        // Get user before removing (access service lazily)
        const usersService = app.service('users');
        const user = await usersService.get(userId);

        await branchRepo.removeOwner(branchId as UUID, userId as UUID);

        return user;
      },
    },
    {
      methods: ['find', 'create', 'remove'],
    }
  );

  // Add authorization and Unix integration hooks
  const allowSuperadmin = config.allowSuperadmin ?? true;
  app.service('branches/:id/owners').hooks({
    before: {
      find: [requireViewPermission(branchRepo, allowSuperadmin)],
      create: [requireBranchOwner(branchRepo, allowSuperadmin)],
      remove: [requireBranchOwner(branchRepo, allowSuperadmin)],
    },
    after: {
      // After adding owner: fire-and-forget sync to executor
      // The executor will handle adding user to branch group, repo group, and creating symlinks
      create: [
        async (context: HookContext) => {
          // Skip unless Unix filesystem isolation is enabled/configured.
          if (!config.unixFsIsolationEnabled || !config.jwtSecret) {
            return context;
          }

          const branchId = context.params.route?.id as BranchID;

          // Fire-and-forget sync to executor
          // Syncing the branch will pick up the new owner from the DB
          console.log(`[Unix Integration] Syncing branch ${shortId(branchId)} after owner added`);
          const serviceToken = createServiceToken(config.jwtSecret, undefined, {
            ...serviceTokenScopeForParams(context.params as Partial<AuthenticatedParams>),
            branch_id: branchId,
            command: 'unix.sync-branch',
          });
          spawnExecutorFireAndForget(
            {
              command: 'unix.sync-branch',
              sessionToken: serviceToken,
              daemonUrl: getDaemonUrl(),
              params: {
                branchId,
                daemonUser: config.daemonUser,
              },
            },
            { logPrefix: '[Executor/branch-owners.create]' }
          );

          return context;
        },
      ],
      // After removing owner: fire-and-forget sync to executor
      // The executor will handle removing user from groups and updating permissions
      remove: [
        async (context: HookContext) => {
          // Skip unless Unix filesystem isolation is enabled/configured.
          if (!config.unixFsIsolationEnabled || !config.jwtSecret) {
            return context;
          }

          const branchId = context.params.route?.id as BranchID;

          // Fire-and-forget sync to executor
          // Syncing the branch will handle the removed owner
          console.log(`[Unix Integration] Syncing branch ${shortId(branchId)} after owner removed`);
          const serviceToken = createServiceToken(config.jwtSecret, undefined, {
            ...serviceTokenScopeForParams(context.params as Partial<AuthenticatedParams>),
            branch_id: branchId,
            command: 'unix.sync-branch',
          });
          spawnExecutorFireAndForget(
            {
              command: 'unix.sync-branch',
              sessionToken: serviceToken,
              daemonUrl: getDaemonUrl(),
              params: {
                branchId,
                daemonUser: config.daemonUser,
              },
            },
            { logPrefix: '[Executor/branch-owners.remove]' }
          );

          return context;
        },
      ],
    },
  });
}
