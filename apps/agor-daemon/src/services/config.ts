/**
 * Config Service
 *
 * Narrow read-only runtime configuration resolver.
 *
 * This is not a config.yaml CRUD surface. It only resolves task-scoped
 * user/tenant credentials for trusted executors; deployment configuration is
 * operator-owned and immutable at runtime.
 */

import { TOOL_API_KEY_NAMES } from '@agor/agentic-tools';
import {
  type AgorConfig,
  type ApiKeyName,
  hasExactUserExecutorCredentialHome,
  resolveApiKey,
} from '@agor/core/config';
import { runWithTenantDatabaseScope, type TenantScopeAwareDatabase } from '@agor/core/db';
import { type Application, BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type {
  AgenticToolName,
  AuthenticatedParams,
  DeepReadonly,
  Params,
  TaskID,
  UserID,
} from '@agor/core/types';
import {
  authenticatedTaskExecutorRuntimeScope,
  matchesTaskExecutorRuntimeScope,
} from '../auth/executor-runtime-scope.js';
import {
  resolveExecutionCredentialHome,
  sameExecutionCredentialHome,
} from './credential-home-identity.js';

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

/**
 * Config service class
 */
export class ConfigService {
  private db: TenantScopeAwareDatabase;
  /** App reference injected after registration for cross-service calls */
  app?: Application;

  constructor(
    db: TenantScopeAwareDatabase,
    private readonly config: DeepReadonly<AgorConfig>
  ) {
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
    // user/API-key auth must not resolve raw configured keys. The former
    // general-purpose /config read endpoint no longer exists.
    const executorScope = authenticatedTaskExecutorRuntimeScope(params);
    const executorPrincipalUserId = (params as AuthenticatedParams | undefined)?.user?.user_id;
    if (params?.provider) {
      const caller = (params as AuthenticatedParams | undefined)?.user;
      const isServiceAccount = caller?._isServiceAccount === true;
      if (!isServiceAccount && !executorScope) {
        if (!caller) {
          throw new NotAuthenticated('Authentication required');
        }
        throw new Forbidden('Only executor runtime credentials may resolve API keys');
      }
      if (executorScope && executorScope.taskId !== taskId) {
        throw new Forbidden('Executor token task scope does not match this request');
      }
    }

    // Fetch task to get creator user ID and session. This is required for
    // executor-token calls and best-effort for internal/service-account calls.
    const internalParams: AuthenticatedParams = {
      provider: undefined,
      tenant: (params as AuthenticatedParams | undefined)?.tenant,
    };
    let userId: UserID | undefined;
    let sessionId: string | undefined;
    try {
      const tasksService = this.app?.service('tasks');
      if (tasksService) {
        const task = await tasksService.get(taskId, internalParams);
        userId = task?.created_by;
        sessionId = task?.session_id;
      }
    } catch (err) {
      console.warn(`[Config.resolveApiKey] Failed to fetch task ${taskId}:`, err);
      if (executorScope) {
        throw new Forbidden('Executor token task scope could not be verified');
      }
    }

    if (
      executorScope &&
      (!userId ||
        !sessionId ||
        executorPrincipalUserId !== userId ||
        !matchesTaskExecutorRuntimeScope(executorScope, {
          task_id: taskId,
          session_id: sessionId,
        }))
    ) {
      throw new Forbidden('Executor token task scope could not be verified');
    }

    // Executor runtime calls are narrowly scoped to the SDK for this session.
    // Do not let a compromised executor token ask for another tool's bucket or
    // an unrelated credential name.
    if (executorScope) {
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
      const session = await sessionsService.get(verifiedSessionId, internalParams);
      if (
        session?.agentic_tool !== tool ||
        (executorScope.branchId && executorScope.branchId !== session.branch_id)
      ) {
        throw new Forbidden('Executor token tool scope does not match this session');
      }
    }

    const result = await runWithTenantDatabaseScope(
      this.db,
      internalParams.tenant?.tenant_id,
      (tenantDb) => resolveApiKey(keyName, { userId, db: tenantDb, tool })
    );
    if (result.useNativeAuth) {
      if (
        this.config.multi_tenancy?.mode === 'required_from_auth' &&
        !(tool === 'codex' && hasExactUserExecutorCredentialHome(this.config))
      ) {
        throw new BadRequest(
          'Shared machine subscription authentication is unavailable in hosted multitenant mode'
        );
      }
      await this.assertNativeAuthHomeMatchesSession(tool, userId, sessionId, internalParams);
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

  /**
   * Native auth resolves from the task creator, while the filesystem sandbox
   * mounts the session owner's home. Refuse a mismatch rather than borrowing
   * the owner's credential or silently missing the prompter's login.
   */
  private async assertNativeAuthHomeMatchesSession(
    tool: AgenticToolName | undefined,
    promptingUserId: UserID | undefined,
    sessionId: string | undefined,
    internalParams: AuthenticatedParams
  ): Promise<void> {
    if (!promptingUserId) return;

    const tenantId = internalParams.tenant?.tenant_id;
    const homeOf = (userId: UserID) =>
      resolveExecutionCredentialHome({
        userId,
        tenantId,
        config: this.config,
        withTenantDatabase: (work) => runWithTenantDatabaseScope(this.db, tenantId, work),
      });
    const requireCanonicalCodexHome = tool === 'codex' && this.config.deployment?.mode === 'ha';
    let prompterHome = requireCanonicalCodexHome ? await homeOf(promptingUserId) : undefined;
    if (prompterHome?.homeStoreSource === 'override') {
      throw new BadRequest(
        'HA Codex subscription auth requires Agor’s canonical tenant/user home. ' +
          'Remove the filesystem_home override for this account or use an API key.'
      );
    }

    if (!sessionId) return;
    const sessionsService = this.app?.service('sessions');
    if (!sessionsService) return;
    const session = (await sessionsService.get(sessionId, internalParams)) as
      | { created_by?: string; sdk_home_scope?: 'execution_home' | 'branch' }
      | undefined;
    // A branch-scoped Session deliberately selects the immutable prompt actor's
    // per-user home and overlays that actor's pinned Codex auth inode. The
    // executor principal was already proven equal to Task.created_by above, so
    // comparing it with the Session owner would reject the intended
    // collaborator path. Execution-home Sessions retain the historical owner
    // home and therefore still require the comparison below.
    if (tool === 'codex' && session?.sdk_home_scope === 'branch') return;
    const ownerUserId = session?.created_by;
    if (!ownerUserId || ownerUserId === promptingUserId) return;

    prompterHome ??= await homeOf(promptingUserId);
    const ownerHome = await homeOf(ownerUserId as UserID);
    if (requireCanonicalCodexHome && ownerHome.homeStoreSource === 'override') {
      throw new BadRequest(
        'HA Codex subscription auth requires the session owner’s canonical tenant/user home. ' +
          'Remove the filesystem_home override or use an API key.'
      );
    }
    if (sameExecutionCredentialHome(prompterHome, ownerHome)) return;

    throw new Forbidden(
      'Subscription sign-in belongs to a different execution home than this session runs in. ' +
        "The session executes in its owner's home, so the prompting user's on-disk login is not " +
        'visible to it. Prompt a session you own, or configure an API key.'
    );
  }
}

/**
 * Service factory function
 */
export function createConfigService(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>
): ConfigService {
  return new ConfigService(db, config);
}
