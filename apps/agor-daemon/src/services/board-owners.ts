/** Board Owners Service - nested route: boards/:id/owners */

import type { BoardRepository } from '@agor/core/db';
import { type Application, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { HookContext, User, UUID } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

interface BoardOwnerCreateData {
  user_id: string;
}

interface BoardOwnerParams {
  provider?: string;
  user?: { user_id?: string; role?: string; _isServiceAccount?: boolean };
  route?: {
    id: string;
    userId?: string;
  };
}

function requireBoardAccess(boardRepo: BoardRepository, mode: 'view' | 'mutate') {
  return async (context: HookContext) => {
    if (!context.params.provider) return context;
    if (context.params.user?._isServiceAccount) return context;
    const user = context.params.user;
    if (!user?.user_id) throw new NotAuthenticated('Authentication required');
    if (hasMinimumRole(user.role, ROLES.ADMIN)) return context;

    const boardId = context.params.route?.id;
    if (!boardId) throw new Error('Board ID is required');
    const allowed =
      mode === 'view'
        ? await boardRepo.canView(boardId, user.user_id as UUID)
        : await boardRepo.canMutate(boardId, user.user_id as UUID);
    if (allowed) return context;
    throw new Forbidden(
      mode === 'view'
        ? 'You need board access to view board owners'
        : "You need board owner or board group 'all' access to manage board owners"
    );
  };
}

export function setupBoardOwnersService(app: Application, boardRepo: BoardRepository) {
  app.use(
    'boards/:id/owners',
    {
      async find(params: BoardOwnerParams): Promise<User[]> {
        const boardId = params.route?.id;
        if (!boardId) throw new Error('Board ID is required');
        const ownerIds = await boardRepo.getOwners(boardId);
        const usersService = app.service('users');
        const owners = await Promise.all(
          ownerIds.map(async (userId): Promise<User | null> => {
            try {
              return (await usersService.get(userId)) as User;
            } catch (error) {
              console.error(`Failed to fetch board owner ${userId}:`, error);
              return null;
            }
          })
        );
        return owners.filter((user): user is User => user !== null);
      },

      async create(data: BoardOwnerCreateData, params: BoardOwnerParams): Promise<User> {
        const boardId = params.route?.id;
        if (!boardId) throw new Error('Board ID is required');
        if (!data.user_id) throw new Error('user_id is required');
        await boardRepo.addOwner(boardId, data.user_id as UUID);
        return (await app.service('users').get(data.user_id)) as User;
      },

      async remove(id: string, params: BoardOwnerParams): Promise<User> {
        const boardId = params.route?.id;
        if (!boardId) throw new Error('Board ID is required');
        const user = (await app.service('users').get(id)) as User;
        await boardRepo.removeOwner(boardId, id as UUID);
        return user;
      },
    },
    { methods: ['find', 'create', 'remove'] }
  );

  app.service('boards/:id/owners').hooks({
    before: {
      find: [requireBoardAccess(boardRepo, 'view')],
      create: [requireBoardAccess(boardRepo, 'mutate')],
      remove: [requireBoardAccess(boardRepo, 'mutate')],
    },
  });
}
