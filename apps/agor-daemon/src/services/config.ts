/**
 * Config Service
 *
 * Provides REST + WebSocket API for configuration management.
 * Wraps @agor/core/config functions for UI access.
 */

import { type ApiKeyName, loadConfig, resolveApiKey } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { type Application, BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import {
  type AgenticToolName,
  type AuthenticatedParams,
  type Params,
  type TaskID,
  TOOL_API_KEY_NAMES,
  type UserID,
} from '@agor/core/types';
import jwt from 'jsonwebtoken';
import type { SessionTokenService } from './session-token-service.js';

const RESOLVABLE_API_KEY_NAMES: Record<ApiKeyName, true> = {
  ANTHROPIC_API_KEY: true,
  ANTHROPIC_AUTH_TOKEN: true,
  CLAUDE_CODE_OAUTH_TOKEN: true,
  OPENAI_API_KEY: true,
  GEMINI_API_KEY: true,
  COPILOT_GITHUB_TOKEN: true,
  CURSOR_API_KEY: true,
};

function isResolvableApiKeyName(value: string): value is ApiKeyName {
  return Object.hasOwn(RESOLVABLE_API_KEY_NAMES, value);
}

type ExecutorTokenPayload = {
  type?: string;
  purpose?: string;
  session_id?: string;
  sessionId?: string;
  task_id?: string;
  branch_id?: string;
};

function getExecutorTokenPayload(params?: Params): ExecutorTokenPayload | undefined {
  const authParams = params as
    | (AuthenticatedParams & { task_id?: string; authentication?: { strategy?: string } })
    | undefined;
  const payload = authParams?.authentication?.payload as ExecutorTokenPayload | undefined;
  if (payload?.type === 'executor-session' && payload.purpose === 'executor-task') {
    return payload;
  }

  // Feathers transports do not consistently preserve the decoded JWT payload
  // on params.authentication. The token was already verified by requireAuth
  // before this service method runs, so decoding here is only to recover
  // trusted scope claims for executor-session JWTs.
  const accessToken = (params as AuthenticatedParams | undefined)?.authentication?.accessToken;
  if (typeof accessToken === 'string') {
    const decoded = jwt.decode(accessToken) as ExecutorTokenPayload | null;
    if (decoded?.type === 'executor-session' && decoded.purpose === 'executor-task') {
      return decoded;
    }
  }

  // Socket.io executor logins may preserve auth-result scope fields on the
  // connection even when the decoded JWT payload is not carried forward into
  // later service params. Keep the secret resolver restricted to task-scoped
  // executor JWTs by only accepting this fallback for JWT-authenticated
  // connections that have a task claim minted by ServiceJWTStrategy.
  if (authParams?.authentication?.strategy === 'jwt' && authParams.task_id) {
    const scopedParams = params as
      | (Params & { session_id?: string; sessionId?: string; task_id?: string; branch_id?: string })
      | undefined;
    return {
      type: 'executor-session',
      purpose: 'executor-task',
      task_id: authParams.task_id,
      session_id: scopedParams?.session_id,
      sessionId: scopedParams?.sessionId,
      branch_id: scopedParams?.branch_id,
    };
  }

  return undefined;
}

/**
 * Config service class
 */
export class ConfigService {
  private db: TenantScopeAwareDatabase;
  /** App reference injected after registration for cross-service calls */
  app?: Application;

  constructor(db: TenantScopeAwareDatabase) {
    this.db = db;
  }

  /**
   * Custom method: Resolve API key for a task
   *
   * This allows executors to request API key resolution without direct database access.
   * The service follows the tenant's explicit user/workspace resolution policy.
   *
   * Called via: client.service('config/resolve-api-key').create({ taskId, keyName })
   */
  async resolveApiKey(
    data: {
      taskId: TaskID;
      keyName: string;
      /**
       * Restrict the per-user lookup to this tool's credential bucket. Executors
       * always pass this; absent it, the resolver falls back to a cross-tool
       * sweep (legacy behavior preserved for non-SDK callers).
       */
      tool?: AgenticToolName;
      /**
       * Explicit task-scoped executor JWT proof. The Socket.io connection can
       * authenticate as the session creator user while dropping custom JWT
       * claims from later service params, so executors include the minted token
       * on this secret-resolution call and the daemon validates it against the
       * in-memory session-token registry.
       */
      executorSessionToken?: string;
    },
    params?: Params
  ): Promise<{
    apiKey: string | null;
    connection?: Record<string, string>;
    source: 'user' | 'tenant' | 'none';
    useNativeAuth: boolean;
    decryptionFailed?: boolean;
  }> {
    const { taskId, keyName, tool } = data;
    if (!isResolvableApiKeyName(keyName)) {
      throw new BadRequest('Unsupported API key name');
    }

    // This method returns plaintext secret material and is only for trusted
    // daemon/executor flows. External callers must authenticate either as the
    // service account or with a task-scoped executor runtime JWT. Normal
    // user/API-key auth may read masked config via /config but must not resolve
    // raw configured keys.
    let executorPayload = getExecutorTokenPayload(params);
    if (!executorPayload && params?.provider && data.executorSessionToken) {
      const sessionTokenService = (
        this.app as unknown as {
          sessionTokenService?: SessionTokenService;
        }
      )?.sessionTokenService;
      const sessionInfo = await sessionTokenService?.validateToken(data.executorSessionToken, {
        taskId,
      });
      if (sessionInfo?.task_id === taskId) {
        executorPayload = {
          type: 'executor-session',
          purpose: 'executor-task',
          task_id: sessionInfo.task_id,
        };
      }
    }
    if (params?.provider) {
      const caller = (params as AuthenticatedParams | undefined)?.user;
      const isServiceAccount = caller?._isServiceAccount === true;
      if (!isServiceAccount && !executorPayload) {
        if (!caller) {
          throw new NotAuthenticated('Authentication required');
        }
        throw new Forbidden('Only executor runtime credentials may resolve API keys');
      }
      if (executorPayload?.task_id && executorPayload.task_id !== taskId) {
        throw new Forbidden('Executor token task scope does not match this request');
      }
    }

    // Fetch task to get creator user ID and session. This is required for
    // executor-token calls and best-effort for internal/service-account calls.
    let userId: UserID | undefined;
    let sessionId: string | undefined;
    try {
      const tasksService = this.app?.service('tasks');
      if (tasksService) {
        const task = await tasksService.get(taskId, { provider: undefined });
        userId = task?.created_by;
        sessionId = task?.session_id;
      }
    } catch (err) {
      console.warn(`[Config.resolveApiKey] Failed to fetch task ${taskId}:`, err);
      if (executorPayload) {
        throw new Forbidden('Executor token task scope could not be verified');
      }
    }

    if (executorPayload && (!userId || !sessionId)) {
      throw new Forbidden('Executor token task scope could not be verified');
    }

    // Executor runtime calls are narrowly scoped to the SDK for this session.
    // Do not let a compromised executor token ask for another tool's bucket or
    // an unrelated credential name.
    if (executorPayload) {
      const verifiedSessionId = sessionId;
      if (!verifiedSessionId) {
        throw new Forbidden('Executor token task scope could not be verified');
      }
      if (!tool) {
        throw new BadRequest('Tool is required for executor API key resolution');
      }
      const expectedKeyName = TOOL_API_KEY_NAMES[tool];
      if (!expectedKeyName || expectedKeyName !== keyName) {
        throw new Forbidden('Executor token is not valid for this API key');
      }
      const sessionsService = this.app?.service('sessions');
      if (!sessionsService) {
        throw new Forbidden('Executor token tool scope could not be verified');
      }
      const session = await sessionsService.get(verifiedSessionId, { provider: undefined });
      if (session?.agentic_tool !== tool) {
        throw new Forbidden('Executor token tool scope does not match this session');
      }
    }

    // Use core resolveApiKey with database access
    const result = await resolveApiKey(keyName, {
      userId,
      db: this.db,
      tool,
    });
    if (result.useNativeAuth) {
      const config = await loadConfig();
      if (config.multi_tenancy?.mode === 'required_from_auth') {
        throw new BadRequest(
          'Shared machine subscription authentication is unavailable in hosted multitenant mode'
        );
      }
    }

    // Map KeyResolutionResult to service response type
    return {
      apiKey: result.apiKey ?? null,
      connection: result.connection as Record<string, string> | undefined,
      source: result.source,
      useNativeAuth: result.useNativeAuth,
      ...(result.decryptionFailed && { decryptionFailed: true }),
    };
  }
}

/**
 * Service factory function
 */
export function createConfigService(db: TenantScopeAwareDatabase): ConfigService {
  return new ConfigService(db);
}
