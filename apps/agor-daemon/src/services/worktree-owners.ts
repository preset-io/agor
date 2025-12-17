/**
 * Worktree Owners Service
 *
 * Manages worktree ownership via the worktree_owners junction table.
 * Exposed as a nested route: worktrees/:id/owners
 *
 * Operations:
 * - GET /worktrees/:id/owners - List all owners of a worktree
 * - POST /worktrees/:id/owners - Add an owner to a worktree
 * - DELETE /worktrees/:id/owners/:userId - Remove an owner from a worktree
 *
 * Authorization:
 * - Only worktree owners can manage other owners (requires 'all' permission)
 *
 * Unix Integration:
 * - When owners are added/removed, fire-and-forget sync to executor
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import type { WorktreeRepository } from '@agor/core/db';
import { type Application, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { HookContext, User, UUID, WorktreeID } from '@agor/core/types';
import {
  createServiceToken,
  getDaemonUrl,
  spawnExecutorFireAndForget,
} from '../utils/spawn-executor.js';

interface WorktreeOwnerCreateData {
  user_id: string;
}

interface WorktreeOwnerParams {
  route?: {
    id: string; // worktree_id
    userId?: string; // for removal endpoint
  };
}

/**
 * Authorization hook - ensure user has 'view' permission to see owners
 */
function requireViewPermission(worktreeRepo: WorktreeRepository) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const params = context.params as any;
    const userId = params.user?.user_id;

    if (!userId) {
      throw new NotAuthenticated('Authentication required');
    }

    const worktreeId = params.route?.id;
    if (!worktreeId) {
      throw new Error('Worktree ID is required');
    }

    // Load worktree and check permission
    const worktree = await worktreeRepo.findById(worktreeId);
    if (!worktree) {
      throw new Forbidden(`Worktree not found: ${worktreeId}`);
    }

    const isOwner = await worktreeRepo.isOwner(worktree.worktree_id, userId as UUID);

    // Check if user has at least 'view' permission
    const effectivePermission = isOwner ? 'all' : worktree.others_can || 'view';
    const permissionRank = { none: -1, view: 0, prompt: 1, all: 2 };

    if (permissionRank[effectivePermission] < permissionRank.view) {
      throw new Forbidden('You do not have permission to view this worktree');
    }

    return context;
  };
}

/**
 * Authorization hook - ensure user is a worktree owner (for create/remove)
 */
function requireWorktreeOwner(worktreeRepo: WorktreeRepository) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const params = context.params as any;
    const userId = params.user?.user_id;

    if (!userId) {
      throw new NotAuthenticated('Authentication required');
    }

    const worktreeId = params.route?.id;
    if (!worktreeId) {
      throw new Error('Worktree ID is required');
    }

    // Check if user is an owner of this worktree
    const isOwner = await worktreeRepo.isOwner(worktreeId as UUID, userId as UUID);
    if (!isOwner) {
      throw new Forbidden('Only worktree owners can manage owners');
    }

    return context;
  };
}

/**
 * Configuration options for worktree owners service
 */
export interface WorktreeOwnersServiceConfig {
  /** JWT secret for creating service tokens (required for Unix integration) */
  jwtSecret?: string;
  /** Daemon Unix user (for group membership) */
  daemonUser?: string;
}

/**
 * Setup worktree owners service
 *
 * Registers a single nested route: worktrees/:id/owners
 * - GET /worktrees/:id/owners - List all owners
 * - POST /worktrees/:id/owners - Add an owner
 * - DELETE /worktrees/:id/owners/:userId - Remove an owner (userId passed as id parameter)
 */
export function setupWorktreeOwnersService(
  app: Application,
  worktreeRepo: WorktreeRepository,
  config: WorktreeOwnersServiceConfig = {}
) {
  app.use(
    'worktrees/:id/owners',
    {
      async find(params: WorktreeOwnerParams): Promise<User[]> {
        const worktreeId = params.route?.id;
        if (!worktreeId) {
          throw new Error('Worktree ID is required');
        }

        // Get owner IDs
        const ownerIds = await worktreeRepo.getOwners(worktreeId as UUID);

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

      async create(data: WorktreeOwnerCreateData, params: WorktreeOwnerParams): Promise<User> {
        const worktreeId = params.route?.id;
        if (!worktreeId) {
          throw new Error('Worktree ID is required');
        }

        const { user_id } = data;
        if (!user_id) {
          throw new Error('user_id is required');
        }

        await worktreeRepo.addOwner(worktreeId as UUID, user_id as UUID);

        // Return the user that was added (access service lazily)
        const usersService = app.service('users');
        const user = await usersService.get(user_id);
        return user;
      },

      async remove(id: string, params: WorktreeOwnerParams): Promise<User> {
        const worktreeId = params.route?.id;
        const userId = id; // The userId is passed as the id parameter

        if (!worktreeId) {
          throw new Error('Worktree ID is required');
        }
        if (!userId) {
          throw new Error('User ID is required');
        }

        // Get user before removing (access service lazily)
        const usersService = app.service('users');
        const user = await usersService.get(userId);

        await worktreeRepo.removeOwner(worktreeId as UUID, userId as UUID);

        return user;
      },
    },
    {
      methods: ['find', 'create', 'remove'],
    }
  );

  // Add authorization and Unix integration hooks
  app.service('worktrees/:id/owners').hooks({
    before: {
      find: [requireViewPermission(worktreeRepo)],
      create: [requireWorktreeOwner(worktreeRepo)],
      remove: [requireWorktreeOwner(worktreeRepo)],
    },
    after: {
      // After adding owner: fire-and-forget sync to executor
      // The executor will handle adding user to worktree group, repo group, and creating symlinks
      create: [
        async (context: HookContext) => {
          // Skip if no jwtSecret (Unix integration not configured)
          if (!config.jwtSecret) {
            return context;
          }

          // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
          const params = context.params as any;
          const worktreeId = params.route?.id as WorktreeID;

          // Fire-and-forget sync to executor
          // Syncing the worktree will pick up the new owner from the DB
          console.log(
            `[Unix Integration] Syncing worktree ${worktreeId.substring(0, 8)} after owner added`
          );
          const serviceToken = createServiceToken(config.jwtSecret);
          spawnExecutorFireAndForget(
            {
              command: 'unix.sync-worktree',
              sessionToken: serviceToken,
              daemonUrl: getDaemonUrl(),
              params: {
                worktreeId,
                daemonUser: config.daemonUser,
              },
            },
            { logPrefix: '[Executor/worktree-owners.create]' }
          );

          return context;
        },
      ],
      // After removing owner: fire-and-forget sync to executor
      // The executor will handle removing user from groups and updating permissions
      remove: [
        async (context: HookContext) => {
          // Skip if no jwtSecret (Unix integration not configured)
          if (!config.jwtSecret) {
            return context;
          }

          // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
          const params = context.params as any;
          const worktreeId = params.route?.id as WorktreeID;

          // Fire-and-forget sync to executor
          // Syncing the worktree will handle the removed owner
          console.log(
            `[Unix Integration] Syncing worktree ${worktreeId.substring(0, 8)} after owner removed`
          );
          const serviceToken = createServiceToken(config.jwtSecret);
          spawnExecutorFireAndForget(
            {
              command: 'unix.sync-worktree',
              sessionToken: serviceToken,
              daemonUrl: getDaemonUrl(),
              params: {
                worktreeId,
                daemonUser: config.daemonUser,
              },
            },
            { logPrefix: '[Executor/worktree-owners.remove]' }
          );

          return context;
        },
      ],
    },
  });
}
