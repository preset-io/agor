/**
 * Service JWT Authentication Strategy
 *
 * Custom JWT strategy that handles both:
 * 1. Regular user JWTs (standard authentication flow)
 * 2. Service JWTs (for executor and internal service authentication)
 *
 * Service tokens have `sub: 'executor-service'` and `type: 'service'`.
 * Instead of looking up a user from the database, we return a synthetic
 * service user with elevated privileges.
 */

import { JWTStrategy } from '@agor/core/feathers';
import type { Params } from '@agor/core/types';

/**
 * Extended JWT Strategy that handles service tokens
 *
 * Service tokens are used by the executor to authenticate with the daemon
 * for privileged operations (unix.sync-*, git.*, etc.)
 */
export class ServiceJWTStrategy extends JWTStrategy {
  /**
   * Override getEntity to handle service tokens
   *
   * For service tokens (sub: 'executor-service'), return a synthetic user
   * instead of doing a database lookup.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Feathers type compatibility
  async getEntity(id: string, params: Params): Promise<any> {
    // Check if this is a service token
    if (id === 'executor-service') {
      return {
        user_id: 'executor-service',
        email: 'executor@agor.internal',
        role: 'service',
        // Mark as service account for hook checks
        _isServiceAccount: true,
      };
    }

    // Regular user token - use standard lookup
    return super.getEntity(id, params);
  }

  /**
   * Override authenticate to handle service tokens in the payload
   *
   * Service tokens have `type: 'service'` in the JWT payload.
   * We need to handle them specially to avoid the standard user lookup.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Feathers type compatibility
  async authenticate(authentication: any, params: any): Promise<any> {
    // Call parent to verify JWT signature and get payload
    const result = await super.authenticate(authentication, params);

    // Check if this is a service token by looking at the decoded payload
    const payload = result.authentication?.payload as { sub?: string; type?: string } | undefined;

    if (payload?.type === 'service' && payload?.sub === 'executor-service') {
      // Override user in result with service account
      return {
        ...result,
        user: {
          user_id: 'executor-service',
          email: 'executor@agor.internal',
          role: 'service',
          _isServiceAccount: true,
        },
      };
    }

    return result;
  }
}
