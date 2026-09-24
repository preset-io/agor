/**
 * API Key Authentication Strategy
 *
 * Authenticates requests using personal API keys (agor_sk_...).
 * Supports both Authorization: Bearer and X-API-Key headers.
 */

import type { UserApiKeysRepository } from '@agor/core/db';
import { AuthenticationBaseStrategy, NotAuthenticated } from '@agor/core/feathers';
import { isUserApiKeySource, PERSONAL_API_KEY_PREFIX } from '@agor/core/types';
import { markAuthenticationUserLookup } from '../services/users.js';
import { isSocketIoHandshakeRequest } from './socket-handshake-request.js';

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
    if (!apiKey?.startsWith(PERSONAL_API_KEY_PREFIX)) {
      throw new NotAuthenticated('Invalid API key format');
    }

    // Verify key against stored hashes
    const keyRow = await this.apiKeysRepo.verifyKey(apiKey);
    if (!keyRow) {
      throw new NotAuthenticated('Invalid API key');
    }

    // Tenant RLS already confines verifyKey to the request tenant; also refuse
    // explicitly so key/tenant agreement never rests on a policy alone.
    const requestTenantId = params?.tenant?.tenant_id as string | undefined;
    const keyTenantId = (keyRow as { tenant_id?: unknown }).tenant_id;
    if (requestTenantId && typeof keyTenantId === 'string' && keyTenantId !== requestTenantId) {
      throw new NotAuthenticated('Invalid API key');
    }

    // Update last_used_at (non-blocking)
    this.apiKeysRepo.updateLastUsed(keyRow.id).catch((err: unknown) => {
      console.warn('Failed to update API key last_used_at:', err);
    });

    // Browser-token issuance needs backend-only credential metadata. Preserve
    // the already-resolved tenant context while marking this one lookup as an
    // internal authentication read; ordinary external user reads stay redacted.
    markAuthenticationUserLookup(params);
    const user = await this.usersService.get(keyRow.user_id, params);
    if (!user) {
      throw new NotAuthenticated('User not found for API key');
    }
    const userTenantId = (user as { tenant_id?: unknown }).tenant_id;
    if (requestTenantId && typeof userTenantId === 'string' && userTenantId !== requestTenantId) {
      throw new NotAuthenticated('Invalid API key');
    }

    return {
      // Non-secret key identity so the caller can manage its own credential
      // (e.g. `agor logout` deleting the key a CLI login minted).
      authentication: {
        strategy: 'api-key',
        api_key_id: keyRow.id,
        api_key_source: isUserApiKeySource(keyRow.source) ? keyRow.source : 'manual',
      },
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
    if (isSocketIoHandshakeRequest(req)) return null;

    // Check X-API-Key header first
    const xApiKey = req.headers?.['x-api-key'];
    if (xApiKey && typeof xApiKey === 'string' && xApiKey.startsWith(PERSONAL_API_KEY_PREFIX)) {
      return { strategy: 'api-key', apiKey: xApiKey };
    }

    // Check Authorization: Bearer header
    const authorization = req.headers?.authorization;
    if (authorization && typeof authorization === 'string') {
      const [scheme, token] = authorization.split(' ');
      if (scheme?.toLowerCase() === 'bearer' && token?.startsWith(PERSONAL_API_KEY_PREFIX)) {
        return { strategy: 'api-key', apiKey: token };
      }
    }

    return null;
  }
}
