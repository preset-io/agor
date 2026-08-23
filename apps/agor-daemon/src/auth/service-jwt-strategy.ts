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

import type { ResolvedMultiTenancyConfig } from '@agor/core/config';
import { JWTStrategy, NotAuthenticated } from '@agor/core/feathers';
import type { Params, UserAuthMetadata } from '@agor/core/types';
import {
  fingerprintExecutorSessionToken,
  type SessionTokenService,
} from '../services/session-token-service.js';
import { markAuthenticationUserLookup } from '../services/users.js';
import {
  finalizeAuthenticatedConnectionAuthority,
  retireAuthenticatedConnectionAuthority,
} from './authenticated-connection-authority.js';
import {
  attachExecutorConnectionCapabilityCandidate,
  type ExecutorConnectionRevocationFence,
} from './executor-connection-capability.js';
import {
  getExecutorSessionTokenSessionId,
  isExecutorSessionTokenPayload,
} from './executor-session-token.js';
import { readRuntimeTenantClaim } from './runtime-tokens.js';
import { isSocketIoHandshakeRequest } from './socket-handshake-request.js';
import { assertUserTokenNotInvalidated, type UserAuthTokenPayload } from './token-invalidation.js';

type ConnectionEvent = Parameters<JWTStrategy['handleConnection']>[0];
type AuthenticationResult = NonNullable<Parameters<JWTStrategy['handleConnection']>[2]>;

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

export interface ServiceJWTStrategyOptions {
  sessionTokenService?: SessionTokenService;
  multiTenancy?: ResolvedMultiTenancyConfig;
  executorRevocationFence?: ExecutorConnectionRevocationFence;
}

/**
 * Extended JWT Strategy that handles service tokens
 *
 * Service tokens are used by the executor to authenticate with the daemon
 * for privileged executor operations (git.*, etc.)
 */
export class ServiceJWTStrategy extends JWTStrategy {
  private readonly sessionTokenService?: SessionTokenService;
  private readonly tenantClaim: string;
  private readonly executorRevocationFence?: ExecutorConnectionRevocationFence;
  private readonly multiTenancy?: ResolvedMultiTenancyConfig;

  constructor(options: ServiceJWTStrategyOptions = {}) {
    super();
    this.sessionTokenService = options.sessionTokenService;
    this.multiTenancy = options.multiTenancy;
    this.tenantClaim = options.multiTenancy?.auth_claim ?? 'tenant_id';
    this.executorRevocationFence = options.executorRevocationFence;
  }

  /**
   * The Socket.IO namespace owns handshake authentication and normalizes both
   * auth-object and Authorization-header failures. Do not let Feathers' earlier
   * header middleware perform a second login that stores the raw bearer and
   * installs the base JWT strategy's expiry timer.
   */
  override async parse(req: Parameters<JWTStrategy['parse']>[0]) {
    if (isSocketIoHandshakeRequest(req)) return null;
    return super.parse(req);
  }

  /**
   * Finalize trusted connection authority before Feathers emits `login`.
   *
   * AuthenticationService awaits every strategy's handleConnection hook before
   * publishing the login event or acknowledging the request. Installing the
   * immutable Feathers identity projection, tenant, and executor capability
   * here makes all later channel/request consumers independent of Socket.IO
   * listener registration order. The base JWT handler is intentionally not
   * called: it would retain raw bearer material and re-arm bearer expiry as a
   * live-connection expiry.
   */
  override async handleConnection(
    event: ConnectionEvent,
    connection: unknown,
    authResult?: AuthenticationResult
  ): Promise<void> {
    const app = this.app;
    if (!app) throw new Error('Authentication strategy is not attached to an application');
    if (event === 'login' && authResult) {
      if (!connection || typeof connection !== 'object') {
        throw new Error('Authenticated connection is unavailable');
      }
      finalizeAuthenticatedConnectionAuthority({
        connection,
        authResult,
        multiTenancy: this.multiTenancy,
        executorRevocationFence: this.executorRevocationFence,
      });
      return;
    }

    if (event === 'logout' || event === 'disconnect') {
      retireAuthenticatedConnectionAuthority(app, connection);
      if (event === 'logout') app.emit('disconnect', connection);
    }
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

  /** The reserved subject is not authority unless the verified type is service. */
  // biome-ignore lint/suspicious/noExplicitAny: Feathers auth result compatibility
  async getEntityId(authResult: any, params: Params): Promise<string> {
    const payload = authResult?.authentication?.payload as UserAuthTokenPayload | undefined;
    // getEntityId runs only after JWTStrategy has verified the signature. Set
    // tenant context here—before getEntity's tenant-scoped user lookup—rather
    // than trusting `jwt.decode()` in authenticate.
    propagateTenantFromJwtPayload(params, payload, this.tenantClaim);
    if (payload?.sub === 'executor-service' && payload.type !== 'service') {
      // getEntityId runs after signature verification and before getEntity.
      // Reject here so an access token using the reserved subject can never be
      // materialized as the synthetic RBAC-bypassing service user.
      throw new Error('Reserved service subject requires a service token');
    }
    return super.getEntityId(authResult, params);
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
          terminal_user_id?: string;
          terminal_id?: string;
          terminal_branch_id?: string;
          terminal_owner_boot_id?: string;
        })
      | undefined;

    if (payload?.type === 'service' && payload?.sub === 'executor-service') {
      if (payload.purpose !== undefined && payload.purpose !== 'executor-service') {
        throw new Error('Invalid service token purpose');
      }
      const terminalUserId =
        typeof payload.terminal_user_id === 'string' ? payload.terminal_user_id : undefined;
      // A terminal-scoped token is a RESTRICTED identity: it authenticates the
      // web-terminal executor's socket for its OWN user's terminal channel
      // only. It must NOT be a full service account — `_isServiceAccount` and
      // `role: 'service'` bypass RBAC across REST/Feathers paths (see
      // register-hooks / board-owners / branch-owners / sessions /
      // mcp-token-authorization), and the terminal executor makes no such
      // calls. So we mint a low-privilege identity that carries no bypass
      // anywhere; the socket terminal handlers enforce it via terminal_user_id.
      if (terminalUserId) {
        return {
          ...result,
          user: {
            user_id: 'executor-service',
            email: 'executor@agor.internal',
            role: 'terminal-executor',
            _isTerminalExecutor: true,
            terminal_user_id: terminalUserId,
            terminal_id: payload.terminal_id,
            terminal_branch_id: payload.terminal_branch_id,
            terminal_owner_boot_id: payload.terminal_owner_boot_id,
          },
        };
      }
      // Full service account (git/prompt/etc. executor paths).
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

    if (payload?.type === 'service') {
      throw new NotAuthenticated('Service tokens require the reserved service subject');
    }

    if (payload?.type === 'executor-session') {
      if (!isExecutorSessionTokenPayload(payload)) {
        throw new Error('Invalid executor token purpose');
      }
      const token = authentication?.accessToken;
      if (!token || !this.sessionTokenService) {
        throw new Error('Executor token validation unavailable');
      }
      const sessionId = getExecutorSessionTokenSessionId(payload);
      if (!sessionId || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
        throw new Error('Executor token is missing durable connection scope');
      }
      const tenantId = readRuntimeTenantClaim(payload, this.tenantClaim);
      const revocationSnapshot = this.executorRevocationFence?.snapshot(tenantId);
      const sessionInfo = await this.sessionTokenService.validateToken(token, {
        tenantId,
        userId: typeof payload.sub === 'string' ? payload.sub : undefined,
        sessionId,
        taskId: payload.task_id,
        branchId: payload.branch_id,
      });
      if (!sessionInfo) {
        throw new Error('Invalid or expired executor token');
      }
      const executorResult = {
        ...result,
        session_id: sessionInfo.session_id,
        task_id: sessionInfo.task_id,
        branch_id: sessionInfo.branch_id,
      };
      if (revocationSnapshot) {
        attachExecutorConnectionCapabilityCandidate(executorResult, {
          ...(tenantId ? { tenantId } : {}),
          sessionId: sessionInfo.session_id,
          ...(sessionInfo.task_id ? { taskId: sessionInfo.task_id } : {}),
          ...(sessionInfo.branch_id ? { branchId: sessionInfo.branch_id } : {}),
          expiresAt: payload.exp * 1000,
          tokenFingerprint: fingerprintExecutorSessionToken(token),
          revocationSnapshot,
        });
      }
      return executorResult;
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
