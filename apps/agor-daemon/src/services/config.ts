/**
 * Config Service
 *
 * Provides REST + WebSocket API for configuration management.
 * Wraps @agor/core/config functions for UI access.
 */

import {
  type AgorConfig,
  type ApiKeyName,
  loadConfig,
  resolveApiKey,
  saveConfig,
} from '@agor/core/config';
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
 * Mask API keys for secure display
 */
function maskApiKey(key: string | undefined): string | undefined {
  if (!key || typeof key !== 'string') return undefined;
  if (key.length <= 10) return '***';
  return `${key.substring(0, 10)}...`;
}

/**
 * Mask all credentials in config
 */
function maskCredentials(config: AgorConfig): AgorConfig {
  if (!config.credentials) return config;

  return {
    ...config,
    credentials: {
      ANTHROPIC_API_KEY: maskApiKey(config.credentials.ANTHROPIC_API_KEY),
      ANTHROPIC_AUTH_TOKEN: maskApiKey(config.credentials.ANTHROPIC_AUTH_TOKEN),
      ANTHROPIC_BASE_URL: config.credentials.ANTHROPIC_BASE_URL,
      OPENAI_API_KEY: maskApiKey(config.credentials.OPENAI_API_KEY),
      GEMINI_API_KEY: maskApiKey(config.credentials.GEMINI_API_KEY),
    },
  };
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
   * Get full config (masked)
   */
  async find(_params?: Params): Promise<AgorConfig> {
    const config = await loadConfig();
    return maskCredentials(config);
  }

  /**
   * Get specific config section or value
   */
  async get(id: string, _params?: Params): Promise<unknown> {
    const config = await loadConfig();
    const masked = maskCredentials(config);

    // Support dot notation (e.g., "credentials.ANTHROPIC_API_KEY")
    const parts = id.split('.');
    let value: unknown = masked;

    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = (value as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * Custom method: Resolve API key for a task
   *
   * This allows executors to request API key resolution without direct database access.
   * The service handles the precedence: user-level > config > env > native auth.
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
    source: 'user' | 'config' | 'env' | 'native';
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

    // Map KeyResolutionResult to service response type
    return {
      apiKey: result.apiKey ?? null,
      source: result.source === 'none' ? 'native' : result.source,
      useNativeAuth: result.useNativeAuth,
      ...(result.decryptionFailed && { decryptionFailed: true }),
    };
  }

  /**
   * Update config values
   *
   * SECURITY: Only allow updating credentials and opencode sections from UI
   */
  async patch(_id: null, data: Partial<AgorConfig>, _params?: Params): Promise<AgorConfig> {
    // Log patch keys without values to avoid leaking secrets
    const patchSections = Object.keys(data);
    const credentialKeys = data.credentials ? Object.keys(data.credentials) : [];
    console.log(
      `[Config Service] Patch received: sections=[${patchSections}] credential_keys=[${credentialKeys}]`
    );
    const config = await loadConfig();

    // Only allow updating credentials section for security
    if (data.credentials) {
      // Initialize credentials if not present
      if (!config.credentials) {
        config.credentials = {};
      }

      // Update or delete credential keys
      for (const [key, value] of Object.entries(data.credentials)) {
        if (value === undefined || value === null) {
          // Explicitly delete the key when value is undefined or null
          delete config.credentials[key as keyof typeof config.credentials];
        } else {
          // Set the key
          (config.credentials as Record<string, string>)[key] = value;
        }
      }
    }

    // Allow updating opencode configuration
    if (data.opencode) {
      // Initialize opencode if not present
      if (!config.opencode) {
        config.opencode = {};
      }

      // Update opencode settings
      if (data.opencode.enabled !== undefined) {
        config.opencode.enabled = data.opencode.enabled;
      }
      if (data.opencode.serverUrl !== undefined) {
        config.opencode.serverUrl = data.opencode.serverUrl;
      }
    }

    // Allow updating onboarding configuration
    if (data.onboarding) {
      if (!config.onboarding) {
        config.onboarding = {};
      }
      if (data.onboarding.assistantPending !== undefined) {
        config.onboarding.assistantPending = data.onboarding.assistantPending;
      }
      // Backward compat: also handle legacy field name
      if (data.onboarding.persistedAgentPending !== undefined) {
        config.onboarding.assistantPending = data.onboarding.persistedAgentPending;
      }
      if (data.onboarding.frameworkRepoUrl !== undefined) {
        config.onboarding.frameworkRepoUrl = data.onboarding.frameworkRepoUrl;
      }
    }

    await saveConfig(config);
    console.log('[Config Service] Config saved successfully');

    // Propagate credentials to process.env for hot-reload
    // Precedence rule: config.yaml (UI) > environment variables
    if (data.credentials) {
      for (const [key, value] of Object.entries(data.credentials)) {
        if (value === undefined || value === null) {
          // Delete from process.env if credential was cleared
          delete process.env[key];
        } else {
          // Update process.env (UI takes precedence)
          process.env[key] = value;
        }
      }
    }

    // Return masked config
    return maskCredentials(config);
  }
}

/**
 * Service factory function
 */
export function createConfigService(db: TenantScopeAwareDatabase): ConfigService {
  return new ConfigService(db);
}
