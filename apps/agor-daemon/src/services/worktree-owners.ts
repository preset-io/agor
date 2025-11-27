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
 * @see context/explorations/rbac.md
 */

import type { WorktreeRepository } from '@agor/core/db';
import { type Application, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { HookContext, User, UUID } from '@agor/core/types';

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
    const permissionRank = { view: 0, prompt: 1, all: 2 };

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
 * Setup worktree owners service
 *
 * Registers a single nested route: worktrees/:id/owners
 * - GET /worktrees/:id/owners - List all owners
 * - POST /worktrees/:id/owners - Add an owner
 * - DELETE /worktrees/:id/owners/:userId - Remove an owner (userId passed as id parameter)
 */
export function setupWorktreeOwnersService(app: Application, worktreeRepo: WorktreeRepository) {
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

  // Add authorization hooks
  app.service('worktrees/:id/owners').hooks({
    before: {
      find: [requireViewPermission(worktreeRepo)],
      create: [requireWorktreeOwner(worktreeRepo)],
      remove: [requireWorktreeOwner(worktreeRepo)],
    },
  });
}
