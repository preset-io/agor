/**
 * User API Keys Service
 *
 * CRUD operations for personal API keys.
 * All operations are scoped to the authenticated user.
 */

import type { UserApiKeysRepository } from '@agor/core/db';
import { shortId } from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  type CreateUserApiKeyRequest,
  isUserApiKeySource,
  type UserApiKeySource,
} from '@agor/core/types';

export function createUserApiKeysService(apiKeysRepo: UserApiKeysRepository) {
  return {
    /** List all API keys for the authenticated user */
    async find(params: AuthenticatedParams) {
      const user = params.user;
      if (!user) throw new NotAuthenticated('Authentication required');
      return apiKeysRepo.listByUser(user.user_id);
    },

    /** Create a new API key */
    async create(data: CreateUserApiKeyRequest, params: AuthenticatedParams) {
      const user = params.user;
      if (!user) throw new NotAuthenticated('Authentication required');

      const name = data.name?.trim();
      if (!name) throw new BadRequest('Key name is required');
      if (name.length > 100) throw new BadRequest('Key name must be 100 characters or less');
      if (data.source !== undefined && !isUserApiKeySource(data.source)) {
        throw new BadRequest('Invalid API key source');
      }
      const source: UserApiKeySource = data.source ?? 'manual';
      // Re-login on the same machine replaces that machine's CLI key, so the
      // key being replaced does not count toward the per-user limit.
      const replacePrevious = source === 'cli_login' && data.replace_previous === true;

      // Limit keys per user
      const existing = await apiKeysRepo.listByUser(user.user_id);
      const replaceable = replacePrevious
        ? existing.filter((key) => key.source === 'cli_login' && key.name === name).length
        : 0;
      if (existing.length - replaceable >= 25) {
        throw new BadRequest('Maximum of 25 API keys per user');
      }

      // Create first, then retire the machine's older CLI key, so a failed
      // attempt never leaves the machine without a working key. In PostgreSQL
      // both happen in the request's single tenant transaction.
      const result = await apiKeysRepo.create(user.user_id, name, source);
      const replaced = replacePrevious
        ? await apiKeysRepo.deleteReplacedCliKeys(user.user_id, name, result.key.id)
        : 0;
      console.log(
        `[API Keys] Created: ${result.key.prefix}... (${source}) for user ${shortId(user.user_id)}` +
          (replaced ? `, replaced ${replaced}` : '')
      );
      return { ...result, replaced };
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
      console.log(`[API Keys] Deleted: ${shortId(id)} for user ${shortId(user.user_id)}`);
      return { id };
    },
  };
}
