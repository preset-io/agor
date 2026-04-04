/**
 * User API Keys Service
 *
 * CRUD operations for personal API keys.
 * All operations are scoped to the authenticated user.
 */

import type { UserApiKeysRepository } from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams } from '@agor/core/types';

export function createUserApiKeysService(apiKeysRepo: UserApiKeysRepository) {
  return {
    /** List all API keys for the authenticated user */
    async find(params: AuthenticatedParams) {
      const user = params.user;
      if (!user) throw new NotAuthenticated('Authentication required');
      return apiKeysRepo.listByUser(user.user_id);
    },

    /** Create a new API key */
    async create(data: { name: string }, params: AuthenticatedParams) {
      const user = params.user;
      if (!user) throw new NotAuthenticated('Authentication required');

      const name = data.name?.trim();
      if (!name) throw new BadRequest('Key name is required');
      if (name.length > 100) throw new BadRequest('Key name must be 100 characters or less');

      // Limit keys per user
      const existing = await apiKeysRepo.listByUser(user.user_id);
      if (existing.length >= 25) {
        throw new BadRequest('Maximum of 25 API keys per user');
      }

      const result = await apiKeysRepo.create(user.user_id, name);
      console.log(
        `[API Keys] Created: ${result.key.prefix}... for user ${user.user_id.substring(0, 8)}`
      );
      return result;
    },

    /** Update key name */
    async patch(id: string, data: { name?: string }, params: AuthenticatedParams) {
      const user = params.user;
      if (!user) throw new NotAuthenticated('Authentication required');

      if (data.name !== undefined) {
        const name = data.name.trim();
        if (!name) throw new BadRequest('Key name is required');
        if (name.length > 100) throw new BadRequest('Key name must be 100 characters or less');
        await apiKeysRepo.updateName(id, user.user_id, name);
      }

      return { id, ...data };
    },

    /** Delete (revoke) an API key */
    async remove(id: string, params: AuthenticatedParams) {
      const user = params.user;
      if (!user) throw new NotAuthenticated('Authentication required');

      await apiKeysRepo.delete(id, user.user_id);
      console.log(
        `[API Keys] Deleted: ${id.substring(0, 8)} for user ${user.user_id.substring(0, 8)}`
      );
      return { id };
    },
  };
}
