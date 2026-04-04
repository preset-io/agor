/**
 * API Key Authentication Strategy
 *
 * Authenticates requests using personal API keys (agor_sk_...).
 * Supports both Authorization: Bearer and X-API-Key headers.
 */

import type { UserApiKeysRepository } from '@agor/core/db';
import { AuthenticationBaseStrategy, NotAuthenticated } from '@agor/core/feathers';

export class ApiKeyStrategy extends AuthenticationBaseStrategy {
  private apiKeysRepo: UserApiKeysRepository | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: Feathers service type
  private usersService: any = null;

  // biome-ignore lint/suspicious/noExplicitAny: Feathers service type
  setDependencies(apiKeysRepo: UserApiKeysRepository, usersService: any) {
    this.apiKeysRepo = apiKeysRepo;
    this.usersService = usersService;
  }

  // biome-ignore lint/suspicious/noExplicitAny: Feathers type compatibility
  async authenticate(authentication: any, params: any): Promise<any> {
    if (!this.apiKeysRepo || !this.usersService) {
      throw new NotAuthenticated('ApiKeyStrategy not initialized');
    }

    const apiKey = authentication.apiKey;
    if (!apiKey || !apiKey.startsWith('agor_sk_')) {
      throw new NotAuthenticated('Invalid API key format');
    }

    // Verify key against stored hashes
    const keyRow = await this.apiKeysRepo.verifyKey(apiKey);
    if (!keyRow) {
      throw new NotAuthenticated('Invalid API key');
    }

    // Update last_used_at (non-blocking)
    this.apiKeysRepo.updateLastUsed(keyRow.id).catch((err: unknown) => {
      console.warn('Failed to update API key last_used_at:', err);
    });

    // Load the user
    const user = await this.usersService.get(keyRow.user_id);
    if (!user) {
      throw new NotAuthenticated('User not found for API key');
    }

    return {
      authentication: { strategy: 'api-key' },
      user,
    };
  }

  /**
   * Parse API key from request headers.
   * Supports:
   * - Authorization: Bearer agor_sk_...
   * - X-API-Key: agor_sk_...
   */
  // biome-ignore lint/suspicious/noExplicitAny: Feathers req type
  async parse(req: any): Promise<{ strategy: string; apiKey: string } | null> {
    // Check X-API-Key header first
    const xApiKey = req.headers?.['x-api-key'];
    if (xApiKey && typeof xApiKey === 'string' && xApiKey.startsWith('agor_sk_')) {
      return { strategy: 'api-key', apiKey: xApiKey };
    }

    // Check Authorization: Bearer header
    const authorization = req.headers?.authorization;
    if (authorization && typeof authorization === 'string') {
      const [scheme, token] = authorization.split(' ');
      if (scheme?.toLowerCase() === 'bearer' && token?.startsWith('agor_sk_')) {
        return { strategy: 'api-key', apiKey: token };
      }
    }

    return null;
  }
}
