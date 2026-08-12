/**
 * Service Registration
 *
 * Registers all FeathersJS services on the app instance.
 * Extracted from index.ts for maintainability.
 */

import { homedir } from 'node:os';
import { OPENCODE_DAEMON_CONTRIBUTION } from '@agor/agentic-tool-opencode/daemon';

import {
  type AgorConfig,
  isDeploymentAgenticToolAvailable,
  PublicBaseUrlNotConfiguredError,
  type ResolvedDeploymentConfig,
  requirePublicBaseUrl,
  resolveDeploymentAgenticToolPolicy,
  resolveExecutionSecurityMode,
  resolveMultiTenancyConfig,
} from '@agor/core/config';
import {
  and,
  BoardRepository,
  BranchRepository,
  eq,
  GatewayChannelRepository,
  generateId,
  getCurrentTenantId,
  inArray,
  isPostgresDatabaseHandle,
  type MCPOAuthPendingFlowRecord,
  MCPServerRepository,
  mcpServers,
  runWithoutTenantDatabaseScope,
  runWithTenantDatabaseScope,
  SessionMCPServerRepository,
  SessionRepository,
  select,
  sessionMcpServers,
  sessions,
  shortId,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
  visibleSessionReferenceAccessExists,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type {
  OAuthFlowContext,
  OAuthTokenResponse,
} from '@agor/core/tools/mcp/oauth-mcp-transport';
import type {
  AuthenticatedParams,
  HookContext,
  MCPAuth,
  MCPOAuthAttemptID,
  MCPOAuthDCRMode,
  MCPOAuthPendingFlowStatus,
  MCPServer,
  MCPServerID,
  MessageSource,
  Params,
  SessionID,
  UserID,
  UUID,
} from '@agor/core/types';
import { hasMinimumRole, isMCPOAuthGrantBindingVersion, ROLES, TaskStatus } from '@agor/core/types';
import type { UnixUserMode } from '@agor/core/unix';
import { safeOutboundFetch } from '@agor/core/utils/safe-outbound-fetch';
import type express from 'express';
import type {
  BoardsServiceImpl,
  MessagesServiceImpl,
  SessionsServiceImpl,
  TasksServiceImpl,
} from './declarations.js';
import {
  containExecutorProcess,
  markExecutorProcessExited,
  retainExecutorContainmentFence,
  trackExecutorProcess,
} from './executor-tracking.js';
import { assertHaTaskPermissionSupported, isConstrainedHa } from './ha-support.js';
import { shouldRegisterLocalHostOperations } from './host/availability.js';
import { createLocalDaemonHostOperations } from './host/local/local-daemon-host-operations.js';
import { registerOpenCodeServices } from './integrations/opencode/index.js';
import {
  inOpenCodeNativeStateMutationSlot,
  type OpenCodeNativeStateMutationFence,
} from './integrations/opencode/native-state-coordinator.js';
import { runInOAuthTenantScope, runInOAuthTenantWriteScope } from './oauth-auth-helpers.js';
import { persistOAuthToken } from './oauth-cache.js';
import {
  emitHaNativeSocketEvent,
  tenantChannelName,
  tenantUserChannelName,
} from './realtime/routing.js';
import { createAgenticToolPresetsService } from './services/agentic-tool-presets.js';
import {
  ARTIFACTS_SERVICE_TRANSPORT_METHODS,
  createArtifactsService,
} from './services/artifacts.js';
import { createBoardCommentsService } from './services/board-comments.js';
import { createBoardObjectsService } from './services/board-objects.js';
import { setupBoardOwnersService } from './services/board-owners.js';
import { createBoardsService } from './services/boards.js';
import { setupBranchOwnersService } from './services/branch-owners.js';
import { createBranchesService } from './services/branches.js';
import { createCardTypesService } from './services/card-types.js';
import { createCardsService } from './services/cards.js';
import { createCheckAuthService } from './services/check-auth.js';
import { createClaudeModelsService } from './services/claude-models.js';
import { createCodexAuthImportService } from './services/codex-auth-import.js';
import { createCodexAuthLogoutService } from './services/codex-auth-logout.js';
import { createCodexDeviceAuthService } from './services/codex-device-auth.js';
import { createConfigService } from './services/config.js';
import { createCopilotModelsService } from './services/copilot-models.js';
import { createCursorModelsService } from './services/cursor-models.js';
import { prepareSessionForExecutorStart } from './services/executor-startup.js';
import { createFileService } from './services/file.js';
import { createFilesService } from './services/files.js';
import { createGatewayService } from './services/gateway.js';
import {
  createGatewayChannelsService,
  GATEWAY_CHANNELS_SERVICE_TRANSPORT_METHODS,
} from './services/gateway-channels.js';
import { createGatewayChannelsAppInfoService } from './services/gateway-channels-app-info.js';
import { createGatewayChannelsTestService } from './services/gateway-channels-test.js';
import { registerGitHubAppSetupRoutes } from './services/github-app-setup.js';
import {
  createGroupMembershipsService,
  createGroupsService,
  GROUPS_SERVICE_TRANSPORT_METHODS,
  setupBoardAlignedBranchesService,
  setupBoardGroupGrantsService,
  setupBranchEffectiveAccessService,
  setupBranchFsAccessUsersService,
  setupBranchGroupGrantsService,
} from './services/groups.js';
import { createKnowledgeDocumentEditsService } from './services/knowledge-document-edits.js';
import { createKnowledgeDocumentsService } from './services/knowledge-documents.js';
import {
  createKnowledgeGraphService,
  KNOWLEDGE_GRAPH_SERVICE_TRANSPORT_METHODS,
} from './services/knowledge-graph.js';
import { createKnowledgeIndexingStatusService } from './services/knowledge-indexing.js';
import { createKnowledgeNamespacesService } from './services/knowledge-namespaces.js';
import { createKnowledgeReindexService } from './services/knowledge-reindex.js';
import { createKnowledgeSearchService } from './services/knowledge-search.js';
import { createKnowledgeSettingsService } from './services/knowledge-settings.js';
import { createKnowledgeVersionsService } from './services/knowledge-versions.js';
import { createLeaderboardService } from './services/leaderboard.js';
import { createLocalActionsService } from './services/local-actions.js';
import { createMCPCatalogService } from './services/mcp-catalog.js';
import {
  classifyMCPOAuthCompletionFailure,
  OAuthFlowAuthorizationChangedError,
} from './services/mcp-oauth-exchange-classification.js';
import {
  fingerprintMCPOAuthGrantConfiguration,
  hasMCPOAuthRelevantServerConfigurationChanged,
  isMCPOAuthGrantBoundToServer,
  lockMCPOAuthGrantConfiguration,
} from './services/mcp-oauth-grant-binding.js';
import { MCPOAuthPendingFlowAuthority } from './services/mcp-oauth-pending-flow-authority.js';
import { resolveAuthenticatedServerIds } from './services/mcp-oauth-status.js';
import { createMCPServersService } from './services/mcp-servers.js';
import { createMessagesService, MESSAGES_SERVICE_TRANSPORT_METHODS } from './services/messages.js';
import { performOAuthDisconnect } from './services/oauth-disconnect.js';
import { createReposService } from './services/repos.js';
import {
  createSchedulesService,
  SCHEDULES_SERVICE_TRANSPORT_METHODS,
} from './services/schedules.js';
import { createSessionEnvSelectionsService } from './services/session-env-selections.js';
import { createSessionMCPServersService } from './services/session-mcp-servers.js';
import { createSessionStreamsService } from './services/session-streams.js';
import { createSessionsService } from './services/sessions.js';
import { createTasksService, TASKS_SERVICE_TRANSPORT_METHODS } from './services/tasks.js';
import { TASKS_SERVICE_CUSTOM_EVENTS } from './services/tasks-events.js';
import { createTemplatesService } from './services/templates.js';
import { createTenantAgenticToolSettingsService } from './services/tenant-agentic-tools.js';
import { TerminalsService } from './services/terminals.js';
import { createThreadSessionMapService } from './services/thread-session-map.js';
import { createUsersService, USERS_SERVICE_TRANSPORT_METHODS } from './services/users.js';
import { requestExecutorTermination } from './termination-coordinator.js';
import { appendSystemMessage } from './utils/append-system-message.js';
import { requireMinimumRole } from './utils/authorization.js';
import { emitServiceEvent } from './utils/emit-service-event.js';
import { escapeHtml } from './utils/html.js';
import {
  shouldExposeMCPServerSecrets,
  shouldExposeMCPServerSecretsForSessionToken,
} from './utils/mcp-header-secrets.js';
import {
  isSessionMcpServerLinkVisibleToCaller,
  loadMcpServerForCaller,
} from './utils/mcp-server-authorization.js';
import { type SpawnExecutorOptions, spawnExecutor } from './utils/spawn-executor.js';
import { classifyExecutorExit } from './utils/task-launch-state.js';

/**
 * Interface for dependencies needed by service registration.
 */
export interface RegisterServicesContext {
  db: TenantScopeAwareDatabase;
  app: Application & { io?: import('socket.io').Server };
  config: AgorConfig;
  jwtSecret: string;
  daemonUrl: string;
  /** True when the daemon is serving the bundled UI itself at /ui (installed agor-live). */
  bundledUiAvailable: boolean;
  DAEMON_PORT: number;
  UI_PORT: number;
  branchRbacEnabled: boolean;
  allowSuperadmin: boolean;
  requireAuth: (context: HookContext) => Promise<HookContext>;
  deployment: ResolvedDeploymentConfig;
}

/**
 * References to registered services (returned for use by hooks and routes).
 */
export interface RegisteredServices {
  sessionsService: SessionsServiceImpl;
  messagesService: MessagesServiceImpl;
  boardsService: BoardsServiceImpl | undefined;
  branchRepository: BranchRepository;
  usersRepository: import('@agor/core/db').UsersRepository;
  sessionsRepository: import('@agor/core/db').SessionRepository;
  sessionMCPServersService: ReturnType<typeof createSessionMCPServersService>;
  sessionEnvSelectionsService: ReturnType<typeof createSessionEnvSelectionsService>;
  terminalsService: TerminalsService | null;
  configService: ReturnType<typeof createConfigService>;
  boardCommentsService: unknown;
}

/**
 * Register all FeathersJS services on the app.
 */
export async function registerServices(ctx: RegisterServicesContext): Promise<RegisteredServices> {
  const { db, app, config, jwtSecret, daemonUrl, branchRbacEnabled, allowSuperadmin } = ctx;
  const deploymentAgenticToolPolicy = resolveDeploymentAgenticToolPolicy(config);

  const _superadminOpts = { allowSuperadmin };

  // Helper for optional or conditionally registered integration services.
  const safeService = (path: string) => {
    try {
      return app.service(path);
    } catch {
      return undefined;
    }
  };

  // Initialize session token service
  const { SessionTokenService } = await import('./services/session-token-service.js');
  const sessionTokenService = new SessionTokenService(
    {
      expiration_ms: config.execution?.session_token_expiration_ms ?? 24 * 60 * 60 * 1000,
      max_uses: config.execution?.session_token_max_uses ?? -1,
    },
    { db }
  );

  const appRecord = app as unknown as Record<string, unknown>;
  appRecord.sessionTokenService = sessionTokenService;

  // Initialize MCP token module.
  const { initMcpTokens } = await import('./mcp/tokens.js');
  initMcpTokens({
    db,
    multiTenancy: resolveMultiTenancyConfig(config),
    expirationMs: config.execution?.mcp_token_expiration_ms,
  });

  // ============================================================================
  // Core services: sessions, tasks, messages
  // ============================================================================

  const sessionsService = createSessionsService(db, app, (tool) =>
    isDeploymentAgenticToolAvailable(tool, deploymentAgenticToolPolicy)
  ) as unknown as SessionsServiceImpl;
  app.use('/sessions', sessionsService, {
    events: ['permission:request', 'permission:timeout'],
  });

  // Wire up the execute handler for spawning executor processes
  sessionsService.setExecuteHandler(
    createExecuteHandler(ctx, sessionsService, sessionTokenService)
  );

  // Realtime control-plane: browsers subscribe (create) / unsubscribe (remove)
  // to a session's per-connection streaming channel so per-chunk streaming
  // events reach only the tabs actively viewing that session. Access is gated
  // by the session read inside the service. The create/remove events are
  // control-plane only and must never broadcast, so publish to no connections.
  app.use('/session-streams', createSessionStreamsService(app), {
    methods: ['create', 'remove'],
  });
  app.service('/session-streams').hooks({
    before: { all: [ctx.requireAuth] },
  });
  app.service('/session-streams').publish(() => []);

  app.use('/tasks', createTasksService(db, app), {
    methods: [...TASKS_SERVICE_TRANSPORT_METHODS],
    // Custom events not in this list are dropped at the FeathersJS transport
    // boundary — they fire on the local EventEmitter but never reach socket
    // clients. Keep this in sync with every `app.service('tasks').emit(...)`
    // call site.
    //   - 'queued': prompt route auto-queues a task (session not idle / queue
    //      not empty) — UI's queue drawer subscribes to this.
    //   - 'failed': prompt route reports executor-spawn failures so clients
    //      surface the error instead of seeing an idle session with a ghost
    //      task.
    //   - 'tool:start' / 'tool:complete' / 'thinking:chunk': forwarded from
    //      the executor for live tool/thinking visualization.
    events: [...TASKS_SERVICE_CUSTOM_EVENTS],
  });
  app.use('/leaderboard', createLeaderboardService(db));
  const messagesService = createMessagesService(db) as unknown as MessagesServiceImpl;

  app.use('/messages', messagesService, {
    methods: [...MESSAGES_SERVICE_TRANSPORT_METHODS],
    events: [
      'queued',
      'streaming:start',
      'streaming:chunk',
      'streaming:end',
      'streaming:error',
      'thinking:start',
      'thinking:chunk',
      'thinking:end',
      'permission_resolved',
    ],
    docs: {
      description: 'Conversation messages within AI agent sessions',
      definitions: {
        messages: {
          type: 'object',
          properties: {
            message_id: { type: 'string', format: 'uuid' },
            session_id: { type: 'string', format: 'uuid' },
            task_id: { type: 'string', format: 'uuid' },
            type: {
              type: 'string',
              enum: ['user', 'assistant', 'system', 'tool_use', 'tool_result'],
            },
            role: { type: 'string' },
            content: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: feathers-swagger docs option not typed in FeathersJS
  } as any);
  app.use(
    '/boards',
    createBoardsService(
      db,
      (boardObject, params) => {
        emitServiceEvent(app, {
          path: 'board-objects',
          event: 'patched',
          data: boardObject,
          params,
          id: boardObject.object_id,
        });
      },
      (event) => emitServiceEvent(app, { path: 'boards', ...event })
    ),
    {
      methods: [
        'find',
        'get',
        'create',
        'update',
        'patch',
        'remove',
        'toBlob',
        'fromBlob',
        'toYaml',
        'fromYaml',
        'clone',
        'setPrimaryTeammate',
        'clearPrimaryTeammate',
        'ensureTeammateWelcomeNote',
      ],
    }
  );
  app.use('/board-objects', createBoardObjectsService(db, app));

  const boardsService = safeService('boards') as unknown as BoardsServiceImpl | undefined;
  app.use('/card-types', createCardTypesService(db));
  app.use('/cards', createCardsService(db));
  // `agor-query` is the runtime-introspection fan-out event (daemon →
  // viewer's browser tab). Feathers' default `serviceEvents` is just
  // ['created','updated','patched','removed'], so without this it
  // fires locally on the server's EventEmitter and never reaches any
  // socket. See queryArtifactRuntime in services/artifacts.ts.
  app.use(
    '/artifacts',
    createArtifactsService(db, app, {
      runtimeIntrospectionEnabled: !isConstrainedHa(ctx.deployment),
    }),
    {
      events: ['agor-query'],
      methods: [...ARTIFACTS_SERVICE_TRANSPORT_METHODS],
    }
  );
  app.use('/board-comments', createBoardCommentsService(db));

  // ============================================================================
  // Branches, repos
  // ============================================================================

  app.use('/branches', createBranchesService(db, app), {
    methods: [
      'find',
      'get',
      'create',
      'update',
      'patch',
      'remove',
      'updateEnvironment',
      'ensureTeammateKnowledgeNamespace',
    ],
  });

  console.log(`[RBAC] Branch RBAC ${branchRbacEnabled ? 'Enabled' : 'Disabled'}`);
  console.log(`[RBAC] Superadmin bypass ${allowSuperadmin ? 'Enabled' : 'Disabled'}`);

  if (
    branchRbacEnabled &&
    !app.services['branches/:id/owners'] &&
    !app.services['branches/:id/owners/:userId']
  ) {
    const branchRepo = new BranchRepository(db);
    const executionMode = resolveExecutionSecurityMode(config);
    setupBranchOwnersService(app, branchRepo, {
      jwtSecret,
      daemonUser: config.daemon?.unix_user,
      unixFsIsolationEnabled: executionMode.unixFsIsolationEnabled,
      allowSuperadmin,
    });
  }

  if (resolveExecutionSecurityMode(config).unixFsIsolationEnabled) {
    const daemonUser = config.daemon?.unix_user || 'agor';
    console.log(`[Unix Integration] Executor-based sync enabled (daemon user: ${daemonUser})`);
  }

  app.use('/groups', createGroupsService(db), {
    methods: [...GROUPS_SERVICE_TRANSPORT_METHODS],
  });
  app.use('/group-memberships', createGroupMembershipsService(db), {
    methods: ['find', 'create', 'remove'],
  });
  setupBranchEffectiveAccessService(app, new BranchRepository(db));
  setupBoardAlignedBranchesService(app, new BranchRepository(db));
  setupBranchFsAccessUsersService(app, new BranchRepository(db));
  if (branchRbacEnabled) {
    setupBoardOwnersService(app, new BoardRepository(db));
    setupBoardGroupGrantsService(app, db);
    setupBranchGroupGrantsService(app, db, new BranchRepository(db));
  }

  app.use('/repos', createReposService(db, app), {
    methods: ['find', 'get', 'create', 'update', 'patch', 'remove'],
  });

  // First-class schedules. RBAC hooks wired in register-hooks.ts.
  // See docs/internal/schedules-first-class-design-2026-05-24.md §4.4.
  app.use('/schedules', createSchedulesService(db), {
    methods: [...SCHEDULES_SERVICE_TRANSPORT_METHODS],
  });

  // ============================================================================
  // Knowledge (backend/data foundations)
  // ============================================================================

  app.use('/kb/namespaces', createKnowledgeNamespacesService(db, app), {
    methods: [
      'find',
      'get',
      'create',
      'update',
      'patch',
      'remove',
      'saveWithAcl',
      'listAcl',
      'setAcl',
      'removeAcl',
    ],
  });
  const knowledgeDocumentsService = createKnowledgeDocumentsService(db, app);
  app.use('/kb/documents', knowledgeDocumentsService, {
    methods: ['find', 'get', 'create', 'update', 'patch', 'remove', 'getDocument', 'putDocument'],
  });
  app.use(
    '/kb/document-edits',
    createKnowledgeDocumentEditsService(db, app, knowledgeDocumentsService),
    {
      methods: ['create'],
    }
  );
  app.use('/kb/versions', createKnowledgeVersionsService(db), {
    methods: ['find'],
  });
  app.use('/kb/search', createKnowledgeSearchService(db), {
    methods: ['find', 'create'],
  });
  app.use('/kb/settings', createKnowledgeSettingsService(db, app), {
    methods: ['find', 'create', 'patch'],
  });
  app.use('/kb/indexing/status', createKnowledgeIndexingStatusService(db, app), {
    methods: ['find'],
  });
  app.use('/kb/indexing/reindex', createKnowledgeReindexService(db, app), {
    methods: ['create'],
  });
  app.use('/kb/graph', createKnowledgeGraphService(db), {
    methods: [...KNOWLEDGE_GRAPH_SERVICE_TRANSPORT_METHODS],
  });

  // ============================================================================
  // MCP Servers (conditionally registered)
  // ============================================================================

  let oauthCallbackHandler: ((req: express.Request, res: express.Response) => void) | null = null;

  // The OAuth callback middleware is registered in boot.ts; here we set the handler
  {
    const mcpResult = await registerMCPServices(ctx, sessionsService);
    oauthCallbackHandler = isConstrainedHa(ctx.deployment)
      ? (_req, res) => {
          res.status(503).json({
            code: 'HA_FEATURE_UNSUPPORTED',
            feature: 'mcpOAuth',
            message:
              'MCP OAuth callbacks are unavailable in HA support profile constrained-active-active',
          });
        }
      : mcpResult.oauthCallbackHandler;
  }

  // ============================================================================
  // Gateway services
  // ============================================================================

  {
    app.use('/gateway-channels', createGatewayChannelsService(db), {
      methods: [...GATEWAY_CHANNELS_SERVICE_TRANSPORT_METHODS],
    });

    // Sub-path service for the connection probe. A sub-path does NOT inherit
    // the parent gateway-channels admin gating / redaction hooks, so it carries
    // its own requireAuth + admin gate. It reads decrypted tokens via the
    // repository and returns no token values.
    app.use('/gateway-channels/test', createGatewayChannelsTestService(db));
    app.service('gateway-channels/test').hooks({
      before: {
        create: [ctx.requireAuth, requireMinimumRole(ROLES.ADMIN, 'test gateway channels')],
      },
    });
    // Request/response probe — its default `created` event would otherwise fall
    // through the global publisher's `global` scope and broadcast the probe
    // result to every authenticated socket. Publish to no one.
    app.service('gateway-channels/test').publish(() => []);

    // Sub-path service resolving the Slack app id behind a channel's stored
    // bot token (auth.test → bots.info). Same gating rationale as /test above:
    // reads decrypted tokens via the repository, returns no token values.
    app.use('/gateway-channels/app-info', createGatewayChannelsAppInfoService(db));
    app.service('gateway-channels/app-info').hooks({
      before: {
        create: [ctx.requireAuth, requireMinimumRole(ROLES.ADMIN, 'read gateway app info')],
      },
    });
    // Request/response read — same broadcast fall-through as /test above.
    app.service('gateway-channels/app-info').publish(() => []);

    app.use('/thread-session-map', createThreadSessionMapService(db));
    app.use('/gateway', createGatewayService(db, app), {
      // Only expose the inbound gateway entrypoint and existing route hook
      // externally. Proactive outbound emits are intentionally invoked through
      // the authenticated Agor MCP tool surface; exposing emitMessage here would
      // bypass the gateway service's normal channel_key auth model.
      methods: ['create', 'routeMessage'],
    });

    const uiUrl = ctx.bundledUiAvailable ? `${daemonUrl}/ui` : `http://localhost:${ctx.UI_PORT}`;
    registerGitHubAppSetupRoutes(app, {
      uiUrl,
      daemonUrl,
      db,
      config: ctx.config,
    });
  }

  // ============================================================================
  // Config, context, file, files, terminals
  // ============================================================================

  const configService = createConfigService(db, config);
  configService.app = app;
  // Host ACL/user/group operations exist only on a self-hosted daemon host. Hosted
  // registration is intentionally absent rather than forwarding privileged
  // work through an impersonated executor.
  if (shouldRegisterLocalHostOperations(config)) {
    app.use('/admin/local-actions', createLocalActionsService(createLocalDaemonHostOperations()));
  }

  app.use(
    '/agentic-tool-settings',
    createTenantAgenticToolSettingsService(db, deploymentAgenticToolPolicy)
  );
  app.service('/agentic-tool-settings').hooks({ before: { all: [ctx.requireAuth] } });
  app.use('/agentic-tool-presets', createAgenticToolPresetsService(db));
  app.service('/agentic-tool-presets').hooks({ before: { all: [ctx.requireAuth] } });

  app.use('/config/resolve-api-key', {
    // biome-ignore lint/suspicious/noExplicitAny: taskId is branded UUID at runtime
    async create(data: any, params?: Params) {
      return await configService.resolveApiKey(data, params);
    },
  });
  app.service('/config/resolve-api-key').hooks({
    before: {
      create: [ctx.requireAuth],
    },
  });

  app.use('/check-auth', createCheckAuthService(db, config));
  app.service('/check-auth').hooks({ before: { create: [ctx.requireAuth] } });

  registerOpenCodeServices(ctx);

  // Imports a pasted Codex CLI auth.json for the authenticated user — writes
  // it 0600 into the Unix identity that runs Codex and flips their auth
  // method to subscription. Token material never leaves the daemon.
  app.use('/codex-auth/import', createCodexAuthImportService(app, db));
  app.service('/codex-auth/import').hooks({ before: { create: [ctx.requireAuth] } });

  // ChatGPT device-code sign-in: create starts an attempt (code + verification
  // URL back to the UI, daemon polls OpenAI for approval); find reports the
  // caller's attempt status. Tokens stay daemon-side end to end.
  app.use('/codex-auth/device', createCodexDeviceAuthService(app, db));
  app
    .service('/codex-auth/device')
    .hooks({ before: { create: [ctx.requireAuth], find: [ctx.requireAuth] } });

  // Removes the caller's Codex login — deletes their auth.json as the right Unix
  // identity and clears the stored codex auth method (emitting `patched` so the
  // UI re-probes to disconnected). Server-local only; does not revoke the OAuth
  // grant, so other machines stay signed in.
  app.use('/codex-auth/logout', createCodexAuthLogoutService(app, db));
  app.service('/codex-auth/logout').hooks({ before: { create: [ctx.requireAuth] } });

  // Claude dynamic model discovery via @anthropic-ai/sdk's models.list().
  // Resolves ANTHROPIC_API_KEY per-user (with config.yaml + env fallback)
  // and falls back to AVAILABLE_CLAUDE_MODEL_ALIASES if no key or API failure.
  app.use('/claude-models', createClaudeModelsService(db));
  app.service('/claude-models').hooks({ before: { find: [ctx.requireAuth] } });

  // Copilot dynamic model discovery via @github/copilot-sdk's listModels().
  // Resolves the GitHub token per-user (with config.yaml + env fallback)
  // and falls back to the static list at @agor/core/models/copilot if no
  // token is configured or the SDK call fails.
  app.use('/copilot-models', createCopilotModelsService(db));
  app.service('/copilot-models').hooks({ before: { find: [ctx.requireAuth] } });

  // Cursor dynamic model discovery via @cursor/sdk's Cursor.models.list().
  // Resolves CURSOR_API_KEY per-user (with config.yaml + env fallback) and
  // falls back to composer-latest if no key is configured or the SDK call fails.
  app.use('/cursor-models', createCursorModelsService(db));
  app.service('/cursor-models').hooks({ before: { find: [ctx.requireAuth] } });

  const branchRepository = new BranchRepository(db);
  const usersRepository = new UsersRepository(db);
  const sessionsRepository = new SessionRepository(db);
  app.use('/file', createFileService(branchRepository, db, app));
  app.use('/files', createFilesService(db, app));

  // Server-side Handlebars renderer. UI calls POST /templates so the browser
  // bundle can stay free of Handlebars (which uses `new Function` and would
  // require CSP `script-src 'unsafe-eval'`).
  app.use('/templates', createTemplatesService());
  app.service('/templates').hooks({ before: { create: [ctx.requireAuth] } });

  const terminalsService = new TerminalsService(app, db);
  app.use('/terminals', terminalsService, {
    events: ['data', 'exit'],
  });

  // ============================================================================
  // Session MCP Servers (top-level for WebSocket events)
  // ============================================================================

  const sessionMCPServersService = createSessionMCPServersService(db);
  const sessionEnvSelectionsService = createSessionEnvSelectionsService(db);
  // Top-level /session-env-selections — event channel ONLY.
  //
  // Unlike /session-mcp-servers, selection NAMES are a confidentiality
  // concern (they reveal which of the session creator's private env vars
  // are wired into a session), so we deliberately do NOT surface a
  // queryable read here — a branch collaborator with `view`/`prompt`
  // must not see another user's selection names.
  //
  // Reads go exclusively through `/sessions/:id/env-selections`, which
  // enforces session-creator / admin RBAC (see register-routes.ts). This
  // service exists only so FeathersJS can emit `created` / `removed` /
  // `patched` events to socket clients that need to refresh.
  app.use('/session-env-selections', {
    // Empty find() — clients can still subscribe to events, but cannot
    // query rows via this top-level service.
    async find() {
      return [];
    },
  });
  app.use('/session-mcp-servers', {
    async find(params?: {
      query?: {
        session_id?: string | { $in?: string[] };
        mcp_server_id?: string;
        enabled?: boolean;
      };
      _agorSqlSessionAccessUserId?: UUID;
    }) {
      const conditions: ReturnType<typeof eq>[] = [];
      // session_id may be a scalar string or `{ $in: [...] }` from callers.
      // RBAC scoping is composed below via `_agorSqlSessionAccessUserId`.
      const sessionIdFilter = params?.query?.session_id;
      if (typeof sessionIdFilter === 'string') {
        conditions.push(eq(sessionMcpServers.session_id, sessionIdFilter));
      } else if (
        sessionIdFilter &&
        typeof sessionIdFilter === 'object' &&
        Array.isArray(sessionIdFilter.$in)
      ) {
        if (sessionIdFilter.$in.length === 0) {
          return [];
        }
        conditions.push(inArray(sessionMcpServers.session_id, sessionIdFilter.$in));
      }
      if (params?.query?.mcp_server_id) {
        conditions.push(eq(sessionMcpServers.mcp_server_id, params.query.mcp_server_id));
      }
      if (params?.query?.enabled !== undefined) {
        conditions.push(eq(sessionMcpServers.enabled, params.query.enabled));
      }
      if (params?._agorSqlSessionAccessUserId) {
        conditions.push(
          visibleSessionReferenceAccessExists(
            db,
            params._agorSqlSessionAccessUserId,
            sessionMcpServers.session_id
          )
        );
      }
      let query = select(db, {
        session_id: sessionMcpServers.session_id,
        mcp_server_id: sessionMcpServers.mcp_server_id,
        enabled: sessionMcpServers.enabled,
        added_at: sessionMcpServers.added_at,
        owner_user_id: mcpServers.owner_user_id,
        session_created_by: sessions.created_by,
      })
        .from(sessionMcpServers)
        .innerJoin(mcpServers, eq(sessionMcpServers.mcp_server_id, mcpServers.mcp_server_id))
        .innerJoin(sessions, eq(sessionMcpServers.session_id, sessions.session_id));
      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }
      const rows = (await query.all()) as Array<{
        session_id: string;
        mcp_server_id: string;
        enabled: boolean;
        added_at: Date | number | string;
        owner_user_id: string | null;
        session_created_by: string;
      }>;
      return rows
        .filter((row) =>
          isSessionMcpServerLinkVisibleToCaller(
            {
              owner_user_id: row.owner_user_id,
              session_created_by: row.session_created_by,
            },
            params as unknown as AuthenticatedParams
          )
        )
        .map((row) => ({
          session_id: row.session_id,
          mcp_server_id: row.mcp_server_id,
          enabled: Boolean(row.enabled),
          added_at: new Date(row.added_at),
        }));
    },
  });

  // ============================================================================
  // Users service
  // ============================================================================

  const usersService = createUsersService(db, app);
  // UsersService implements find/get/create/patch/remove (no `update`), plus
  // custom RPCs like `getGitEnvironment` and avatar sync helpers. Listing `update` here makes Feathers' hook
  // wiring throw "Can not apply hooks. 'update' is not a function" at startup.
  app.use('/users', usersService, {
    methods: [...USERS_SERVICE_TRANSPORT_METHODS],
  });

  // Bootstrap superadmin users
  await bootstrapSuperadminUsers(config, usersService, allowSuperadmin);

  // Store oauthCallbackHandler on app for boot.ts to wire up
  appRecord.oauthCallbackHandler = oauthCallbackHandler;

  // Store sessionTokenService for auth setup
  appRecord.sessionTokenServiceInstance = sessionTokenService;

  return {
    sessionsService,
    messagesService,
    boardsService,
    branchRepository,
    usersRepository,
    sessionsRepository,
    sessionMCPServersService,
    sessionEnvSelectionsService,
    terminalsService,
    configService,
    boardCommentsService: safeService('board-comments'),
  };
}

// ============================================================================
// Execute Handler (spawns executor processes)
// ============================================================================

function createDeferredSignal() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createExecuteHandler(
  ctx: RegisterServicesContext,
  sessionsService: SessionsServiceImpl,
  sessionTokenService: import('./services/session-token-service.js').SessionTokenService
) {
  const { db, app, config, daemonUrl } = ctx;
  const deploymentAgenticToolPolicy = resolveDeploymentAgenticToolPolicy(config);

  return async (
    sessionId: string,
    data: {
      taskId: string;
      prompt: string;
      permissionMode?: import('@agor/core/types').PermissionMode;
      stream?: boolean;
      messageSource?: MessageSource;
    },
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type varies by context
    params: any
  ) => {
    const tenantId = getCurrentTenantId();
    const session = await prepareSessionForExecutorStart(
      db,
      sessionsService,
      sessionId,
      params,
      deploymentAgenticToolPolicy
    );
    assertHaTaskPermissionSupported(ctx.deployment, {
      session,
      requestedMode: data.permissionMode,
    });
    const userId = (params as AuthenticatedParams).user?.user_id as UserID | undefined;
    if (
      session.agentic_tool_preset_id &&
      data.permissionMode !== undefined &&
      data.permissionMode !== session.permission_config?.mode
    ) {
      throw new Error('Preset-backed sessions cannot override permission mode per task');
    }
    if (session.agentic_tool === 'opencode') {
      if (!tenantId) throw new Error('Missing active tenant context for OpenCode execution');
      OPENCODE_DAEMON_CONTRIBUTION.admitExecutor({
        tenantId,
        config,
        modelConfig: session.model_config ?? undefined,
        sessionOwnerId: session.created_by,
        prompterUserId: userId,
      });
    }

    // Generate session token for executor authentication
    const appWithExecutor = app as unknown as {
      sessionTokenService?: import('./services/session-token-service.js').SessionTokenService;
    };
    if (!appWithExecutor.sessionTokenService) {
      throw new Error('Session token service not initialized');
    }
    // Hook chain enforces auth before we get here.
    const sessionToken = await appWithExecutor.sessionTokenService.generateToken(
      sessionId,
      (params as AuthenticatedParams).user!.user_id,
      {
        taskId: data.taskId,
        branchId: session.branch_id,
        // Executor JWTs authenticate on every daemon API call over the runtime
        // connection, so low per-call max-use limits make normal execution
        // fail after startup. Keep expiry + revocation for these scoped runtime
        // credentials; reconnect reuses the same token and does not consume a
        // separate connection allowance. Bounded tokens retain per-validation
        // use counting for compatibility.
        maxUses: -1,
      }
    );

    const taskId = data.taskId;

    // Get branch path
    let cwd = process.cwd();
    if (session.branch_id) {
      const branchPath = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
        const branch = await new BranchRepository(tenantDb).findById(session.branch_id);
        return branch?.path;
      });
      if (!branchPath)
        throw new Error(`Branch ${session.branch_id} not found for executor startup`);
      cwd = branchPath;
    }

    // Determine Unix user for executor
    const {
      getHomedirFromUsername,
      resolveUnixUserForImpersonation,
      validateResolvedUnixUser,
      UnixUserNotFoundError,
    } = await import('@agor/core/unix');

    const unixUserMode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;
    const configExecutorUser = config.execution?.executor_unix_user;
    const sessionUnixUser = session.unix_username;

    const impersonationResult = resolveUnixUserForImpersonation({
      mode: unixUserMode,
      userUnixUsername: sessionUnixUser,
      executorUnixUser: configExecutorUser,
    });

    const executorUnixUser = impersonationResult.unixUser;
    const executorHomeDir = executorUnixUser ? getHomedirFromUsername(executorUnixUser) : homedir();
    const effectivePermissionMode =
      data.permissionMode || session.permission_config?.mode || undefined;
    const permissionModeForPayload =
      effectivePermissionMode === 'default' ? undefined : effectivePermissionMode;

    // Validate Unix user
    try {
      validateResolvedUnixUser(unixUserMode, executorUnixUser);
    } catch (err) {
      if (err instanceof UnixUserNotFoundError) {
        throw new Error(
          `${(err as InstanceType<typeof UnixUserNotFoundError>).message}. Ensure the Unix user is created before attempting to execute sessions.`
        );
      }
      throw err;
    }

    // Resolve user environment variables
    const { createUserProcessEnvironment } = await import('@agor/core/config');
    // Resolve gateway-level env vars
    const gatewaySource = (session.custom_context as Record<string, unknown> | undefined)
      ?.gateway_source as { channel_id?: string } | undefined;
    const executorEnv = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
      let gatewayEnv: import('@agor/core/types').GatewayEnvVar[] | undefined;
      if (gatewaySource?.channel_id) {
        const { decryptApiKey, isEncrypted } = await import('@agor/core/db');
        const channel = await new GatewayChannelRepository(tenantDb).findById(
          gatewaySource.channel_id
        );
        if (channel?.agentic_config?.envVars) {
          gatewayEnv = channel.agentic_config.envVars.map((v) => ({
            ...v,
            value: (() => {
              if (!v.value || !isEncrypted(v.value)) return v.value;
              try {
                return decryptApiKey(v.value);
              } catch {
                return v.value;
              }
            })(),
          }));
        }
        // Merge connector-provided session credentials (e.g. Shortcut's API
        // token, which the media-intake skill uses to fetch ticket
        // attachments) as defaults. Operator `agentic_config.envVars` above
        // take precedence — a key already present is not overwritten.
        if (channel) {
          const { getConnector } = await import('@agor/core/gateway');
          const connectorEnv =
            getConnector(channel.channel_type, channel.config).sessionEnv?.() ?? [];
          if (connectorEnv.length > 0) {
            const present = new Set((gatewayEnv ?? []).map((e) => e.key));
            const defaults = connectorEnv.filter((e) => !present.has(e.key));
            if (defaults.length > 0) gatewayEnv = [...(gatewayEnv ?? []), ...defaults];
          }
        }
      }

      // Provider connections are resolved once by the executor through the
      // task-scoped daemon API. Generic process environment never carries them.
      return createUserProcessEnvironment(
        userId,
        tenantDb,
        undefined,
        !!executorUnixUser,
        gatewayEnv,
        sessionId as SessionID
      );
    });

    // Validate required user environment variables
    const requiredUserEnvVars = config.execution?.required_user_env_vars;
    if (requiredUserEnvVars && requiredUserEnvVars.length > 0) {
      const missingVars = requiredUserEnvVars.filter((v: string) => !executorEnv[v]);
      if (missingVars.length > 0) {
        const missingList = missingVars.map((v: string) => `\`${v}\``).join(', ');
        const errorContent = [
          `**Missing required environment variables:** ${missingList}`,
          '',
          'Your administrator requires these variables to be set before running prompts.',
          '',
          `**To fix:** Click your user avatar (top-right) → **Settings** → **Environment Variables**, then add values for: ${missingList}`,
          '',
          'This is a one-time setup — once configured, this message will not appear again.',
        ].join('\n');
        await runWithTenantDatabaseScope(db, tenantId, (_tenantDb) =>
          appendSystemMessage({
            app,
            db,
            sessionId,
            taskId: data.taskId,
            content: errorContent,
            contentPreview: `Missing required env vars: ${missingVars.join(', ')}`,
          })
        );
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
      }
    }

    executorEnv.DAEMON_URL = daemonUrl;

    const openCodeLaunch = (() => {
      if (session.agentic_tool !== 'opencode') return undefined;
      if (!tenantId) throw new Error('Missing active tenant context for OpenCode execution');
      if (!executorHomeDir) throw new Error('Missing executor home for OpenCode execution');
      return OPENCODE_DAEMON_CONTRIBUTION.getExecutorLaunch({
        tenantId,
        session,
        homeDir: executorHomeDir,
      });
    })();

    // Build executor payload
    const executorPayload = {
      command: 'prompt' as const,
      sessionToken,
      daemonUrl,
      ...(openCodeLaunch?.executorPayload ?? {}),
      env: executorEnv,
      params: {
        sessionId,
        taskId,
        prompt: data.prompt,
        tool: session.agentic_tool as
          | 'claude-code'
          | 'gemini'
          | 'codex'
          | 'opencode'
          | 'copilot'
          | 'cursor',
        permissionMode: permissionModeForPayload as 'ask' | 'auto' | 'allow-all' | undefined,
        cwd,
        messageSource: data.messageSource,
      },
    };

    const logPrefix = `[Executor ${shortId(sessionId)}]`;

    type NativeStateSpawn = {
      fence: OpenCodeNativeStateMutationFence;
      ready: ReturnType<typeof createDeferredSignal>;
      finished: ReturnType<typeof createDeferredSignal>;
      markSpawned(): void;
    };

    let localExecutorPid: number | undefined;
    const executorOptions = (nativeState?: NativeStateSpawn): SpawnExecutorOptions => ({
      asUser: executorUnixUser || undefined,
      preparedEnv: executorEnv,
      logPrefix,
      templateVariables: {
        session_id: sessionId,
        task_id: taskId,
        branch_id: session.branch_id,
        user_id: userId,
        // Mode-resolved identity for the execution substrate: the sudo user in
        // insulated/strict, the session's unix_username in delegated (no sudo),
        // and unset in simple. Supersedes the interim
        // `sessionUnixUser || executorUnixUser` ordering from #2082, which
        // shadowed insulated mode's configured executor identity.
        unix_user: impersonationResult.reportedUnixUser || undefined,
      },
      onSpawn: (child, spawnContext) => {
        nativeState?.markSpawned();
        if (spawnContext.mode === 'local' && child.pid) {
          localExecutorPid = child.pid;
          trackExecutorProcess(
            {
              sessionId,
              taskId,
              pid: child.pid,
              ...(executorUnixUser ? { asUser: executorUnixUser } : {}),
            },
            app
          );
          console.log(`${logPrefix} PID: ${child.pid}`);
        }
        if (!nativeState) return;
        if (spawnContext.mode !== 'local' || !child.pid) {
          const error = new Error('OpenCode execution requires a locally tracked executor process');
          nativeState.ready.reject(error);
          return Promise.reject(error);
        }
        const handle = {
          retainContainmentFence: (key: string) =>
            retainExecutorContainmentFence(key, sessionId, taskId, app),
          verifyAbsence: async () =>
            (await containExecutorProcess(sessionId, taskId, {}, app)).status === 'verified_absent',
        };
        return nativeState.fence.attach(handle).then(
          () => nativeState.ready.resolve(),
          (error) => {
            nativeState.ready.reject(error);
            throw error;
          }
        );
      },
      onExit: async (code, spawnContext) => {
        console.log(`${logPrefix} Exited with code ${code}`);

        if (spawnContext.mode === 'local') {
          markExecutorProcessExited(sessionId, localExecutorPid, app);
        }

        let templatedLauncherAbsenceVerified = false;
        if (spawnContext.mode === 'templated') {
          const disposition = classifyExecutorExit({
            mode: spawnContext.mode,
            code,
            nonzeroMayHaveDispatched:
              config.execution?.executor_command_nonzero_may_have_dispatched === true,
          });
          if (disposition !== 'authoritative') {
            if (disposition === 'ambiguous') {
              try {
                await (
                  app.service('tasks') as unknown as TasksServiceImpl
                ).recordExecutorStartupWarning(
                  taskId,
                  `Executor launcher exited with code ${code ?? 'unknown'}, but configuration says remote work may have been dispatched.`,
                  { ...params, provider: undefined }
                );
              } catch (error) {
                console.warn(`${logPrefix} Failed to record ambiguous launcher exit:`, error);
              }
            }
            console.log(
              `${logPrefix} Launcher exit is passive; awaiting remote executor lifecycle`
            );
            nativeState?.finished.resolve();
            return;
          }
          templatedLauncherAbsenceVerified = true;
        }

        try {
          const termination = await requestExecutorTermination({
            app,
            taskId,
            cause: 'heartbeat_lost',
            errorMessage: `Executor exited unexpectedly with code ${code ?? 'unknown'}.`,
            params,
            // Missing a local process handle is never absence proof. A
            // configured authoritative templated-launcher failure is the one
            // launch path that can prove no remote executor was created.
            absenceVerified: templatedLauncherAbsenceVerified,
            sdkFailure: {
              reason: 'heartbeat_lost',
              detected_at: new Date().toISOString(),
              tool: session.agentic_tool,
              termination: 'requested',
            },
            // A remote executor may connect while its launcher is exiting.
            // Resolve that race only at the row-locked claim.
            ...(spawnContext.mode === 'templated'
              ? {
                  expectedStatus: TaskStatus.DISPATCHING,
                  requireExecutorDisconnected: true,
                }
              : {}),
          });
          if (termination.status === 'condition_changed') {
            console.log(`${logPrefix} Connected executor won the launcher-exit race`);
            nativeState?.finished.resolve();
            return;
          }
        } catch (error) {
          console.error(`❌ [Executor] Failed to coordinate executor exit:`, error);
        }

        try {
          // Launcher callbacks can outlive the tenant transaction that spawned
          // them. Leave any inherited DB scope before opening the fresh
          // tenant scope derived from the verified token claim.
          await runWithoutTenantDatabaseScope(() =>
            appWithExecutor.sessionTokenService?.revokeToken(sessionToken)
          );
        } finally {
          nativeState?.finished.resolve();
        }
      },
    });

    if (openCodeLaunch) {
      const ready = createDeferredSignal();
      const finished = createDeferredSignal();
      let spawned = false;
      const slot = inOpenCodeNativeStateMutationSlot(openCodeLaunch.namespaceKey, async (fence) => {
        try {
          spawnExecutor(
            executorPayload,
            executorOptions({ fence, ready, finished, markSpawned: () => (spawned = true) })
          );
          await ready.promise;
          await finished.promise;
        } catch (error) {
          if (!spawned) await fence.releaseWithoutWriter();
          throw error;
        }
      });
      void slot.catch((error) => {
        ready.reject(error);
        console.error(`${logPrefix} Native-state writer failed:`, error);
      });
      await ready.promise;
    } else {
      spawnExecutor(executorPayload, executorOptions());
    }

    return {
      success: true,
      taskId: taskId,
      status: 'running',
      streaming: data.stream !== false,
    };
  };
}

// ============================================================================
// MCP Services Registration (large block extracted for readability)
// ============================================================================

async function registerMCPServices(
  ctx: RegisterServicesContext,
  sessionsService: SessionsServiceImpl
): Promise<{ oauthCallbackHandler: (req: express.Request, res: express.Response) => void }> {
  const { db, app } = ctx;
  const sessionsRepository = new SessionRepository(db);
  const durableOAuthFlows = isPostgresDatabaseHandle(db)
    ? new MCPOAuthPendingFlowAuthority(db)
    : null;
  const oauthFetch = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const requestInput = input instanceof Request ? input : undefined;
    const target: string | URL = input instanceof Request ? input.url : input;
    const { signal: _signal, redirect: _redirect, ...safeInit } = init;
    const method = (safeInit.method ?? requestInput?.method ?? 'GET').toUpperCase();
    const body =
      safeInit.body ??
      (requestInput?.body ? new Uint8Array(await requestInput.arrayBuffer()) : undefined);
    return safeOutboundFetch(target, {
      ...safeInit,
      method,
      headers: safeInit.headers ?? requestInput?.headers,
      body,
      redirect: method === 'GET' ? 'follow' : 'error',
      timeoutMs: 15_000,
      // Loopback HTTP is retained only for standalone/SQLite development.
      // PostgreSQL is the multi-daemon/hosted authority and must never turn
      // an admin-supplied endpoint into daemon-local egress.
      allowLocalhostHttp: !durableOAuthFlows,
    });
  };

  // Helper to generate a simple HTML page for OAuth callback results
  function oauthResultPage(success: boolean, message: string): string {
    const color = success ? '#52c41a' : '#ff4d4f';
    const icon = success ? '&#10003;' : '&#10007;';
    const safeMessage = escapeHtml(message);
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Agor OAuth</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a1a;color:#fff}
.card{text-align:center;padding:2rem;border-radius:8px;background:#2a2a2a;max-width:400px}
.icon{font-size:3rem;color:${color}}</style></head>
<body><div class="card"><div class="icon">${icon}</div><p>${safeMessage}</p></div></body></html>`;
  }

  type PendingOAuthFlow = {
    attemptId: MCPOAuthAttemptID;
    context: OAuthFlowContext;
    mcpServerId?: string;
    userId?: string;
    oauthMode?: 'per_user' | 'shared';
    /** Tenant captured when the flow starts; browser callbacks have no auth headers. */
    tenantId?: string;
    socketId?: string;
    createdAt: number;
    /**
     * Resolver wired up by `startTwoPhaseMCPOAuthFlowAndAwaitToken` when the
     * caller wants to block on token acquisition (discover / test-oauth).
     * The daemon-side `oauthCallbackHandler` calls these after the token has
     * been exchanged + persisted so the original HTTP request can complete.
     */
    tokenResolve?: (tokenResponse: OAuthTokenResponse) => void;
    tokenReject?: (err: Error) => void;
    /** Present only for a PostgreSQL one-shot claim. */
    durableRecord?: MCPOAuthPendingFlowRecord;
  };

  // Store pending OAuth flow contexts
  const pendingOAuthFlows = new Map<string, PendingOAuthFlow>();
  const localOAuthAttemptStatuses = new Map<
    MCPOAuthAttemptID,
    {
      status: MCPOAuthPendingFlowStatus;
      userId?: string;
      tenantId?: string;
      mcpServerId?: string;
      oauthMode?: 'per_user' | 'shared';
      failureCode?: string;
      updatedAt: number;
    }
  >();

  /**
   * Hard ceiling on how long an inbound HTTP request will block waiting for
   * the user to complete the browser-side OAuth flow. The 10-minute sweeper
   * below is the *cleanup* upper bound; this is the *request* upper bound.
   * Most reverse proxies time out long before 10 minutes, so we surface a
   * clear error sooner than that and free the pending entry.
   */
  const AWAIT_TOKEN_TIMEOUT_MS = 5 * 60 * 1000;

  // Standalone cleanup remains process-local. PostgreSQL cleanup is a
  // fleet-safe, idempotent state-machine transition plus terminal retention.
  const oauthCleanupTimer = setInterval(() => {
    const now = Date.now();
    const tenMinutes = 10 * 60 * 1000;
    for (const [state, flow] of pendingOAuthFlows.entries()) {
      if (now - flow.createdAt > tenMinutes) {
        pendingOAuthFlows.delete(state);
        localOAuthAttemptStatuses.set(flow.attemptId, {
          status: 'expired',
          userId: flow.userId,
          tenantId: flow.tenantId,
          mcpServerId: flow.mcpServerId,
          oauthMode: flow.oauthMode,
          failureCode: 'authorization_timed_out',
          updatedAt: now,
        });
        flow.tokenReject?.(new Error('OAuth flow expired before callback was received'));
      }
    }
    for (const [attemptId, attempt] of localOAuthAttemptStatuses) {
      if (attempt.status !== 'pending' && now - attempt.updatedAt > 24 * 60 * 60 * 1000) {
        localOAuthAttemptStatuses.delete(attemptId);
      }
    }

    if (durableOAuthFlows) {
      runWithoutTenantDatabaseScope(() => durableOAuthFlows.maintain()).catch(() => {
        // PostgreSQL remains authoritative; another daemon or the next sweep
        // retries. Never log DB errors that may carry bound sealed material.
        console.warn('[OAuth Maintenance] Pending-flow maintenance failed');
      });
    }
  }, 60_000);
  oauthCleanupTimer.unref();

  /**
   * Shared helper for starting the daemon's two-phase MCP OAuth flow.
   *
   * All daemon-side OAuth paths (Settings "Start OAuth Flow", discover probe,
   * test-oauth `start_browser_flow`) MUST go through one of these two helpers
   * so that:
   *   1. The `redirect_uri` is always the daemon's PUBLIC base URL, not
   *      `127.0.0.1:<random>` — the browser completing the flow may be on a
   *      different machine than the daemon (e.g. any remotely-deployed Agor).
   *   2. The authorization URL is returned only to the initiating request;
   *      it is never broadcast over a shared realtime channel.
   *   3. PostgreSQL deployments persist a sealed, tenant/user/server-bound
   *      attempt before returning the URL. SQLite keeps the local Map path.
   *
   * Two flavors:
   *   - {@link startTwoPhaseMCPOAuthFlow} — fire-and-forget. Used by
   *     `oauth-start`, where the UI completes the flow asynchronously and the
   *     daemon emits a tenant-qualified `oauth:completed` latency hint; the
   *     UI refetches durable attempt/grant state for correctness.
   *   - {@link startTwoPhaseMCPOAuthFlowAndAwaitToken} — blocks on a Promise
   *     that resolves once `oauthCallbackHandler` finishes exchanging + persisting
   *     the token. Used by `discover` and `test-oauth start_browser_flow`,
   *     which need to return the token-validation result in the same HTTP
   *     response. Bounded by {@link AWAIT_TOKEN_TIMEOUT_MS}.
   */
  /**
   * Human-readable enumeration of every discovery strategy
   * `resolveMCPOAuthDiscovery` walks. Kept in sync with the cascade in
   * `@agor/core/tools/mcp/oauth-mcp-transport.ts` so error messages don't
   * drift when strategies are added or reordered.
   */
  const DISCOVERY_CASCADE_TRIED =
    'Tried: (1) WWW-Authenticate resource_metadata hint, ' +
    '(2) /.well-known/oauth-protected-resource (RFC 9728), ' +
    '(3) /.well-known/oauth-authorization-server at MCP origin (RFC 8414), ' +
    '(4) /.well-known/openid-configuration at MCP origin (OIDC).';

  type StartTwoPhaseOAuthOptions = {
    mcpUrl: string;
    wwwAuthenticate: string;
    /**
     * RFC 9728 Protected Resource Metadata URL. Set when discovery hit the
     * standard MCP spec path. Mutually exclusive with
     * `prefetchedAuthServerMetadata` — exactly one must be provided.
     */
    resourceMetadataUrl?: string;
    /**
     * Pre-discovered Authorization Server metadata, set when discovery hit the
     * AS-direct fallback (`<mcp-origin>/.well-known/oauth-authorization-server`).
     * Mutually exclusive with `resourceMetadataUrl` — exactly one must be
     * provided.
     */
    prefetchedAuthServerMetadata?: import('@agor/core/tools/mcp/oauth-mcp-transport').AuthorizationServerMetadata;
    mcpServerId?: string;
    userId?: string;
    oauthMode?: 'per_user' | 'shared';
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
    authorizationUrlOverride?: string;
    tokenUrlOverride?: string;
    scope?: string;
    compatibilityMode?: 'strict' | 'legacy';
    dcrMode?: MCPOAuthDCRMode;
    socketId?: string;
  };

  type StartTwoPhaseOAuthResult = {
    attemptId: MCPOAuthAttemptID;
    state: string;
    authorizationUrl: string;
    redirectUri: string;
  };

  type StartTwoPhaseOAuthAndAwaitResult = StartTwoPhaseOAuthResult & {
    awaitToken: () => Promise<OAuthTokenResponse>;
  };

  async function startTwoPhaseMCPOAuthFlow(
    opts: StartTwoPhaseOAuthOptions
  ): Promise<StartTwoPhaseOAuthResult> {
    return startTwoPhaseMCPOAuthFlowInternal(opts, false);
  }

  async function startTwoPhaseMCPOAuthFlowAndAwaitToken(
    opts: StartTwoPhaseOAuthOptions
  ): Promise<StartTwoPhaseOAuthAndAwaitResult> {
    return (await startTwoPhaseMCPOAuthFlowInternal(
      opts,
      true
    )) as StartTwoPhaseOAuthAndAwaitResult;
  }

  async function startTwoPhaseMCPOAuthFlowInternal(
    opts: StartTwoPhaseOAuthOptions,
    awaitToken: boolean
  ): Promise<StartTwoPhaseOAuthResult | StartTwoPhaseOAuthAndAwaitResult> {
    const { startMCPOAuthFlow } = await import('@agor/core/tools/mcp/oauth-mcp-transport');

    // Strict public base URL — see oauth-start endpoint for the rationale.
    const baseUrl = await requirePublicBaseUrl();
    const redirectUri = new URL('/mcp-servers/oauth-callback', baseUrl).toString();

    const hasRfc9728 = !!opts.resourceMetadataUrl;
    const hasAsDirect = !!opts.prefetchedAuthServerMetadata;
    if (hasRfc9728 === hasAsDirect) {
      // Both set → ambiguous; neither set → no path forward.
      throw new Error(
        'startTwoPhaseMCPOAuthFlow requires exactly one of resourceMetadataUrl ' +
          '(RFC 9728) or prefetchedAuthServerMetadata (AS-direct discovery), ' +
          `received resourceMetadataUrl=${hasRfc9728}, prefetchedAuthServerMetadata=${hasAsDirect}.`
      );
    }

    let durableServer: import('@agor/core/types').MCPServer | undefined;
    let durableBinding:
      | {
          tenantId: string;
          userId: UserID;
          mcpServerId: MCPServerID;
          oauthMode: 'per_user' | 'shared';
        }
      | undefined;
    if (durableOAuthFlows) {
      if (!opts.tenantId || !opts.userId || !opts.mcpServerId) {
        throw new Error(
          'PostgreSQL OAuth requires a saved MCP server and authenticated tenant/user binding. Save the server, then restart OAuth.'
        );
      }
      const server = await runInOAuthTenantScope(db, opts.tenantId, () =>
        new MCPServerRepository(db).findById(opts.mcpServerId!)
      );
      if (!server?.enabled || server.url !== opts.mcpUrl || server.auth?.type !== 'oauth') {
        throw new Error(
          'The saved MCP server no longer matches this OAuth request. Save changes, then restart OAuth.'
        );
      }
      if ((server.auth.oauth_mode ?? 'per_user') === 'shared') {
        const initiatingUser = await runInOAuthTenantScope(db, opts.tenantId, () =>
          new UsersRepository(db).findById(opts.userId!)
        );
        if (!hasMinimumRole(initiatingUser?.role, ROLES.ADMIN)) {
          throw new Forbidden('Shared MCP OAuth grants can only be started by an admin');
        }
      }
      durableServer = server;
      durableBinding = {
        tenantId: opts.tenantId,
        userId: opts.userId as UserID,
        mcpServerId: opts.mcpServerId as MCPServerID,
        oauthMode: server.auth.oauth_mode ?? 'per_user',
      };
    }

    const context = await startMCPOAuthFlow(opts.wwwAuthenticate, opts.clientId, redirectUri, {
      authorizationUrlOverride: opts.authorizationUrlOverride,
      tokenUrlOverride: opts.tokenUrlOverride,
      clientSecret: opts.clientSecret,
      scope: opts.scope,
      resourceMetadataUrl: opts.resourceMetadataUrl,
      prefetchedAuthServerMetadata: opts.prefetchedAuthServerMetadata,
      // The core helper still needs a stable metadata key for its standalone
      // flow context. Daemon callers never read or populate its origin-only
      // bearer cache.
      cacheKey: opts.prefetchedAuthServerMetadata ? opts.mcpUrl : undefined,
      // Process-global DCR credentials are not a tenant/user/server namespace.
      // Daemon flows never share them, including in SQLite deployments.
      reuseDynamicClientRegistration: false,
      resourceUri: opts.mcpUrl,
      compatibilityMode: opts.compatibilityMode,
      dcrMode: opts.dcrMode,
      allowLocalhostHttp: !durableOAuthFlows,
    });

    const attemptId = durableBinding
      ? await runInOAuthTenantWriteScope(db, durableBinding.tenantId, async () => {
          await lockMCPOAuthGrantConfiguration(
            db,
            durableBinding.tenantId,
            durableBinding.mcpServerId
          );
          const currentServer = await new MCPServerRepository(db).findById(
            durableBinding.mcpServerId
          );
          if (
            !currentServer ||
            hasMCPOAuthRelevantServerConfigurationChanged(durableServer, currentServer)
          ) {
            throw new Error(
              'The MCP server changed while OAuth metadata was being resolved. Restart OAuth.'
            );
          }
          return durableOAuthFlows!.create({
            context,
            ...durableBinding,
            configFingerprint: fingerprintMCPOAuthGrantConfiguration(
              process.env.AGOR_MASTER_SECRET!,
              currentServer,
              {
                resourceUri: context.resourceUri,
                metadataUrl: context.metadataUrl,
                issuer: context.issuer,
                authorizationEndpoint: context.authorizationEndpoint,
                tokenEndpoint: context.tokenEndpoint,
                redirectUri: context.redirectUri,
                clientId: context.clientId,
                clientSecret: context.clientSecret,
              }
            ),
          });
        })
      : (generateId() as MCPOAuthAttemptID);

    let tokenPromise: Promise<OAuthTokenResponse> | undefined;
    let tokenResolve: ((t: OAuthTokenResponse) => void) | undefined;
    let tokenReject: ((err: Error) => void) | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    if (awaitToken && !durableOAuthFlows) {
      tokenPromise = new Promise<OAuthTokenResponse>((resolve, reject) => {
        // Wrap resolve/reject to also clear the per-request timeout so it
        // can't fire after a fast success/error path.
        tokenResolve = (t) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolve(t);
        };
        tokenReject = (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        };
        timeoutHandle = setTimeout(() => {
          // Drop the pending entry so the eventual callback (if any) sees
          // "expired or not found" instead of double-resolving.
          if (!durableOAuthFlows) {
            const pending = pendingOAuthFlows.get(context.state);
            if (pending) {
              pendingOAuthFlows.delete(context.state);
              localOAuthAttemptStatuses.set(attemptId, {
                status: 'expired',
                userId: opts.userId,
                tenantId: opts.tenantId,
                mcpServerId: opts.mcpServerId,
                oauthMode: opts.oauthMode,
                failureCode: 'authorization_timed_out',
                updatedAt: Date.now(),
              });
            }
          }
          reject(
            new Error(
              `Timed out after ${Math.round(AWAIT_TOKEN_TIMEOUT_MS / 1000)}s waiting for OAuth callback. ` +
                'The user may not have completed the browser sign-in.'
            )
          );
        }, AWAIT_TOKEN_TIMEOUT_MS);
      });
    }

    if (!durableOAuthFlows) {
      for (const [olderState, older] of pendingOAuthFlows) {
        const sameSubject =
          older.tenantId === (opts.tenantId ?? getCurrentTenantId()) &&
          older.mcpServerId === opts.mcpServerId &&
          (older.oauthMode ?? 'per_user') === (opts.oauthMode ?? 'per_user') &&
          ((opts.oauthMode ?? 'per_user') === 'shared' || older.userId === opts.userId);
        if (!sameSubject) continue;
        pendingOAuthFlows.delete(olderState);
        markLocalOAuthAttempt(older, 'failed', 'superseded_by_newer_attempt');
        older.tokenReject?.(new Error('A newer OAuth attempt replaced this flow'));
      }
      pendingOAuthFlows.set(context.state, {
        attemptId,
        context,
        mcpServerId: opts.mcpServerId,
        userId: opts.userId,
        oauthMode: opts.oauthMode,
        tenantId: opts.tenantId ?? getCurrentTenantId(),
        socketId: opts.socketId,
        createdAt: Date.now(),
        tokenResolve,
        tokenReject,
      });
      localOAuthAttemptStatuses.set(attemptId, {
        status: 'pending',
        userId: opts.userId,
        tenantId: opts.tenantId,
        mcpServerId: opts.mcpServerId,
        oauthMode: opts.oauthMode,
        updatedAt: Date.now(),
      });
    }

    if (awaitToken && opts.socketId && app.io) {
      // Compatibility hint for blocking discover/test callers, which cannot
      // return the URL before their callback arrives. Target the exact
      // authenticated initiating socket only — never a user/tenant/global
      // room — and keep durable status as the completion authority.
      app.io.local.to(opts.socketId).emit('oauth:open_browser', {
        authUrl: context.authorizationUrl,
        attempt_id: attemptId,
      });
    }

    const base: StartTwoPhaseOAuthResult = {
      attemptId,
      state: context.state,
      authorizationUrl: context.authorizationUrl,
      redirectUri,
    };
    if (awaitToken) {
      if (durableBinding) {
        const awaitDurableToken = async (): Promise<OAuthTokenResponse> => {
          const deadline = Date.now() + AWAIT_TOKEN_TIMEOUT_MS;
          while (Date.now() < deadline) {
            const attempt = await durableOAuthFlows!.getForUser(
              durableBinding.tenantId,
              durableBinding.userId,
              attemptId
            );
            if (!attempt) throw new Error('OAuth attempt is no longer available. Restart OAuth.');
            if (attempt.status === 'succeeded') {
              const tokenUserId: UserID | null =
                durableBinding.oauthMode === 'per_user' ? durableBinding.userId : null;
              const token = await runInOAuthTenantScope(db, durableBinding.tenantId, () =>
                new UserMCPOAuthTokenRepository(db).getToken(
                  tokenUserId,
                  durableBinding.mcpServerId
                )
              );
              if (!token) {
                throw new Error('OAuth completed without a durable token. Restart OAuth.');
              }
              return {
                access_token: token.oauth_access_token,
                token_type: 'bearer',
                ...(token.oauth_token_expires_at
                  ? {
                      expires_in: Math.max(
                        0,
                        Math.floor((token.oauth_token_expires_at.getTime() - Date.now()) / 1000)
                      ),
                    }
                  : {}),
              };
            }
            if (['failed', 'ambiguous', 'expired'].includes(attempt.status)) {
              throw new Error(
                attempt.status === 'ambiguous'
                  ? 'OAuth exchange outcome is ambiguous. Start a new OAuth flow; the previous authorization code will not be replayed.'
                  : 'OAuth did not complete. Start a new OAuth flow.'
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          throw new Error(
            'Timed out waiting for OAuth callback. Restart OAuth if it completes later.'
          );
        };
        return { ...base, awaitToken: awaitDurableToken };
      }
      return { ...base, awaitToken: () => tokenPromise! };
    }
    return base;
  }

  const tenantIdFromParams = (params?: AuthenticatedParams): string | undefined =>
    (params as (AuthenticatedParams & { tenant?: { tenant_id?: string } }) | undefined)?.tenant
      ?.tenant_id ?? getCurrentTenantId();

  const assertDurableFlowStillAuthorized = async (
    pendingFlow: PendingOAuthFlow,
    afterProviderExchange = false
  ): Promise<void> => {
    const record = pendingFlow.durableRecord;
    if (!record) return;
    try {
      await runInOAuthTenantScope(db, record.tenantId, async () => {
        const [server, user] = await Promise.all([
          new MCPServerRepository(db).findById(record.mcpServerId),
          new UsersRepository(db).findById(record.userId),
        ]);
        if (
          !server?.enabled ||
          !user ||
          server.auth?.type !== 'oauth' ||
          (server.auth.oauth_mode ?? 'per_user') !== record.oauthMode ||
          server.url !== pendingFlow.context.resourceUri ||
          !isMCPOAuthGrantBindingVersion(record.configFingerprintVersion)
        ) {
          throw new Error('MCP OAuth server configuration changed; restart authorization');
        }
        if (record.oauthMode === 'shared' && !hasMinimumRole(user.role, ROLES.ADMIN)) {
          throw new Error('Shared MCP OAuth grant requires current admin access');
        }
        const fingerprint = fingerprintMCPOAuthGrantConfiguration(
          process.env.AGOR_MASTER_SECRET!,
          server,
          {
            resourceUri: pendingFlow.context.resourceUri,
            metadataUrl: pendingFlow.context.metadataUrl,
            issuer: pendingFlow.context.issuer,
            authorizationEndpoint: pendingFlow.context.authorizationEndpoint,
            tokenEndpoint: pendingFlow.context.tokenEndpoint,
            redirectUri: pendingFlow.context.redirectUri,
            clientId: pendingFlow.context.clientId,
            clientSecret: pendingFlow.context.clientSecret,
          },
          record.configFingerprintVersion
        );
        if (fingerprint !== record.configFingerprint) {
          throw new Error('MCP OAuth grant binding changed; restart authorization');
        }
      });
    } catch {
      throw new OAuthFlowAuthorizationChangedError(afterProviderExchange);
    }
  };

  const persistOAuthTokenForPendingFlow = async (
    tokenResponse: OAuthTokenResponse,
    pendingFlow: PendingOAuthFlow,
    logPrefix: string
  ): Promise<void> => {
    const durableRecord = pendingFlow.durableRecord;
    const durableGrantBindingVersion = durableRecord
      ? (() => {
          const version = durableRecord.configFingerprintVersion;
          if (!isMCPOAuthGrantBindingVersion(version)) {
            throw new Error('Unsupported MCP OAuth grant binding version');
          }
          return version;
        })()
      : undefined;
    const work = () =>
      persistOAuthToken(
        db,
        tokenResponse,
        {
          ...pendingFlow,
          clientId: pendingFlow.context.clientId,
          clientSecret: pendingFlow.context.clientSecret,
          tokenEndpoint: pendingFlow.context.tokenEndpoint,
          resourceUri: pendingFlow.context.resourceUri,
          ...(pendingFlow.durableRecord
            ? {
                grantBinding: {
                  generation: pendingFlow.durableRecord.grantGeneration,
                  version: durableGrantBindingVersion!,
                  fingerprint: pendingFlow.durableRecord.configFingerprint,
                  metadataUri: pendingFlow.context.metadataUrl,
                  resourceUri: pendingFlow.context.resourceUri,
                  issuer: pendingFlow.context.issuer,
                  authorizationEndpoint: pendingFlow.context.authorizationEndpoint,
                  tokenEndpoint: pendingFlow.context.tokenEndpoint,
                  redirectUri: pendingFlow.context.redirectUri,
                },
              }
            : {}),
        },
        logPrefix
      );

    const persistAndFinish = async () => {
      // Recheck role and the complete server/config fingerprint inside the same
      // transaction that persists the grant and consumes the success fence.
      if (pendingFlow.durableRecord) {
        await lockMCPOAuthGrantConfiguration(
          db,
          pendingFlow.durableRecord.tenantId,
          pendingFlow.durableRecord.mcpServerId
        );
      }
      await assertDurableFlowStillAuthorized(pendingFlow, true);
      await work();
      if (pendingFlow.durableRecord) {
        const transitioned = await durableOAuthFlows!.finish(
          pendingFlow.durableRecord,
          'succeeded'
        );
        if (!transitioned) {
          throw new Error('OAuth pending-flow success claim was lost');
        }
      }
    };

    if (pendingFlow.tenantId) {
      await runInOAuthTenantWriteScope(db, pendingFlow.tenantId, persistAndFinish);
      return;
    }

    // OAuth callbacks arrive as unauthenticated browser redirects, so they
    // cannot re-resolve tenant scope from request auth. In Postgres/multitenant
    // deployments, a flow without captured tenant metadata is unsafe to persist:
    // fail closed and ask the user to restart the OAuth flow. SQLite/single-user
    // installs do not have tenant DB scope, so they keep the legacy direct path.
    if (isPostgresDatabaseHandle(db) && pendingFlow.mcpServerId) {
      throw new Error(
        'Missing tenant context for MCP OAuth callback. Please restart the OAuth flow.'
      );
    }

    await persistAndFinish();
  };

  const markLocalOAuthAttempt = (
    pendingFlow: PendingOAuthFlow,
    status: MCPOAuthPendingFlowStatus,
    failureCode?: string
  ) => {
    localOAuthAttemptStatuses.set(pendingFlow.attemptId, {
      status,
      userId: pendingFlow.userId,
      tenantId: pendingFlow.tenantId,
      mcpServerId: pendingFlow.mcpServerId,
      oauthMode: pendingFlow.oauthMode,
      failureCode,
      updatedAt: Date.now(),
    });
  };

  const emitOAuthCompletion = (pendingFlow: PendingOAuthFlow, success: boolean) => {
    if (!app.io) return;
    const event = {
      attempt_id: pendingFlow.attemptId,
      success,
      mcp_server_id: pendingFlow.mcpServerId,
      oauth_mode: pendingFlow.oauthMode || 'per_user',
    };
    if (pendingFlow.tenantId) {
      const room =
        event.oauth_mode === 'per_user' && pendingFlow.userId
          ? tenantUserChannelName(pendingFlow.tenantId, pendingFlow.userId)
          : tenantChannelName(pendingFlow.tenantId);
      emitHaNativeSocketEvent(app.io.to(room), 'oauth:completed', event);
    } else if (pendingFlow.socketId) {
      // Standalone defensive fallback: exact originating socket only. Never
      // globally broadcast OAuth attempt metadata or authorization URLs.
      app.io.local.to(pendingFlow.socketId).emit('oauth:completed', event);
    }
  };

  const pendingFromDurableClaim = (
    claimed: ReturnType<MCPOAuthPendingFlowAuthority['openClaim']>
  ): PendingOAuthFlow => ({
    attemptId: claimed.record.attemptId,
    context: claimed.context,
    mcpServerId: claimed.record.mcpServerId,
    userId: claimed.record.userId,
    oauthMode: claimed.record.oauthMode,
    tenantId: claimed.record.tenantId,
    createdAt: claimed.record.createdAt.getTime(),
    durableRecord: claimed.record,
  });

  const terminalMessageForStatus = (status: MCPOAuthPendingFlowStatus): string => {
    if (status === 'succeeded') {
      return 'OAuth authentication already completed. You can close this tab.';
    }
    if (status === 'ambiguous' || status === 'exchanging') {
      return 'OAuth exchange outcome is uncertain. Start a new OAuth flow; the previous authorization code will not be replayed.';
    }
    return 'OAuth flow did not complete. Please start a new flow.';
  };

  // Set the OAuth callback handler
  const oauthCallbackHandler = async (req: express.Request, res: express.Response) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const code = req.query.code as string | undefined;
      const state = req.query.state as string | undefined;
      const issuer = req.query.iss as string | undefined;
      const error = req.query.error as string | undefined;

      if (error) {
        console.warn('[OAuth Callback] Provider authorization was not completed');
        // Reject any awaitToken() promise from the originating flow so the
        // caller (discover / test-oauth) can surface the failure.
        if (state) {
          if (durableOAuthFlows) {
            await durableOAuthFlows.failPendingCallback(state, 'authorization_denied');
          } else {
            const pending = pendingOAuthFlows.get(state);
            pending?.tokenReject?.(new Error('Authorization was not completed'));
            if (pending) markLocalOAuthAttempt(pending, 'failed', 'authorization_denied');
            pendingOAuthFlows.delete(state);
          }
        }
        res
          .status(400)
          .send(oauthResultPage(false, 'Authorization was not completed. Please restart OAuth.'));
        return;
      }

      if (!code || !state) {
        res.status(400).send(oauthResultPage(false, 'Missing code or state parameter'));
        return;
      }

      let pendingFlow: PendingOAuthFlow | undefined;
      if (durableOAuthFlows) {
        const claimed = await durableOAuthFlows.claimForCallback(state);
        if (claimed.outcome === 'not_claimed') {
          if (claimed.flow?.status === 'succeeded') {
            res.send(oauthResultPage(true, terminalMessageForStatus('succeeded')));
            return;
          }
          res
            .status(409)
            .send(
              oauthResultPage(
                false,
                claimed.flow
                  ? terminalMessageForStatus(claimed.flow.status)
                  : 'OAuth flow expired or not found. Please start the flow again.'
              )
            );
          return;
        }
        try {
          pendingFlow = pendingFromDurableClaim(durableOAuthFlows.openClaim(claimed.flow, state));
        } catch {
          await durableOAuthFlows.finish(claimed.flow, 'failed', 'sealed_material_unavailable');
          res
            .status(409)
            .send(oauthResultPage(false, 'OAuth flow cannot be resumed. Please start again.'));
          return;
        }
      } else {
        pendingFlow = pendingOAuthFlows.get(state);
        if (pendingFlow) {
          // Consume before the provider call. A second callback can never run
          // the single-use authorization code concurrently.
          pendingOAuthFlows.delete(state);
          markLocalOAuthAttempt(pendingFlow, 'exchanging');
        }
      }
      if (!pendingFlow) {
        res
          .status(400)
          .send(
            oauthResultPage(false, 'OAuth flow expired or not found. Please start the flow again.')
          );
        return;
      }

      try {
        await assertDurableFlowStillAuthorized(pendingFlow);
        const { completeMCPOAuthFlow } = await import('@agor/core/tools/mcp/oauth-mcp-transport');
        const tokenResponse = await completeMCPOAuthFlow(pendingFlow.context, code, state, {
          cacheToken: false,
          issuer,
        });

        await persistOAuthTokenForPendingFlow(tokenResponse, pendingFlow, 'OAuth Callback');
        if (!pendingFlow.durableRecord) markLocalOAuthAttempt(pendingFlow, 'succeeded');
        emitOAuthCompletion(pendingFlow, true);

        // Notify any awaitToken() callers (discover / test-oauth) that the
        // token has been exchanged + persisted so their HTTP request can
        // complete with a real result instead of timing out.
        pendingFlow.tokenResolve?.(tokenResponse);

        console.log('[OAuth Callback] Flow completed successfully');
        res.send(oauthResultPage(true, 'OAuth authentication successful! You can close this tab.'));
      } catch (innerErr) {
        const classification = classifyMCPOAuthCompletionFailure(innerErr);
        const { ambiguous } = classification;
        if (pendingFlow.durableRecord) {
          try {
            await durableOAuthFlows!.finish(
              pendingFlow.durableRecord,
              classification.status,
              classification.failureCode
            );
          } catch {
            // The durable row remains exchanging and maintenance will age it
            // to ambiguous. Never claim the authorization code is replayable.
          }
        } else {
          markLocalOAuthAttempt(pendingFlow, classification.status, classification.failureCode);
        }
        emitOAuthCompletion(pendingFlow, false);
        pendingFlow.tokenReject?.(
          new Error(
            ambiguous
              ? 'OAuth exchange outcome is ambiguous. Start a new OAuth flow.'
              : 'OAuth provider rejected the authorization. Start a new OAuth flow.'
          )
        );
        res
          .status(ambiguous ? 409 : 400)
          .send(
            oauthResultPage(false, terminalMessageForStatus(ambiguous ? 'ambiguous' : 'failed'))
          );
        return;
      }
    } catch (err) {
      console.error(
        `[OAuth Callback] Failed category=${err instanceof Error ? err.name : 'unknown'}`
      );
      res
        .status(500)
        .send(
          oauthResultPage(
            false,
            'Authentication could not be completed. Please start a new OAuth flow.'
          )
        );
    }
  };

  app.use('/mcp-servers', createMCPServersService(db));
  const invalidateOAuthGrantsAfterServerChange = async (
    context: HookContext,
    next: () => Promise<void>
  ) => {
    const tenantId = tenantIdFromParams(context.params as AuthenticatedParams);
    const serverId = String(context.id ?? '');
    await runInOAuthTenantWriteScope(db, tenantId, async () => {
      if (durableOAuthFlows && tenantId && serverId) {
        await lockMCPOAuthGrantConfiguration(db, tenantId, serverId as MCPServerID);
      }
      const before = serverId ? await new MCPServerRepository(db).findById(serverId) : null;
      await next();
      const after = serverId ? await new MCPServerRepository(db).findById(serverId) : null;
      if (!hasMCPOAuthRelevantServerConfigurationChanged(before, after)) return;
      await new UserMCPOAuthTokenRepository(db).deleteAllForServer(serverId as MCPServerID);
      if (durableOAuthFlows && tenantId) {
        await durableOAuthFlows.invalidateForServer(tenantId, serverId as MCPServerID);
      } else {
        for (const [state, flow] of pendingOAuthFlows) {
          if (flow.mcpServerId !== serverId) continue;
          pendingOAuthFlows.delete(state);
          markLocalOAuthAttempt(flow, 'failed', 'server_configuration_changed');
          flow.tokenReject?.(new Error('MCP OAuth server configuration changed'));
        }
      }
      console.log('[MCP OAuth Grant] grants_invalidated category=server_configuration_changed');
    });
  };
  app.service('mcp-servers').hooks({
    around: {
      patch: [invalidateOAuthGrantsAfterServerChange],
      update: [invalidateOAuthGrantsAfterServerChange],
    },
  });

  // Read-only marketplace browse surface. Only find/get are exposed; the
  // catalog's writers are the ingestion job and the curated.yaml seeder.
  app.use('/mcp-catalog', createMCPCatalogService(db), { methods: ['find', 'get'] });

  // JWT test endpoint
  app.use('/mcp-servers/test-jwt', {
    async create(data: {
      api_url: string;
      api_token: string;
      api_secret: string;
      mcp_url?: string;
    }) {
      try {
        const response = await oauthFetch(data.api_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: data.api_token, secret: data.api_secret }),
        });
        if (!response.ok) {
          const errorText = await response.text();
          return {
            success: false,
            error: `JWT fetch failed: HTTP ${response.status}: ${errorText}`,
          };
        }
        const result = (await response.json()) as {
          access_token?: string;
          payload?: { access_token?: string };
        };
        const token = result.access_token || result.payload?.access_token;
        if (!token) return { success: false, error: 'Response missing access_token' };
        return { success: true, tokenValid: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  app.service('mcp-servers/test-jwt').hooks({ before: { create: [ctx.requireAuth] } });

  /**
   * Some MCP servers (e.g. Google's Gmail/Calendar remote MCP servers) allow
   * unauthenticated `initialize`/`tools/list` and only return 401 once a real
   * tool is invoked (auth is enforced per tool-call, not at the handshake).
   * A bare `initialize` probe misreads these as "no auth required". Before
   * giving up, retry against a tool the server itself marks safe to call
   * (`readOnlyHint: true`) so we don't risk side effects on write tools.
   * Returns the 401 Response if one is found this way, otherwise null.
   */
  async function probeMcpAuthViaReadOnlyToolCall(mcpUrl: string): Promise<Response | null> {
    try {
      const listResponse = await oauthFetch(mcpUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!listResponse.ok) return null;

      const listBody = (await listResponse.json()) as {
        result?: { tools?: Array<{ name?: string; annotations?: { readOnlyHint?: boolean } }> };
      };
      const readOnlyTool = listBody.result?.tools?.find(
        (tool) => tool.annotations?.readOnlyHint === true && typeof tool.name === 'string'
      );
      if (!readOnlyTool?.name) return null;

      const callResponse = await oauthFetch(mcpUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 2,
          params: { name: readOnlyTool.name, arguments: {} },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      return callResponse.status === 401 ? callResponse : null;
    } catch (probeError) {
      console.log(
        '[OAuth Probe] Read-only tool-call fallback probe failed:',
        probeError instanceof Error ? probeError.message : String(probeError)
      );
      return null;
    }
  }

  // OAuth 2.0/2.1 test endpoint (large — kept inline for now)
  app.use('/mcp-servers/test-oauth', {
    async create(
      data: {
        mcp_url: string;
        mcp_server_id?: string;
        token_url?: string;
        client_id?: string;
        client_secret?: string;
        scope?: string;
        grant_type?: string;
        start_browser_flow?: boolean;
        compatibility_mode?: 'strict' | 'legacy';
        dcr_mode?: MCPOAuthDCRMode;
      },
      params?: AuthenticatedParams & { connection?: { id?: string } }
    ) {
      try {
        // Completing this flow writes a shared token onto the named row and
        // backfills its token endpoint, so the same rule the other flow-start
        // endpoints apply has to apply here. Testing a not-yet-created server
        // passes no id and is unaffected.
        if (data.mcp_server_id) {
          await runInOAuthTenantScope(
            db,
            tenantIdFromParams(params as AuthenticatedParams | undefined),
            () =>
              loadMcpServerForCaller(
                db,
                data.mcp_server_id as string,
                params as AuthenticatedParams | undefined
              )
          );
        }

        console.log('[OAuth Test] Probing configured MCP server');

        let probeResponse: Response;
        try {
          probeResponse = await oauthFetch(data.mcp_url, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (fetchError) {
          return {
            success: false,
            error: `Failed to connect to MCP server: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
          };
        }

        if (probeResponse.status !== 401) {
          const fallbackProbe = await probeMcpAuthViaReadOnlyToolCall(data.mcp_url);
          if (fallbackProbe) {
            console.log(
              '[OAuth Test] Handshake-level probe returned no auth requirement; ' +
                'a read-only tool call did — server defers auth to tool invocation.'
            );
            probeResponse = fallbackProbe;
          }
        }

        const wwwAuthenticate = probeResponse.headers.get('www-authenticate');
        const allHeaders: Record<string, string> = {};
        probeResponse.headers.forEach((value, key) => {
          allHeaders[key] = value;
        });
        console.log(`[OAuth Test] Probe response status=${probeResponse.status}`);

        const compatibilityMode = data.compatibility_mode ?? 'strict';
        let metadataUrl: string | null = null;
        let prefetchedAuthServerMetadata:
          | import('@agor/core/tools/mcp/oauth-mcp-transport').AuthorizationServerMetadata
          | null = null;
        let discoverySource: string | null = null;
        if (probeResponse.status === 401) {
          const { resolveMCPOAuthDiscovery } = await import(
            '@agor/core/tools/mcp/oauth-mcp-transport'
          );
          const discovery = await resolveMCPOAuthDiscovery(wwwAuthenticate, data.mcp_url, {
            compatibilityMode,
            allowLocalhostHttp: !durableOAuthFlows,
          });
          if (discovery?.kind === 'resource-metadata') {
            metadataUrl = discovery.metadataUrl;
            discoverySource = `RFC 9728 ${discovery.source}`;
            console.log(`[OAuth Test] Resolved resource metadata source=${discovery.source}`);
          } else if (discovery?.kind === 'authorization-server') {
            prefetchedAuthServerMetadata = discovery.authServerMetadata;
            discoverySource = `AS-direct (${discovery.discoveredAt})`;
            console.log('[OAuth Test] Resolved authorization-server metadata directly');
          }
        }

        if (probeResponse.status === 401 && (metadataUrl || prefetchedAuthServerMetadata)) {
          console.log('[OAuth Test] OAuth 2.1 auto-discovery detected');

          if (data.start_browser_flow) {
            if (!hasMinimumRole((params as AuthenticatedParams)?.user?.role, ROLES.ADMIN)) {
              throw new Forbidden('Shared MCP OAuth grants can only be started by an admin');
            }
            console.log('[OAuth Test] Starting browser-based OAuth 2.1 flow...');

            try {
              const connection = (params as AuthenticatedParams)?.connection as
                | { id?: string }
                | undefined;

              // Route through the daemon's two-phase flow so the redirect_uri
              // is the daemon's public base URL (browser-reachable for any
              // user) rather than a 127.0.0.1 callback server bound to the
              // daemon process.
              let started: StartTwoPhaseOAuthAndAwaitResult;
              try {
                started = await startTwoPhaseMCPOAuthFlowAndAwaitToken({
                  mcpUrl: data.mcp_url,
                  wwwAuthenticate: wwwAuthenticate || '',
                  resourceMetadataUrl: metadataUrl ?? undefined,
                  prefetchedAuthServerMetadata: prefetchedAuthServerMetadata ?? undefined,
                  mcpServerId: data.mcp_server_id,
                  userId: (params as AuthenticatedParams)?.user?.user_id,
                  // Test endpoint mirrors the previous saveOAuth21TokenToDB
                  // call (writes to the shared MCP server row, not per-user).
                  oauthMode: 'shared',
                  clientId: data.client_id,
                  tenantId: tenantIdFromParams(params as AuthenticatedParams | undefined),
                  socketId: connection?.id,
                  clientSecret: data.client_secret,
                  scope: data.scope,
                  compatibilityMode,
                  dcrMode: data.dcr_mode,
                });
              } catch (err) {
                if (err instanceof PublicBaseUrlNotConfiguredError) {
                  return { success: false, error: err.message, oauthType: 'oauth2.1' };
                }
                throw err;
              }

              const tokenResponse = await started.awaitToken();

              const testResponse = await oauthFetch(data.mcp_url, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${tokenResponse.access_token}`,
                  Accept: 'application/json',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
                signal: AbortSignal.timeout(15_000),
              });

              return {
                success: true,
                oauthType: 'oauth2.1',
                message: 'OAuth 2.1 authentication successful!',
                tokenValid: true,
                mcpStatus: testResponse.status,
                mcpStatusText: testResponse.statusText,
              };
            } catch (flowError) {
              console.error(
                `[OAuth Test] Browser flow failed category=${
                  flowError instanceof Error ? flowError.name : 'unknown'
                }`
              );
              return {
                success: false,
                error: `OAuth 2.1 browser flow failed: ${flowError instanceof Error ? flowError.message : String(flowError)}`,
                oauthType: 'oauth2.1',
              };
            }
          }

          // Just validate metadata without browser flow
          try {
            // AS-direct path: we already have AS metadata, no resource metadata
            // to fetch. Short-circuit with what we discovered.
            if (prefetchedAuthServerMetadata) {
              return {
                success: true,
                oauthType: 'oauth2.1',
                message: prefetchedAuthServerMetadata.registration_endpoint
                  ? `OAuth 2.1 auto-discovery successful via ${discoverySource} (DCR supported). Click "Start OAuth Flow" to authenticate.`
                  : `OAuth 2.1 auto-discovery successful via ${discoverySource}. Click "Start OAuth Flow" to authenticate.`,
                authServerMetadata: {
                  authorizationEndpoint: prefetchedAuthServerMetadata.authorization_endpoint,
                  tokenEndpoint: prefetchedAuthServerMetadata.token_endpoint,
                  registrationEndpoint: prefetchedAuthServerMetadata.registration_endpoint,
                },
                supportsDynamicClientRegistration:
                  !!prefetchedAuthServerMetadata.registration_endpoint,
                requiresBrowserFlow: true,
                discoverySource,
              };
            }

            // RFC 9728 path: fetch resource metadata to get the AS URL.
            // (Above guard ensures `metadataUrl` is set when we reach here.)
            const rfc9728Url = metadataUrl as string;
            const metadataResponse = await oauthFetch(rfc9728Url);
            if (!metadataResponse.ok) {
              return {
                success: false,
                error: `OAuth resource metadata endpoint returned ${metadataResponse.status}`,
                oauthType: 'oauth2.1',
                metadataUrl: rfc9728Url,
                requiresBrowserFlow: true,
              };
            }

            const metadata = (await metadataResponse.json()) as {
              authorization_servers?: string[];
              scopes_supported?: string[];
            };
            if (!metadata.authorization_servers || metadata.authorization_servers.length === 0) {
              return {
                success: false,
                error: 'OAuth resource metadata missing authorization_servers',
                oauthType: 'oauth2.1',
                metadataUrl: rfc9728Url,
                metadata,
              };
            }

            const authServerUrl = metadata.authorization_servers[0];
            // Reuse core's fetchAuthorizationServerMetadata so we get RFC 8414
            // path-aware insertion + OIDC path-append fallback. The previous
            // hand-rolled `${authServerUrl}${wellKnownPath}` loop only worked
            // for root-issuer servers and silently mis-reported "no metadata"
            // for path-bearing issuers.
            const { fetchAuthorizationServerMetadata } = await import(
              '@agor/core/tools/mcp/oauth-mcp-transport'
            );
            let authServerMetadata: {
              authorization_endpoint?: string;
              token_endpoint?: string;
              registration_endpoint?: string;
            } | null = null;
            try {
              authServerMetadata = await fetchAuthorizationServerMetadata(authServerUrl);
              console.log('[OAuth Test] Authorization-server metadata resolved');
            } catch {
              console.log('[OAuth Test] Authorization-server metadata unavailable');
            }

            return {
              success: true,
              oauthType: 'oauth2.1',
              message: authServerMetadata?.registration_endpoint
                ? 'OAuth 2.1 auto-discovery successful (DCR supported). Click "Start OAuth Flow" to authenticate.'
                : 'OAuth 2.1 auto-discovery successful. Click "Start OAuth Flow" to authenticate.',
              metadataUrl: rfc9728Url,
              authorizationServers: metadata.authorization_servers,
              scopesSupported: metadata.scopes_supported,
              authServerMetadata: authServerMetadata
                ? {
                    authorizationEndpoint: authServerMetadata.authorization_endpoint,
                    tokenEndpoint: authServerMetadata.token_endpoint,
                    registrationEndpoint: authServerMetadata.registration_endpoint,
                  }
                : null,
              supportsDynamicClientRegistration: !!authServerMetadata?.registration_endpoint,
              requiresBrowserFlow: true,
            };
          } catch (metadataError) {
            return {
              success: false,
              error: `Failed to fetch OAuth metadata: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}`,
              oauthType: 'oauth2.1',
              metadataUrl: metadataUrl ?? undefined,
            };
          }
        }

        if (probeResponse.ok) {
          return {
            success: true,
            oauthType: 'none',
            message: 'MCP server accessible without authentication',
            mcpStatus: probeResponse.status,
          };
        }

        if (probeResponse.status === 401) {
          let responseBody = '';
          try {
            responseBody = await probeResponse.text();
          } catch {
            /* Ignore */
          }

          if (data.client_id && data.client_secret) {
            console.log('[OAuth Test] Using Client Credentials flow');
            const { fetchOAuthToken, inferOAuthTokenUrl } = await import(
              '@agor/core/tools/mcp/oauth-auth'
            );
            let tokenUrl = data.token_url;
            let tokenUrlSource: 'provided' | 'auto-detected' = 'provided';
            if (!tokenUrl) {
              tokenUrl = inferOAuthTokenUrl(data.mcp_url);
              tokenUrlSource = 'auto-detected';
              if (!tokenUrl)
                return {
                  success: false,
                  error: 'Could not auto-detect OAuth token URL. Please provide it explicitly.',
                  oauthType: 'client_credentials',
                };
            }
            const { token, debugInfo } = await fetchOAuthToken(
              {
                token_url: tokenUrl,
                client_id: data.client_id,
                client_secret: data.client_secret,
                scope: data.scope,
                grant_type: data.grant_type || 'client_credentials',
                allowLocalhostHttp: !durableOAuthFlows,
                cacheNamespace: [
                  tenantIdFromParams(params as AuthenticatedParams | undefined) ?? '<standalone>',
                  data.mcp_server_id ?? '<unsaved>',
                  (params as AuthenticatedParams | undefined)?.user?.user_id ?? '<unknown-user>',
                ].join(':'),
                cache: !durableOAuthFlows,
              },
              true
            );
            let mcpStatus: number | undefined;
            let mcpStatusText: string | undefined;
            try {
              const mcpResponse = await oauthFetch(data.mcp_url, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: 'application/json',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
              });
              mcpStatus = mcpResponse.status;
              mcpStatusText = mcpResponse.statusText;
            } catch (mcpError) {
              mcpStatusText = mcpError instanceof Error ? mcpError.message : 'Connection failed';
            }
            return {
              success: true,
              oauthType: 'client_credentials',
              tokenValid: true,
              tokenUrlSource,
              mcpStatus,
              mcpStatusText,
              debugInfo,
            };
          }

          return {
            success: false,
            error:
              'Server requires authentication (401) but OAuth 2.1 auto-discovery failed at every step.',
            oauthType: 'unknown',
            mcpStatus: probeResponse.status,
            wwwAuthenticate: wwwAuthenticate || '<not present>',
            responseHeaders: allHeaders,
            responseBody: responseBody.substring(0, 500),
            hint:
              `${DISCOVERY_CASCADE_TRIED} ` +
              'None returned valid metadata. Options: (a) provide Client Credentials with explicit token URL, ' +
              '(b) ask the MCP server operator to publish OAuth metadata, or (c) configure manual OAuth URLs in the server settings.',
          };
        }

        return {
          success: false,
          error: `MCP server returned ${probeResponse.status} ${probeResponse.statusText}`,
          mcpStatus: probeResponse.status,
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  app.service('mcp-servers/test-oauth').hooks({ before: { create: [ctx.requireAuth] } });

  // OAuth start endpoint
  app.use('/mcp-servers/oauth-start', {
    async create(
      data: { mcp_url: string; mcp_server_id?: string; client_id?: string },
      params?: AuthenticatedParams
    ) {
      try {
        console.log('[OAuth Start] Starting two-phase OAuth flow');
        const userId = params?.user?.user_id;
        const tenantId = tenantIdFromParams(params);

        let oauthMode: 'per_user' | 'shared' | undefined;
        let authorizationUrlOverride: string | undefined;
        let tokenUrlOverride: string | undefined;
        let clientSecretOverride: string | undefined;
        let clientIdFromConfig: string | undefined;
        let scopeOverride: string | undefined;
        let compatibilityMode: 'strict' | 'legacy' = 'strict';
        let dcrMode: MCPOAuthDCRMode | undefined;
        const savedServerId = data.mcp_server_id;
        // Its stored OAuth client configuration belongs to whoever owns the
        // row; a caller who may not use the server may not borrow it either.
        const savedServer = savedServerId
          ? await runInOAuthTenantScope(db, tenantId, () => {
              return loadMcpServerForCaller(db, savedServerId, params);
            })
          : null;

        if (
          savedServerId &&
          (!savedServer?.enabled || !savedServer.url || savedServer.auth?.type !== 'oauth')
        ) {
          return {
            success: false,
            error:
              'OAuth requires an enabled, saved MCP server in the current tenant. Save changes, then restart OAuth.',
          };
        }

        // Once an ID is supplied, its tenant-scoped row is authoritative for
        // the provider URL and client configuration. The duplicate payload
        // fields remain accepted only for older callers.
        const effectiveMcpUrl = savedServer?.url ?? data.mcp_url;

        // PostgreSQL is the shared authority, so reject transient or stale
        // server input before the first outbound probe. Doing this only in the
        // later flow helper would still let any authenticated caller use
        // mcp_url as an arbitrary pre-validation network destination.
        if (
          durableOAuthFlows &&
          (!savedServer?.enabled ||
            savedServer.url !== effectiveMcpUrl ||
            savedServer.auth?.type !== 'oauth')
        ) {
          return {
            success: false,
            error:
              'PostgreSQL OAuth requires an enabled, saved MCP server matching this request. Save changes, then restart OAuth.',
          };
        }

        if (savedServer?.auth?.type === 'oauth') {
          oauthMode = savedServer.auth.oauth_mode || 'per_user';
          authorizationUrlOverride = savedServer.auth.oauth_authorization_url;
          tokenUrlOverride = savedServer.auth.oauth_token_url;
          clientIdFromConfig = savedServer.auth.oauth_client_id;
          clientSecretOverride = savedServer.auth.oauth_client_secret;
          scopeOverride = savedServer.auth.oauth_scope;
          compatibilityMode = savedServer.auth.oauth_compatibility_mode ?? 'strict';
          dcrMode = savedServer.auth.oauth_dcr_mode;
          if (oauthMode === 'shared') {
            const currentUser =
              durableOAuthFlows && tenantId && userId
                ? await runInOAuthTenantScope(db, tenantId, () =>
                    new UsersRepository(db).findById(userId)
                  )
                : params?.user;
            if (!hasMinimumRole(currentUser?.role, ROLES.ADMIN)) {
              throw new Forbidden('Shared MCP OAuth grants can only be started by an admin');
            }
          }
        }

        let probeResponse = await oauthFetch(effectiveMcpUrl, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
          signal: AbortSignal.timeout(15_000),
        });

        if (probeResponse.status !== 401) {
          const fallbackProbe = await probeMcpAuthViaReadOnlyToolCall(effectiveMcpUrl);
          if (fallbackProbe) {
            console.log(
              '[OAuth Start] Handshake-level probe returned no auth requirement; ' +
                'a read-only tool call did — server defers auth to tool invocation.'
            );
            probeResponse = fallbackProbe;
          }
        }

        if (probeResponse.status !== 401) {
          return {
            success: false,
            error: 'Server did not return 401 — OAuth 2.1 authentication may not be required',
          };
        }

        const wwwAuthenticate = probeResponse.headers.get('www-authenticate') || '';
        const { resolveMCPOAuthDiscovery } = await import(
          '@agor/core/tools/mcp/oauth-mcp-transport'
        );
        const discovery = await resolveMCPOAuthDiscovery(wwwAuthenticate, effectiveMcpUrl, {
          compatibilityMode,
          allowLocalhostHttp: !durableOAuthFlows,
        });
        if (!discovery) {
          return {
            success: false,
            error: `Server returned 401 but does not advertise OAuth metadata. ${DISCOVERY_CASCADE_TRIED} None succeeded.`,
          };
        }

        const connection = params?.connection as { id?: string } | undefined;
        const socketId = connection?.id;

        let result: StartTwoPhaseOAuthResult;
        try {
          result = await startTwoPhaseMCPOAuthFlow({
            mcpUrl: effectiveMcpUrl,
            wwwAuthenticate,
            resourceMetadataUrl:
              discovery.kind === 'resource-metadata' ? discovery.metadataUrl : undefined,
            prefetchedAuthServerMetadata:
              discovery.kind === 'authorization-server' ? discovery.authServerMetadata : undefined,
            mcpServerId: savedServerId,
            userId,
            oauthMode,
            clientId: savedServer ? clientIdFromConfig : data.client_id,
            clientSecret: clientSecretOverride,
            authorizationUrlOverride,
            tokenUrlOverride,
            scope: scopeOverride,
            tenantId,
            socketId,
            compatibilityMode,
            dcrMode,
          });
        } catch (err) {
          if (err instanceof PublicBaseUrlNotConfiguredError) {
            console.error('[OAuth Start]', err.message);
            return { success: false, error: err.message };
          }
          throw err;
        }

        return {
          success: true,
          authorizationUrl: result.authorizationUrl,
          attempt_id: result.attemptId,
          state: result.state,
          message:
            'Browser opened for authentication. After signing in, copy the callback URL and paste it below.',
        };
      } catch (error) {
        console.error(
          `[OAuth Start] Failed category=${error instanceof Error ? error.name : 'unknown'}`
        );
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  app.service('mcp-servers/oauth-start').hooks({ before: { create: [ctx.requireAuth] } });

  // OAuth complete endpoint
  app.use('/mcp-servers/oauth-complete', {
    async create(
      data: { callback_url: string } | { code: string; state: string; iss?: string },
      params?: AuthenticatedParams
    ) {
      let pendingFlow: PendingOAuthFlow | undefined;
      let completionStatus: 'failed' | 'ambiguous' | undefined;
      try {
        const { completeMCPOAuthFlow, parseOAuthCallback } = await import(
          '@agor/core/tools/mcp/oauth-mcp-transport'
        );
        let code: string;
        let state: string;
        let issuer: string | undefined;
        if ('callback_url' in data) {
          const parsed = parseOAuthCallback(data.callback_url);
          code = parsed.code;
          state = parsed.state;
          issuer = parsed.issuer;
        } else {
          code = data.code;
          state = data.state;
          issuer = data.iss;
        }

        const activeTenantId = tenantIdFromParams(params);
        const activeUserId = params?.user?.user_id as UserID | undefined;
        if (durableOAuthFlows) {
          if (!activeTenantId || !activeUserId) {
            throw new Error('OAuth completion is missing authenticated tenant/user context');
          }
          const claimed = await durableOAuthFlows.claimForUser(activeTenantId, activeUserId, state);
          if (claimed.outcome === 'not_claimed') {
            return {
              success: claimed.flow?.status === 'succeeded',
              error:
                claimed.flow?.status === 'succeeded'
                  ? undefined
                  : terminalMessageForStatus(claimed.flow?.status ?? 'expired'),
              tokenObtained: claimed.flow?.status === 'succeeded',
            };
          }
          pendingFlow = pendingFromDurableClaim(durableOAuthFlows.openClaim(claimed.flow, state));
        } else {
          pendingFlow = pendingOAuthFlows.get(state);
          if (!pendingFlow) {
            return {
              success: false,
              error: 'OAuth flow expired or not found. Please start the flow again.',
            };
          }
          if (pendingFlow.tenantId && activeTenantId && pendingFlow.tenantId !== activeTenantId) {
            return {
              success: false,
              error: 'OAuth flow belongs to a different tenant. Please restart the OAuth flow.',
            };
          }
          if (pendingFlow.userId && activeUserId && pendingFlow.userId !== activeUserId) {
            return {
              success: false,
              error: 'OAuth flow belongs to a different user. Please restart the OAuth flow.',
            };
          }
          pendingOAuthFlows.delete(state);
          markLocalOAuthAttempt(pendingFlow, 'exchanging');
        }

        await assertDurableFlowStillAuthorized(pendingFlow);
        const tokenResponse = await completeMCPOAuthFlow(pendingFlow.context, code, state, {
          cacheToken: false,
          issuer,
        });
        await persistOAuthTokenForPendingFlow(tokenResponse, pendingFlow, 'OAuth Complete');
        if (!pendingFlow.durableRecord) markLocalOAuthAttempt(pendingFlow, 'succeeded');
        emitOAuthCompletion(pendingFlow, true);
        return { success: true, message: 'OAuth authentication successful!', tokenObtained: true };
      } catch (error) {
        if (pendingFlow) {
          const classification = classifyMCPOAuthCompletionFailure(error);
          const { ambiguous, failureCode } = classification;
          completionStatus = classification.status;
          if (pendingFlow.durableRecord) {
            try {
              await durableOAuthFlows!.finish(
                pendingFlow.durableRecord,
                completionStatus,
                failureCode
              );
            } catch {}
          } else {
            markLocalOAuthAttempt(pendingFlow, completionStatus, failureCode);
          }
          emitOAuthCompletion(pendingFlow, false);
          pendingFlow.tokenReject?.(
            new Error(
              ambiguous
                ? 'OAuth exchange outcome is ambiguous. Start a new OAuth flow.'
                : 'OAuth provider rejected the authorization. Start a new OAuth flow.'
            )
          );
        }
        console.error(
          `[OAuth Complete] Failed category=${error instanceof Error ? error.name : 'unknown'}`
        );
        return {
          success: false,
          error: pendingFlow
            ? terminalMessageForStatus(completionStatus ?? 'failed')
            : 'OAuth completion could not be validated. Start a new OAuth flow.',
        };
      }
    },
  });
  app.service('mcp-servers/oauth-complete').hooks({ before: { create: [ctx.requireAuth] } });

  // OAuth disconnect
  app.use('/mcp-servers/oauth-disconnect', {
    async create(data: { mcp_server_id: string }, params?: AuthenticatedParams) {
      await loadMcpServerForCaller(db, data.mcp_server_id, params);
      const tenantId = tenantIdFromParams(params);
      const currentUser =
        tenantId && params?.user?.user_id
          ? await runInOAuthTenantScope(db, tenantId, () =>
              new UsersRepository(db).findById(params.user!.user_id)
            )
          : params?.user;
      const result = await performOAuthDisconnect({
        userId: params?.user?.user_id,
        isAdmin: hasMinimumRole(currentUser?.role, ROLES.ADMIN),
        mcpServerId: data.mcp_server_id,
        userTokenRepo: new UserMCPOAuthTokenRepository(db),
        mcpServerRepo: new MCPServerRepository(db),
      });

      // Tenant-qualified hint only; every receiving tab refetches durable
      // status before changing its auth UI.
      if (result.success && params?.user?.user_id && tenantId) {
        const room =
          result.oauthMode === 'shared'
            ? tenantChannelName(tenantId)
            : tenantUserChannelName(tenantId, params.user.user_id);
        emitHaNativeSocketEvent(app.io.to(room), 'oauth:disconnected', {
          mcp_server_id: data.mcp_server_id as MCPServerID,
        });
      }

      return result;
    },
  });
  app.service('mcp-servers/oauth-disconnect').hooks({ before: { create: [ctx.requireAuth] } });

  // OAuth status
  app.use('/mcp-servers/oauth-status', {
    async find(params?: AuthenticatedParams) {
      const userId = params?.user?.user_id;
      if (!userId) return { authenticated_server_ids: [] };
      try {
        const userTokenRepo = new UserMCPOAuthTokenRepository(db);
        const serverRepo = new MCPServerRepository(db);
        const authenticatedServerIds = await resolveAuthenticatedServerIds({
          viewer: { user_id: userId as UserID, role: params?.user?.role },
          listForUser: (id) => userTokenRepo.listForUser(id),
          listShared: () => userTokenRepo.listShared(),
          findServer: (serverId) => serverRepo.findById(serverId),
          requireGrantBinding: isPostgresDatabaseHandle(db),
          isGrantBoundToServer: (server, grant) =>
            isMCPOAuthGrantBoundToServer(process.env.AGOR_MASTER_SECRET!, server, grant),
        });
        return { authenticated_server_ids: authenticatedServerIds };
      } catch (error) {
        console.error(
          `[OAuth Status] Token lookup failed category=${
            error instanceof Error ? error.name : 'unknown'
          }`
        );
        return { authenticated_server_ids: [] };
      }
    },
  });
  app.service('mcp-servers/oauth-status').hooks({ before: { find: [ctx.requireAuth] } });

  // Authoritative, user-bound pending-attempt status. The UI polls this after
  // opening the provider page; realtime completion is only a latency hint.
  const oauthAttemptStatusService = {
    async get(attemptId: string, params?: AuthenticatedParams) {
      const tenantId = tenantIdFromParams(params);
      const userId = params?.user?.user_id as UserID | undefined;
      if (!tenantId || !userId) throw new NotAuthenticated('OAuth status requires authentication');

      if (durableOAuthFlows) {
        const attempt = await durableOAuthFlows.getForUser(
          tenantId,
          userId,
          attemptId as MCPOAuthAttemptID
        );
        if (!attempt) return { status: 'not_found' as const };
        return {
          status: attempt.status,
          mcp_server_id: attempt.mcpServerId,
          oauth_mode: attempt.oauthMode,
          failure_code: attempt.failureCode ?? undefined,
        };
      }

      const attempt = localOAuthAttemptStatuses.get(attemptId as MCPOAuthAttemptID);
      if (
        !attempt ||
        attempt.userId !== userId ||
        (attempt.tenantId && attempt.tenantId !== tenantId)
      ) {
        return { status: 'not_found' as const };
      }
      return {
        status: attempt.status,
        mcp_server_id: attempt.mcpServerId,
        oauth_mode: attempt.oauthMode,
        failure_code: attempt.failureCode,
      };
    },
  };
  app.use('/mcp-servers/oauth-attempt-status', oauthAttemptStatusService, {
    methods: ['get'],
    docs: { idType: 'string' },
    // biome-ignore lint/suspicious/noExplicitAny: feathers-swagger docs option not typed in FeathersJS
  } as any);
  app.service('mcp-servers/oauth-attempt-status').hooks({
    before: { get: [ctx.requireAuth] },
  });

  // --------------------------------------------------------------------------
  // OAuth auth-headers service
  //
  // Returns a map of { [mcp_server_id]: { authorization?, error? } } for the
  // caller. Used by the executor to attach JIT-refreshed Bearer tokens only
  // to in-scope MCP servers without ever exposing raw refresh_tokens or
  // letting callers ask for someone else's token.
  //
  // Access control:
  //   - per_user tokens are keyed on params.user.user_id — a caller cannot
  //     request another user's row (no forUserId override here).
  //   - shared tokens (user_id = NULL) are returned to any authenticated
  //     caller who can see the server, matching existing shared-mode semantics.
  //
  // The caller is expected to pass only the server IDs it already resolved
  // as in-scope for the session (see `getMcpServersForSession`).
  // --------------------------------------------------------------------------
  app.use('/mcp-servers/oauth-auth-headers', {
    async create(
      data: { mcp_server_ids: string[]; executorSessionToken?: string },
      params?: AuthenticatedParams
    ): Promise<{
      headers: Record<string, { authorization?: string; error?: string }>;
    }> {
      const userId = params?.user?.user_id;
      if (!userId && params?.provider) {
        throw new NotAuthenticated('oauth-auth-headers requires authentication');
      }

      const serverIds = Array.isArray(data?.mcp_server_ids) ? data.mcp_server_ids : [];
      const headers: Record<string, { authorization?: string; error?: string }> = {};

      if (serverIds.length === 0) {
        return { headers };
      }

      const sessionId = (params as (AuthenticatedParams & { session_id?: string }) | undefined)
        ?.session_id;
      const trustedInternalOrService = shouldExposeMCPServerSecrets(params);
      let trustedSessionExecutor = shouldExposeMCPServerSecretsForSessionToken(params, {
        sessionId,
      });
      let executorSessionId = sessionId;
      if (!trustedSessionExecutor && params?.provider && data.executorSessionToken) {
        const executorTokenService = (
          app as unknown as {
            sessionTokenService?: {
              validateToken: (
                token: string,
                expected?: { sessionId?: string; taskId?: string; branchId?: string }
              ) => Promise<{ session_id: string } | null>;
            };
          }
        ).sessionTokenService;
        const sessionInfo = await executorTokenService?.validateToken(
          data.executorSessionToken,
          {}
        );
        if (sessionInfo?.session_id) {
          executorSessionId = sessionInfo.session_id;
          trustedSessionExecutor = true;
        }
      }
      if (!trustedInternalOrService && !trustedSessionExecutor) {
        throw new Forbidden('oauth-auth-headers is only available to trusted executor paths');
      }
      const tenantId = tenantIdFromParams(params);
      if (!tenantId) throw new NotAuthenticated('oauth-auth-headers requires tenant identity');
      if (trustedSessionExecutor) {
        if (!executorSessionId) {
          throw new Forbidden('oauth-auth-headers requires executor session scope');
        }
        const { attachedServers, globalServers } = await runInOAuthTenantScope(
          db,
          tenantId,
          async () => {
            const executorSession = await sessionsRepository.findById(executorSessionId);
            if (!executorSession) {
              throw new Forbidden('oauth-auth-headers requires a resolvable executor session');
            }
            return {
              attachedServers: await new SessionMCPServerRepository(db).listServers(
                executorSessionId as SessionID,
                true
              ),
              globalServers: await new MCPServerRepository(db).findAll({
                scope: 'global',
                enabled: true,
                usableByUserId: executorSession.created_by,
              }),
            };
          }
        );
        const allowedServerIds = new Set([
          ...globalServers.map((server) => server.mcp_server_id),
          ...attachedServers.map((server) => server.mcp_server_id),
        ]);
        for (const serverId of serverIds) {
          if (!allowedServerIds.has(serverId as MCPServerID)) {
            headers[serverId] = { error: 'server_not_in_session_scope' };
          }
        }
      }
      const { needsRefresh, refreshAndPersistToken, InvalidGrantError } = await import(
        '@agor/core/tools/mcp/oauth-refresh'
      );

      await Promise.all(
        serverIds.map(async (serverId) => {
          if (headers[serverId]) return;
          try {
            const server = await runInOAuthTenantScope(db, tenantId, () =>
              new MCPServerRepository(db).findById(serverId)
            );
            if (!server) {
              headers[serverId] = { error: 'server_not_found' };
              return;
            }
            if (server.auth?.type !== 'oauth') {
              headers[serverId] = { error: 'not_oauth_server' };
              return;
            }

            const mode = server.auth.oauth_mode ?? 'per_user';
            if (mode === 'per_user' && !userId) {
              headers[serverId] = { error: 'needs_user_context' };
              return;
            }
            const tokenUserId: UserID | null = mode === 'per_user' ? (userId as UserID) : null;

            const row = await runInOAuthTenantScope(db, tenantId, () =>
              new UserMCPOAuthTokenRepository(db).getToken(tokenUserId, serverId as MCPServerID)
            );
            if (!row) {
              headers[serverId] = { error: 'needs_reauth' };
              return;
            }
            if (
              isPostgresDatabaseHandle(db) &&
              !isMCPOAuthGrantBoundToServer(process.env.AGOR_MASTER_SECRET!, server, row)
            ) {
              await runInOAuthTenantWriteScope(db, tenantId, () =>
                new UserMCPOAuthTokenRepository(db).deleteGrantVersion(
                  tokenUserId,
                  serverId as MCPServerID,
                  row.grant_generation,
                  row.grant_binding_fingerprint
                )
              );
              console.warn('[OAuth AuthHeaders] grant_rejected category=binding_mismatch');
              headers[serverId] = { error: 'needs_reauth' };
              return;
            }
            if (row.refresh_status === 'ambiguous') {
              headers[serverId] = { error: 'needs_reauth' };
              return;
            }
            if (row.refresh_status === 'refreshing') {
              try {
                const observed = await refreshAndPersistToken({
                  db,
                  tenantId,
                  userId: tokenUserId,
                  mcpServerId: serverId as MCPServerID,
                  observedRefreshVersion: {
                    grantGeneration: row.grant_generation,
                    refreshGeneration: row.refresh_generation,
                  },
                });
                headers[serverId] = { authorization: `Bearer ${observed}` };
              } catch {
                headers[serverId] = { error: 'needs_reauth' };
              }
              return;
            }

            let accessToken = row.oauth_access_token;
            if (needsRefresh(row.oauth_token_expires_at) && row.oauth_refresh_token) {
              try {
                accessToken = await refreshAndPersistToken({
                  db,
                  tenantId,
                  userId: tokenUserId,
                  mcpServerId: serverId as MCPServerID,
                  observedRefreshVersion: {
                    grantGeneration: row.grant_generation,
                    refreshGeneration: row.refresh_generation,
                  },
                });
              } catch (refreshErr) {
                if (refreshErr instanceof InvalidGrantError) {
                  headers[serverId] = { error: 'needs_reauth' };
                  return;
                }
                // A failed/ambiguous rotating-token exchange must not fall back
                // to a stale token that may already be invalid.
                console.warn('[OAuth AuthHeaders] refresh_failed category=reauth_or_retry');
                headers[serverId] = { error: 'needs_reauth' };
                return;
              }
            } else if (
              !accessToken ||
              (row.oauth_token_expires_at && row.oauth_token_expires_at <= new Date())
            ) {
              // Expired with no refresh_token → must re-auth.
              headers[serverId] = { error: 'needs_reauth' };
              return;
            }

            headers[serverId] = { authorization: `Bearer ${accessToken}` };
          } catch (err) {
            console.error(
              `[OAuth AuthHeaders] request_failed category=${
                err instanceof Error ? err.name : 'unknown_error'
              }`
            );
            headers[serverId] = { error: 'unknown_error' };
          }
        })
      );

      return { headers };
    },
  });
  app.service('mcp-servers/oauth-auth-headers').hooks({
    before: { create: [ctx.requireAuth] },
  });

  // --------------------------------------------------------------------------
  // OAuth manual refresh
  //
  // POST { mcp_server_id } → force a refresh regardless of needsRefresh().
  // Used by the UI "refresh now" action on the MCP pill so operators can
  // probe / extend a token's lifetime on demand.
  //
  // Per-user rows are keyed on params.user.user_id (the caller cannot refresh
  // someone else's token). Shared-grant mutation is admin-only in v1, and the
  // role is reloaded from durable user state immediately before the refresh.
  // --------------------------------------------------------------------------
  app.use('/mcp-servers/oauth-refresh', {
    async create(
      data: { mcp_server_id: string },
      params?: AuthenticatedParams
    ): Promise<{
      success: boolean;
      expires_at?: number;
      error?: 'needs_reauth' | 'not_oauth_server' | 'server_not_found' | string;
    }> {
      const userId = params?.user?.user_id;
      if (!userId) {
        throw new NotAuthenticated('oauth-refresh requires authentication');
      }

      const serverId = data?.mcp_server_id;
      if (!serverId) {
        return { success: false, error: 'mcp_server_id is required' };
      }

      const tenantId = tenantIdFromParams(params);
      if (!tenantId) throw new NotAuthenticated('oauth-refresh requires tenant identity');
      const {
        refreshAndPersistToken,
        InvalidGrantError,
        MissingRefreshTokenError,
        MissingTokenEndpointError,
        MissingClientIdError,
        AmbiguousRefreshError,
        FailedRefreshError,
      } = await import('@agor/core/tools/mcp/oauth-refresh');

      try {
        // In `shared` mode this refreshes a token nobody in particular owns,
        // so the server row is the only thing that says who may ask.
        const server = await runInOAuthTenantScope(db, tenantId, () =>
          loadMcpServerForCaller(db, serverId, params)
        );
        if (server.auth?.type !== 'oauth') return { success: false, error: 'not_oauth_server' };

        const mode = server.auth.oauth_mode ?? 'per_user';
        if (mode === 'shared') {
          const currentUser = await runInOAuthTenantScope(db, tenantId, () =>
            new UsersRepository(db).findById(userId)
          );
          if (!hasMinimumRole(currentUser?.role, ROLES.ADMIN)) {
            throw new Forbidden('Shared MCP OAuth grants can only be refreshed by an admin');
          }
        }
        const tokenUserId: UserID | null = mode === 'per_user' ? (userId as UserID) : null;

        let observedRefreshVersion:
          | { grantGeneration: number; refreshGeneration: number }
          | undefined;
        if (isPostgresDatabaseHandle(db)) {
          const currentGrant = await runInOAuthTenantScope(db, tenantId, () =>
            new UserMCPOAuthTokenRepository(db).getToken(tokenUserId, serverId as MCPServerID)
          );
          if (
            !currentGrant ||
            !isMCPOAuthGrantBoundToServer(process.env.AGOR_MASTER_SECRET!, server, currentGrant)
          ) {
            if (currentGrant) {
              await runInOAuthTenantWriteScope(db, tenantId, () =>
                new UserMCPOAuthTokenRepository(db).deleteGrantVersion(
                  tokenUserId,
                  serverId as MCPServerID,
                  currentGrant.grant_generation,
                  currentGrant.grant_binding_fingerprint
                )
              );
            }
            return { success: false, error: 'needs_reauth' };
          }
          observedRefreshVersion = {
            grantGeneration: currentGrant.grant_generation,
            refreshGeneration: currentGrant.refresh_generation,
          };
        }

        await refreshAndPersistToken({
          db,
          tenantId,
          userId: tokenUserId,
          mcpServerId: serverId as MCPServerID,
          observedRefreshVersion,
        });

        const fresh = await runInOAuthTenantScope(db, tenantId, () =>
          new UserMCPOAuthTokenRepository(db).getToken(tokenUserId, serverId as MCPServerID)
        );
        const expiresAt =
          fresh?.oauth_token_expires_at instanceof Date
            ? fresh.oauth_token_expires_at.getTime()
            : undefined;

        return { success: true, expires_at: expiresAt };
      } catch (err) {
        if (
          err instanceof InvalidGrantError ||
          err instanceof MissingRefreshTokenError ||
          err instanceof AmbiguousRefreshError
        ) {
          return { success: false, error: 'needs_reauth' };
        }
        // A peer observed a known, non-ambiguous owner failure. Match the
        // owner's retryable response rather than forcing one daemon's caller
        // to reconnect for the same refresh generation.
        if (err instanceof FailedRefreshError) {
          return { success: false, error: 'token_refresh_failed' };
        }
        if (err instanceof MissingTokenEndpointError) {
          return { success: false, error: 'missing_token_endpoint' };
        }
        if (err instanceof MissingClientIdError) {
          return { success: false, error: 'missing_client_id' };
        }
        console.error(
          `[OAuth Refresh] refresh_failed category=${
            err instanceof Error ? err.name : 'unknown_error'
          }`
        );
        return {
          success: false,
          error: 'token_refresh_failed',
        };
      }
    },
  });
  app.service('mcp-servers/oauth-refresh').hooks({
    before: { create: [ctx.requireAuth] },
  });

  /**
   * Discovery refreshes a server's capability list, which means opening its
   * transport with its stored credential and then writing `tools` / `resources`
   * / `prompts` back onto the row. That is a narrow mutation of its own, not
   * ordinary configuration CRUD, so it does not run through
   * `authorizeMcpServerWrite` — but it still needs an answer to "whose server
   * is this?".
   *
   * Admins keep the reach they had. Members gain exactly one thing: a server
   * they own, whatever its scope — which is what a marketplace install is.
   * Shared servers stay admin-only here, as they were before ownership
   * existed; nothing in this phase asks to widen an endpoint that makes an
   * outbound request on a shared credential.
   */
  const denyDiscoverOfAnotherUsersServer = (
    server: MCPServer,
    params?: AuthenticatedParams
  ): { success: false; error: string } | null => {
    if (!params?.provider || !params.user) return null;
    if (hasMinimumRole(params.user.role?.toLowerCase(), ROLES.ADMIN)) return null;
    if (server.owner_user_id && server.owner_user_id === params.user.user_id) return null;
    return {
      success: false,
      error: 'Access denied: only an admin or the server owner can discover this MCP server',
    };
  };

  // Discover endpoint
  app.use('/mcp-servers/discover', {
    async create(
      data: {
        mcp_server_id?: string;
        url?: string;
        transport?: 'http' | 'sse';
        auth?: {
          type: 'none' | 'bearer' | 'jwt' | 'oauth';
          token?: string;
          api_url?: string;
          api_token?: string;
          api_secret?: string;
          oauth_token_url?: string;
          oauth_client_id?: string;
          oauth_client_secret?: string;
          oauth_scope?: string;
          oauth_grant_type?: string;
          oauth_mode?: 'per_user' | 'shared';
        };
        headers?: Record<string, string>;
      },
      params?: AuthenticatedParams
    ) {
      try {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StreamableHTTPClientTransport } = await import(
          '@modelcontextprotocol/sdk/client/streamableHttp.js'
        );
        const { restoreRedactedMCPAuthSecrets } = await import('@agor/core/tools/mcp/auth-secrets');
        const { resolveMCPAuthHeaders } = await import('@agor/core/tools/mcp/jwt-auth');
        const { mergeMCPRemoteHeaders, restoreRedactedMCPCustomHeaders } = await import(
          '@agor/core/tools/mcp/http-headers'
        );
        const tenantId = tenantIdFromParams(params);
        const mcpServerRepo = new MCPServerRepository(db);

        const validateUrl = (url: string): { valid: boolean; error?: string } => {
          try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' };
            }
            return { valid: true };
          } catch {
            return { valid: false, error: 'Invalid URL format' };
          }
        };

        // Skip pre-resolution URL validation for templated URLs — `new URL()`
        // rejects whitespace inside `{{ user.env.X }}` (and full-URL templates
        // like `{{ user.env.MCP_URL }}` have no scheme yet), so validating
        // pre-resolution would block legitimate templates from ever reaching
        // the resolver. The resolved URL is re-validated below before use.
        const isTemplated = (url: string): boolean => url.includes('{{');

        const hasInlineConfig = !!data.url;
        // `auth` is typed as the canonical MCPAuth (rather than narrowing to
        // `typeof data.auth`) so the resolved auth from
        // `resolveProbeServerTemplates` flows back in without casts.
        let serverConfig: {
          url: string;
          transport: 'http' | 'sse' | 'stdio';
          auth?: MCPAuth;
          headers?: Record<string, string>;
          name?: string;
          scope?: string;
          owner_user_id?: string;
        };
        let serverId: string | undefined;

        if (hasInlineConfig) {
          if (!isTemplated(data.url!)) {
            const urlValidation = validateUrl(data.url!);
            if (!urlValidation.valid) return { success: false, error: urlValidation.error };
          }
          serverConfig = {
            url: data.url!,
            transport: data.transport || 'http',
            auth: data.auth,
            headers: data.headers,
            name: 'inline-test',
          };
          if (data.mcp_server_id) {
            const server = await runInOAuthTenantScope(db, tenantId, () =>
              loadMcpServerForCaller(db, data.mcp_server_id as string, params)
            );
            const denial = denyDiscoverOfAnotherUsersServer(server, params);
            if (denial) return denial;
            serverConfig.auth = restoreRedactedMCPAuthSecrets({
              current: server.auth,
              next: data.auth,
            });
            serverConfig.headers = restoreRedactedMCPCustomHeaders({
              current: server.headers,
              next: data.headers,
            });
            serverId = data.mcp_server_id;
          }
        } else if (data.mcp_server_id) {
          const server = await runInOAuthTenantScope(db, tenantId, () =>
            loadMcpServerForCaller(db, data.mcp_server_id as string, params)
          );
          const denial = denyDiscoverOfAnotherUsersServer(server, params);
          if (denial) return denial;
          if (server.url && !isTemplated(server.url)) {
            const urlValidation = validateUrl(server.url);
            if (!urlValidation.valid) return { success: false, error: urlValidation.error };
          }
          serverConfig = {
            url: server.url || '',
            transport: (server.transport as 'http' | 'sse') || (server.url ? 'http' : 'stdio'),
            auth: server.auth,
            headers: server.headers,
            name: server.name,
            scope: server.scope,
            owner_user_id: server.owner_user_id,
          };
          serverId = data.mcp_server_id;
        } else {
          return { success: false, error: 'Either mcp_server_id or url is required' };
        }

        if (serverConfig.transport === 'stdio' || !serverConfig.url) {
          return {
            success: false,
            error: `Connection test not supported for stdio servers (requires active session)`,
          };
        }

        // Resolve {{ user.env.X }} templates in url/auth using the caller's
        // user env vars. The executor does this at session runtime via
        // process.env + AGOR_USER_ENV_KEYS, but the daemon's process.env
        // never holds user secrets — so we pull them from the DB here. Without
        // this, Test Connection sends the literal `Bearer {{ user.env.X }}`
        // string and the MCP server returns 401, even though the server works
        // fine in real sessions.
        //
        // The endpoint is gated by `requireAuth` (see hook registration
        // below), so a missing user_id here means the auth contract was
        // bypassed somewhere upstream — fail loud rather than silently
        // skip resolution and ship literal templates upstream.
        const userId = params?.user?.user_id as UserID | undefined;
        if (!userId) {
          throw new NotAuthenticated('MCP discover requires an authenticated user');
        }

        const { resolveUserEnvironment } = await import('@agor/core/config');
        const { resolveProbeServerTemplates } = await import('./utils/mcp-probe-templates.js');

        const userEnv = await runInOAuthTenantScope(db, tenantId, () =>
          resolveUserEnvironment(userId, db)
        );
        const resolution = resolveProbeServerTemplates(
          {
            url: serverConfig.url,
            transport: serverConfig.transport,
            auth: serverConfig.auth,
            headers: serverConfig.headers,
            name: serverConfig.name,
            mcpServerId: serverId,
          },
          userEnv
        );

        if (!resolution.ok) {
          return { success: false, error: resolution.error };
        }

        serverConfig.auth = resolution.resolved.auth;
        serverConfig.headers = resolution.resolved.headers;
        // Re-validate whenever the input URL was templated, even if the
        // resolved string happens to match the input (e.g., a user env
        // value that itself looks like the template). Pre-resolution
        // validation is skipped for templated URLs, so this is the only
        // gate that runs for them.
        if (resolution.resolved.url !== serverConfig.url || isTemplated(serverConfig.url)) {
          const recheck = validateUrl(resolution.resolved.url);
          if (!recheck.valid) return { success: false, error: recheck.error };
          serverConfig.url = resolution.resolved.url;
        }

        console.log('[MCP Discovery] Starting test for:', serverConfig.name || 'inline-config');

        let authHeaders = await resolveMCPAuthHeaders(serverConfig.auth, serverConfig.url, {
          allowLocalhostHttp: !durableOAuthFlows,
          cacheNamespace: [tenantId ?? '<standalone>', serverId ?? '<unsaved>', userId].join(':'),
          disableProcessTokenCache: !!durableOAuthFlows,
        });

        const probeAndAcquireOAuthToken = async (mcpUrl: string): Promise<string | undefined> => {
          try {
            const probeResponse = await oauthFetch(mcpUrl, {
              method: 'GET',
              headers: mergeMCPRemoteHeaders({
                base: { Accept: 'application/json' },
                custom: serverConfig.headers,
              }) ?? { Accept: 'application/json' },
            });
            const wwwAuthenticate = probeResponse.headers.get('www-authenticate');
            if (probeResponse.status !== 401) return undefined;
            const { resolveMCPOAuthDiscovery } = await import(
              '@agor/core/tools/mcp/oauth-mcp-transport'
            );
            const compatibilityMode = serverConfig.auth?.oauth_compatibility_mode ?? 'strict';
            const discovery = await resolveMCPOAuthDiscovery(wwwAuthenticate, mcpUrl, {
              compatibilityMode,
              allowLocalhostHttp: !durableOAuthFlows,
            });
            if (!discovery) return undefined;

            // Route through the daemon's two-phase flow (callback → daemon's
            // public URL) instead of the legacy 127.0.0.1 callback server, so
            // remote browsers can complete the redirect on a deployed Agor.
            const connection = params?.connection as { id?: string } | undefined;
            if (
              (serverConfig.auth?.oauth_mode ?? 'per_user') === 'shared' &&
              !hasMinimumRole(params?.user?.role, ROLES.ADMIN)
            ) {
              throw new Forbidden('Shared MCP OAuth grants can only be started by an admin');
            }
            const started = await startTwoPhaseMCPOAuthFlowAndAwaitToken({
              mcpUrl,
              wwwAuthenticate: wwwAuthenticate || '',
              resourceMetadataUrl:
                discovery.kind === 'resource-metadata' ? discovery.metadataUrl : undefined,
              prefetchedAuthServerMetadata:
                discovery.kind === 'authorization-server'
                  ? discovery.authServerMetadata
                  : undefined,
              mcpServerId: serverId,
              userId: params?.user?.user_id,
              // PostgreSQL requires this saved server binding. SQLite retains
              // the historical inline/standalone path for compatibility.
              oauthMode: serverConfig.auth?.oauth_mode ?? 'per_user',
              clientId: serverConfig.auth?.oauth_client_id,
              clientSecret: serverConfig.auth?.oauth_client_secret,
              authorizationUrlOverride: serverConfig.auth?.oauth_authorization_url,
              tokenUrlOverride: serverConfig.auth?.oauth_token_url,
              scope: serverConfig.auth?.oauth_scope,
              compatibilityMode,
              dcrMode: serverConfig.auth?.oauth_dcr_mode,
              tenantId,
              socketId: connection?.id,
            });

            const tokenResponse = await started.awaitToken();
            // The callback durably persisted the token row. The access token
            // is returned only to this in-flight request and is never cached
            // in an origin-only process namespace.
            return tokenResponse.access_token;
          } catch (error) {
            // Misconfigured public base URL is a daemon-level problem, not a
            // missing-token signal — re-throw so the discover endpoint can
            // surface it to the caller instead of silently falling through to
            // an unauthenticated MCP probe.
            if (error instanceof PublicBaseUrlNotConfiguredError) throw error;
            console.error(
              `[MCP Discovery] OAuth token acquisition failed category=${
                error instanceof Error ? error.name : 'unknown'
              }`
            );
            return undefined;
          }
        };

        if (!authHeaders && serverConfig.auth?.type === 'oauth' && serverConfig.url) {
          // Durable token rows are the only daemon authority. The old cache
          // keyed solely by MCP origin could cross tenant/server/user grants.
          let oauthToken: string | undefined;
          if (serverId) {
            oauthToken = await runInOAuthTenantScope(db, tenantId, async () => {
              const tokenRepo = new UserMCPOAuthTokenRepository(db);
              const lookupUserId =
                serverConfig.auth?.oauth_mode === 'shared'
                  ? null
                  : ((params?.user?.user_id as UserID | undefined) ?? null);
              const grant = await tokenRepo.getToken(lookupUserId, serverId as MCPServerID);
              if (!grant) return undefined;
              if (
                isPostgresDatabaseHandle(db) &&
                !isMCPOAuthGrantBoundToServer(
                  process.env.AGOR_MASTER_SECRET!,
                  {
                    mcp_server_id: serverId as MCPServerID,
                    enabled: true,
                    transport: serverConfig.transport,
                    url: serverConfig.url,
                    auth: serverConfig.auth,
                  },
                  grant
                )
              ) {
                return undefined;
              }
              if (grant.oauth_token_expires_at && grant.oauth_token_expires_at <= new Date()) {
                return undefined;
              }
              return grant.oauth_access_token;
            });
          }
          if (!oauthToken) {
            const freshToken = await probeAndAcquireOAuthToken(serverConfig.url);
            if (freshToken) oauthToken = freshToken;
          }
          if (oauthToken) authHeaders = { Authorization: `Bearer ${oauthToken}` };
        }

        const headers = mergeMCPRemoteHeaders({
          base: { Accept: 'application/json, text/event-stream' },
          custom: serverConfig.headers,
          auth: authHeaders,
        }) ?? { Accept: 'application/json, text/event-stream' };

        const createMCPConnection = (connHeaders: Record<string, string>) => {
          let sessionId: string | undefined;
          const connSessionAwareFetch: typeof fetch = async (input, init) => {
            if (sessionId && init?.headers) {
              const headersObj =
                init.headers instanceof Headers
                  ? Object.fromEntries(init.headers.entries())
                  : (init.headers as Record<string, string>);
              if (!headersObj['mcp-session-id']) {
                init = { ...init, headers: { ...headersObj, 'mcp-session-id': sessionId } };
              }
            }
            const response = await oauthFetch(input, init);
            const respSessionId = response.headers.get('mcp-session-id');
            if (respSessionId) sessionId = respSessionId;
            return response;
          };
          const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url!), {
            fetch: connSessionAwareFetch,
            requestInit: { headers: connHeaders },
          });
          const mcpClient = new Client(
            { name: 'agor-discovery', version: '1.0.0' },
            { capabilities: {} }
          );
          return { transport, client: mcpClient };
        };

        const hadCachedOAuthToken = !!(authHeaders && serverConfig.auth?.type === 'oauth');
        let { transport: httpTransport, client } = createMCPConnection(headers);
        let connected = false;

        try {
          const connectWithTimeout = async (
            mcpClient: InstanceType<typeof Client>,
            mcpTransport: InstanceType<typeof StreamableHTTPClientTransport>
          ) => {
            const timeout = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('Connection timeout after 10 seconds')), 10000);
            });
            await Promise.race([mcpClient.connect(mcpTransport), timeout]);
          };

          try {
            await connectWithTimeout(client, httpTransport);
          } catch (connectError) {
            if (hadCachedOAuthToken && serverConfig.url && serverConfig.auth?.type === 'oauth') {
              const freshToken = await probeAndAcquireOAuthToken(serverConfig.url);
              if (freshToken) {
                const freshHeaders = mergeMCPRemoteHeaders({
                  base: { Accept: 'application/json, text/event-stream' },
                  custom: serverConfig.headers,
                  auth: { Authorization: `Bearer ${freshToken}` },
                }) ?? { Accept: 'application/json, text/event-stream' };
                const retry = createMCPConnection(freshHeaders);
                httpTransport = retry.transport;
                client = retry.client;
                await connectWithTimeout(client, httpTransport);
              } else {
                throw connectError;
              }
            } else {
              throw connectError;
            }
          }
          connected = true;

          const listTimeout = new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error('List capabilities timeout after 10 seconds')),
              10000
            );
          });

          interface MCPListResult<T> {
            [key: string]: T[];
          }
          type ToolsResult = MCPListResult<{
            name: string;
            description?: string;
            inputSchema?: Record<string, unknown>;
          }>;
          type ResourcesResult = MCPListResult<{ uri: string; name: string; mimeType?: string }>;
          type PromptsResult = MCPListResult<{
            name: string;
            description?: string;
            arguments?: Array<{ name: string; description?: string; required?: boolean }>;
          }>;

          const toolsResult = (await Promise.race([
            client.listTools(),
            listTimeout,
          ])) as ToolsResult;
          const resourcesResult = (await Promise.race([
            client.listResources().catch(() => ({ resources: [] })),
            listTimeout,
          ])) as ResourcesResult;
          const promptsResult = (await Promise.race([
            client.listPrompts().catch(() => ({ prompts: [] })),
            listTimeout,
          ])) as PromptsResult;

          if (serverId) {
            await mcpServerRepo.update(serverId, {
              tools: toolsResult.tools.map((t) => ({
                name: t.name,
                description: t.description || '',
                input_schema: t.inputSchema,
              })),
              resources: resourcesResult.resources.map((r) => ({
                uri: r.uri,
                name: r.name,
                mimeType: r.mimeType,
              })),
              prompts: promptsResult.prompts.map((p) => ({
                name: p.name,
                description: p.description || '',
                arguments: p.arguments?.map((a) => ({
                  name: a.name,
                  description: a.description || '',
                  required: a.required,
                })),
              })),
            });
          }

          return {
            success: true,
            capabilities: {
              tools: toolsResult.tools.length,
              resources: resourcesResult.resources.length,
              prompts: promptsResult.prompts.length,
            },
            tools: toolsResult.tools.map((t) => ({
              name: t.name,
              description: t.description || '',
            })),
            resources: resourcesResult.resources.map((r) => ({
              name: r.name,
              uri: r.uri,
              mimeType: r.mimeType,
            })),
            prompts: promptsResult.prompts.map((p) => ({
              name: p.name,
              description: p.description || '',
            })),
          };
        } finally {
          if (connected) {
            try {
              await client.close();
            } catch {
              /* ignore */
            }
          }
        }
      } catch (error) {
        if (error instanceof PublicBaseUrlNotConfiguredError) {
          console.error('[MCP Discovery]', error.message);
          return { success: false, error: error.message };
        }
        console.error(
          `[MCP Discovery] Failed category=${error instanceof Error ? error.name : 'unknown'}`
        );
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  app.service('mcp-servers/discover').hooks({ before: { create: [ctx.requireAuth] } });

  return { oauthCallbackHandler };
}

// ============================================================================
// Bootstrap Superadmin Users
// ============================================================================

async function bootstrapSuperadminUsers(
  config: AgorConfig,
  usersService: ReturnType<typeof createUsersService>,
  allowSuperadmin: boolean
): Promise<void> {
  const { ROLES } = await import('@agor/core/types');
  const bootstrapUsers = config.execution?.bootstrap_superadmin_users ?? [];
  if (bootstrapUsers.length === 0) return;

  if (!allowSuperadmin) {
    console.warn(
      '[RBAC] execution.bootstrap_superadmin_users is set but allow_superadmin=false; skipping bootstrap promotions'
    );
    return;
  }

  let promotedCount = 0;
  for (const rawUserId of bootstrapUsers) {
    const userId = rawUserId?.trim();
    if (!userId) continue;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: userId is a branded UserID at runtime
      const user = await usersService.get(userId as any);
      if (user.role === ROLES.SUPERADMIN) continue;
      // biome-ignore lint/suspicious/noExplicitAny: userId is a branded UserID at runtime
      await usersService.patch(userId as any, { role: ROLES.SUPERADMIN });
      promotedCount++;
      console.log(
        `[RBAC] Bootstrap promoted user ${shortId(userId)} (${user.email}) to superadmin`
      );
    } catch (error) {
      console.warn(
        `[RBAC] Failed to bootstrap superadmin for user ${shortId(userId)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  console.log(
    `[RBAC] Bootstrap superadmin sync complete (${promotedCount}/${bootstrapUsers.length} promoted)`
  );
}
