/** Board Owners Service - nested route: boards/:id/owners */

import type { BoardRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { User, UUID } from '@agor/core/types';
import { requireAuthorizedBoardRoute } from '../utils/board-route-authorization.js';

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

/** Public nested-owner surface; whole-row replacement is not a valid operation. */
export const BOARD_OWNERS_SERVICE_TRANSPORT_METHODS = ['find', 'create', 'remove'] as const;
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
    { methods: [...BOARD_OWNERS_SERVICE_TRANSPORT_METHODS] }
  );

  app.service('boards/:id/owners').hooks({
    before: {
      find: [requireAuthorizedBoardRoute(boardRepo, 'view', 'view board owners')],
      create: [requireAuthorizedBoardRoute(boardRepo, 'mutate', 'manage board owners')],
      remove: [requireAuthorizedBoardRoute(boardRepo, 'mutate', 'manage board owners')],
    },
  });
}
