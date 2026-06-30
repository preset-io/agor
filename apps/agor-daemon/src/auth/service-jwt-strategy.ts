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
import type { Params, UserAuthMetadata } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import type { SessionTokenService } from '../services/session-token-service.js';
import { markAuthenticationUserLookup } from '../services/users.js';
import { readRuntimeTenantClaim } from './runtime-tokens.js';
import { assertUserTokenNotInvalidated, type UserAuthTokenPayload } from './token-invalidation.js';

type JwtConnectionState = {
  authentication?: { strategy?: string; accessToken?: string; payload?: unknown };
  feathers?: { authentication?: { strategy?: string; accessToken?: string; payload?: unknown } };
};

function persistExecutorJwtPayloadOnConnection(
  params: unknown,
  accessToken: string | undefined,
  payload: unknown
): void {
  const connection = (params as { connection?: JwtConnectionState } | undefined)?.connection;
  if (!connection) return;

  // For Socket.io, Feathers service params are built from the per-socket
  // `feathers` connection object on subsequent calls. Depending on the call
  // path, `params.connection` may be that object directly, or the socket-like
  // wrapper that owns it. Persist the decoded executor JWT payload in whichever
  // object will become future `params.authentication`, otherwise the executor
  // reconnects as the session creator user but loses the task-scoped claims.
  let target: JwtConnectionState;
  if ('feathers' in connection) {
    connection.feathers ??= {};
    target = connection.feathers;
  } else {
    target = connection;
  }
  target.authentication = {
    ...(target.authentication ?? {}),
    strategy: 'jwt',
    ...(accessToken ? { accessToken } : {}),
    payload,
  };
}

function propagateTenantFromJwtPayload(
  params: Params,
  payload: UserAuthTokenPayload | null | undefined,
  tenantClaim?: string
): void {
  const tenantId = readRuntimeTenantClaim(payload ?? undefined, tenantClaim);
  if (!tenantId) return;
  const tenantParams = params as Params & {
    tenant?: { tenant_id: string; source: 'auth_claim' };
  };
  tenantParams.tenant ??= { tenant_id: tenantId, source: 'auth_claim' };
}

/**
 * Extended JWT Strategy that handles service tokens
 *
 * Service tokens are used by the executor to authenticate with the daemon
 * for privileged operations (unix.sync-*, git.*, etc.)
 */
export class ServiceJWTStrategy extends JWTStrategy {
  constructor(
    private sessionTokenService?: SessionTokenService,
    private tenantClaim?: string
  ) {
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

    // Regular user token validation needs backend-only auth metadata. In
    // required_from_auth mode the Users service is tenant-scoped, so propagate
    // the tenant claim from the already-verified JWT payload before the
    // strategy asks the service to load the user entity.
    propagateTenantFromJwtPayload(
      params,
      (params.authentication as { payload?: UserAuthTokenPayload } | undefined)?.payload,
      this.tenantClaim
    );

    markAuthenticationUserLookup(params);
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
    const decoded = jwt.decode(authentication?.accessToken) as UserAuthTokenPayload | null;
    propagateTenantFromJwtPayload(params, decoded, this.tenantClaim);

    // Call parent to verify JWT signature and get payload
    const result = (await super.authenticate(authentication, params)) as {
      accessToken?: string;
      authentication?: { payload?: unknown };
      user?: UserAuthMetadata;
      [key: string]: unknown;
    };

    // Check if this is a service token by looking at the decoded payload
    const payload = result.authentication?.payload as
      | (UserAuthTokenPayload & {
          session_id?: string;
          sessionId?: string;
          task_id?: string;
          branch_id?: string;
          purpose?: string;
        })
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
      persistExecutorJwtPayloadOnConnection(params, token, payload);
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

    if (result.user) {
      assertUserTokenNotInvalidated(result.user, payload);
    }

    return result;
  }
}
