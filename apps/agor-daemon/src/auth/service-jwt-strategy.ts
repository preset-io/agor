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
import type { SessionTokenService } from '../services/session-token-service.js';

/**
 * Extended JWT Strategy that handles service tokens
 *
 * Service tokens are used by the executor to authenticate with the daemon
 * for privileged operations (unix.sync-*, git.*, etc.)
 */
export class ServiceJWTStrategy extends JWTStrategy {
  constructor(private sessionTokenService?: SessionTokenService) {
    super();
  }
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
    const payload = result.authentication?.payload as
      | {
          sub?: string;
          type?: string;
          session_id?: string;
          sessionId?: string;
          task_id?: string;
          branch_id?: string;
          purpose?: string;
        }
      | undefined;

    if (payload?.type === 'service' && payload?.sub === 'executor-service') {
      if (payload.purpose !== undefined && payload.purpose !== 'executor-service') {
        throw new Error('Invalid service token purpose');
      }
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

    if (payload?.type === 'executor-session') {
      if (payload.purpose !== 'executor-task') {
        throw new Error('Invalid executor token purpose');
      }
      const token = authentication?.accessToken;
      if (!token || !this.sessionTokenService) {
        throw new Error('Executor token validation unavailable');
      }
      const sessionId = payload.session_id ?? payload.sessionId;
      const sessionInfo = await this.sessionTokenService.validateToken(token, {
        sessionId,
        taskId: payload.task_id,
        branchId: payload.branch_id,
      });
      if (!sessionInfo) {
        throw new Error('Invalid or expired executor token');
      }
      return {
        ...result,
        session_id: sessionInfo.session_id,
        task_id: sessionInfo.task_id,
        branch_id: sessionInfo.branch_id,
      };
    }

    if (
      payload?.type !== undefined &&
      !['access', 'service', 'executor-session'].includes(payload.type)
    ) {
      throw new Error('JWT type is not valid for daemon API authentication');
    }

    return result;
  }
}
