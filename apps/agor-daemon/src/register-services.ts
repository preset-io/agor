/**
 * Service Registration
 *
 * Registers all FeathersJS services on the app instance.
 * Extracted from index.ts for maintainability.
 */

import { createHash, randomBytes } from 'node:crypto';
import { type FileHandle, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { OPENCODE_DAEMON_CONTRIBUTION } from '@agor/agentic-tool-opencode/daemon';
import { AGENTIC_TOOL_DISPLAY_NAMES } from '@agor/agentic-tools';
import { mutateCredentialFile, openCredentialFileForBind } from '@agor/core/codex/credential-file';
import {
  type AgorConfig,
  getBranchHomePath,
  isDeploymentAgenticToolAvailable,
  MESSAGE_PAGINATION,
  type ResolvedDeploymentConfig,
  requirePublicBaseUrl,
  resolveDeploymentAgenticToolPolicy,
  resolveExecutionSecurityMode,
  resolveMultiTenancyConfig,
} from '@agor/core/config';
import {
  AmbiguousIdError,
  and,
  BoardRepository,
  BranchRepository,
  DiscordMessageDeliveryRepository,
  EntityNotFoundError,
  enqueueAfterTenantDatabaseCommit,
  eq,
  GatewayChannelRepository,
  generateId,
  getCurrentTenantId,
  getMCPEgressGatewayMode,
  inArray,
  isPostgresDatabaseHandle,
  MCPCatalogCandidateRepository,
  MCPMarketplaceRepository,
  type MCPOAuthPendingFlowRecord,
  MCPServerRepository,
  mcpServers,
  RepoRepository,
  runWithoutTenantDatabaseScope,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  type SaveTokenInput,
  SessionMCPServerRepository,
  SessionRepository,
  select,
  sessionMcpServers,
  sessions,
  shortId,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  type UserMCPOAuthToken,
  UserMCPOAuthTokenRepository,
  UsersRepository,
  visibleSessionReferenceAccessExists,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, Conflict, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import {
  hasTemplateMarker,
  isMCPServerUsableBy,
  type MCPExternalErrorStage,
  sanitizeMCPExternalError,
} from '@agor/core/mcp';
import type {
  OAuthFlowContext,
  OAuthTokenResponse,
} from '@agor/core/tools/mcp/oauth-mcp-transport';
import { OAuthConfigurationError } from '@agor/core/tools/mcp/oauth-mcp-transport';
import type { RefreshAndPersistDeps } from '@agor/core/tools/mcp/oauth-refresh';
import type {
  AgenticToolName,
  AuthenticatedParams,
  HookContext,
  MCPAuth,
  MCPOAuthAttemptID,
  MCPOAuthBrowserEventRequest,
  MCPOAuthBrowserOperation,
  MCPOAuthBrowserReservation,
  MCPOAuthBrowserReservationRequest,
  MCPOAuthDCRMode,
  MCPOAuthPendingFlowStatus,
  MCPOAuthRuntimeCompatibilityMode,
  MCPOAuthStartFailure,
  MCPServer,
  MCPServerID,
  MessageSource,
  Params,
  SessionID,
  UserID,
  UUID,
} from '@agor/core/types';
import {
  assertPublicMCPOAuthCompatibilityMode,
  hasMinimumRole,
  isMCPOAuthGrantBindingVersion,
  MCP_MEMBER_POLICY_CHANGED_EVENT,
  MCP_OAUTH_BROWSER_OPERATIONS,
  ROLES,
  TaskStatus,
} from '@agor/core/types';
import type { UnixUserMode } from '@agor/core/unix';
import { type OutboundDnsLookup, safeOutboundFetch } from '@agor/core/utils/safe-outbound-fetch';
import type express from 'express';
import { getAgenticToolDaemonContribution } from './agentic-tool-daemon-contributions.js';
import { authenticatedTaskExecutorRuntimeScope } from './auth/executor-runtime-scope.js';
import {
  hasSecureLocalCredentialOverlay,
  resolveBranchSdkHomeCompatibility,
  resolveBranchSdkHomeLaunch,
  sessionUsesBranchSdkHome,
} from './branch-sdk-home.js';
import { invalidateLiveBranchCodexCredentialBinds } from './codex-auth-bind-invalidation.js';
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
import { registerOpenCodeServices } from './integrations/opencode/index.js';
import {
  inOpenCodeNativeStateMutationSlot,
  type OpenCodeNativeStateMutationFence,
} from './integrations/opencode/native-state-coordinator.js';
import { scrubMCPSecretsFromExecutorEnv } from './mcp-egress/executor-env.js';
import { getDaemonMetrics } from './metrics/index.js';
import {
  runInOAuthTenantScope,
  runInOAuthTenantWriteScope,
  runInOAuthTenantWriteTransaction,
} from './oauth-auth-helpers.js';
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
import { createBoardsService } from './services/boards.js';
import { createBranchesService } from './services/branches.js';
import { setupCapabilityPolicyServices } from './services/capability-policies.js';
import { createCardTypesService } from './services/card-types.js';
import { createCardsService } from './services/cards.js';
import { createCheckAuthService } from './services/check-auth.js';
import { createClaudeModelsService } from './services/claude-models.js';
import { createCodexAuthImportService } from './services/codex-auth-import.js';
import { createCodexAuthLogoutService } from './services/codex-auth-logout.js';
import { resolveCodexCredentialRoute } from './services/codex-auth-shared.js';
import { createCodexDeviceAuthService } from './services/codex-device-auth.js';
import { CodexDeviceAuthAttemptAuthority } from './services/codex-device-auth-attempt-authority.js';
import { createDurableCodexDeviceAuthService } from './services/codex-device-auth-durable.js';
import { createConfigService } from './services/config.js';
import { createCopilotModelsService } from './services/copilot-models.js';
import { createCursorModelsService } from './services/cursor-models.js';
import { createExecutorGitEnvironmentService } from './services/executor-git-environment.js';
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
  GROUP_MEMBERSHIPS_SERVICE_TRANSPORT_METHODS,
  GROUPS_SERVICE_TRANSPORT_METHODS,
  setupBoardAlignedBranchesService,
  setupBoardEffectiveAccessService,
  setupBranchEffectiveAccessService,
  setupBranchFsAccessUsersService,
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
import {
  classifyMCPAuthRecovery,
  recoveryForOAuthAttemptFailure,
} from './services/mcp-auth-recovery.js';
import { createMCPCatalogService } from './services/mcp-catalog.js';
import { MCPCatalogReadinessService } from './services/mcp-catalog-readiness.js';
import { MCPMarketplaceService } from './services/mcp-marketplace.js';
import {
  MCPMarketplaceRemoveServerService,
  MCPMarketplaceToolPermissionService,
} from './services/mcp-marketplace-actions.js';
import {
  logMCPOAuthCompatibilityPolicy,
  resolveMCPOAuthCompatibilityPolicy,
} from './services/mcp-oauth-compatibility.js';
import {
  classifyMCPOAuthCompletionFailure,
  OAuthFlowAuthorizationChangedError,
} from './services/mcp-oauth-exchange-classification.js';
import {
  isCurrentMCPOAuthGrantAuthorized,
  isMCPOAuthGrantAuthorizedForServer,
  resolveMCPMarketplaceOAuthGrantAuthority,
} from './services/mcp-oauth-grant-authority.js';
import {
  fingerprintMCPOAuthGrantConfiguration,
  grantBindingVersionForCompatibilityMode,
  hasMCPOAuthRelevantServerConfigurationChanged,
  isMCPOAuthGrantBoundToServer,
  lockMCPOAuthGrantConfiguration,
  shouldVerifyMCPOAuthGrantBinding,
} from './services/mcp-oauth-grant-binding.js';
import { MCPOAuthPendingFlowAuthority } from './services/mcp-oauth-pending-flow-authority.js';
import { resolveAuthenticatedServerIds } from './services/mcp-oauth-status.js';
import {
  createMCPServersService,
  runWithMCPServerMutationDatabase,
} from './services/mcp-servers.js';
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
import {
  createTasksService,
  TASKS_SERVICE_TRANSPORT_METHODS,
  type TasksService,
} from './services/tasks.js';
import { TASKS_SERVICE_CUSTOM_EVENTS } from './services/tasks-events.js';
import { createTemplatesService } from './services/templates.js';
import { createTenantAgenticToolSettingsService } from './services/tenant-agentic-tools.js';
import { TerminalsService } from './services/terminals.js';
import { createThreadSessionMapService } from './services/thread-session-map.js';
import {
  createTenantTransactionUsersService,
  createUsersService,
  USERS_SERVICE_TRANSPORT_METHODS,
} from './services/users.js';
import { requestExecutorTermination } from './termination-coordinator.js';
import { appendSystemMessage } from './utils/append-system-message.js';
import { requireMinimumRole } from './utils/authorization.js';
import { emitServiceEvent } from './utils/emit-service-event.js';
import { renderOAuthResultPage } from './utils/html.js';
import { emitMarketplaceChanged } from './utils/marketplace-invalidation.js';
import { createAuthorityGuardedMCPFetch } from './utils/mcp-authority-fetch.js';
import {
  bindMCPDiscoveryOAuthGrant,
  bindMCPDiscoveryResolvedConfiguration,
  captureMCPDiscoveryAuthority,
  type DiscoveredMCPCapabilities,
  type MCPDiscoveryAuthoritySnapshot,
  persistDiscoveredMCPCapabilities,
} from './utils/mcp-discovered-capabilities.js';
import {
  shouldExposeMCPServerSecrets,
  shouldExposeMCPServerSecretsForSessionToken,
} from './utils/mcp-header-secrets.js';
import {
  isMcpGrantOwnerEntitled,
  isSessionMcpServerLinkVisibleToCaller,
  loadMcpServerForCaller,
  registerMcpCapabilityRoleFloor,
} from './utils/mcp-server-authorization.js';
import { resolveOwnerHomeStore, resolveSandboxStoragePaths } from './utils/sandbox-context.js';
import {
  AGOR_SOCKET_AUTHORITY_DISCONNECTED_EVENT,
  readSocketAuthorityId,
} from './utils/socket-request-authority.js';
import { type SpawnExecutorOptions, spawnExecutor } from './utils/spawn-executor.js';
import { classifyExecutorExit } from './utils/task-launch-state.js';
import { withFreshTenantWrite } from './utils/tenant-db-scope.js';

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
  /** Injectable durable authority for boundary tests; production derives it from PostgreSQL. */
  mcpOAuthPendingFlowAuthority?: MCPOAuthPendingFlowAuthority;
  /** Injectable transaction-lock boundary paired with the durable authority. */
  lockMcpOAuthGrantConfiguration?: typeof lockMCPOAuthGrantConfiguration;
  /** Injectable DNS boundary for adversarial Socket.io authority tests. */
  mcpOutboundDnsLookup?: OutboundDnsLookup;
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
  const { db, app, config, daemonUrl, branchRbacEnabled, allowSuperadmin } = ctx;
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
    {
      db,
      onRevoked: (revocation) => {
        app.emit('realtime:executor-token-invalidated', revocation);
      },
    }
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
  const tasksService = createTasksService(db, app, sessionTokenService, {
    branchRbacEnabled,
  });
  app.use('/sessions', sessionsService, {
    events: ['permission:request', 'permission:timeout'],
  });

  // Wire up the execute handler for spawning executor processes
  sessionsService.setExecuteHandler(
    createExecuteHandler(ctx, sessionsService, sessionTokenService, tasksService)
  );

  // Realtime control-plane: browsers subscribe (create) / unsubscribe (remove)
  // to a session's per-connection streaming channel so per-chunk streaming
  // events reach only the tabs actively viewing that session. Access is gated
  // by the session read inside the service. The create/remove events are
  // control-plane only and must never broadcast, so publish to no connections.
  app.use('/session-streams', createSessionStreamsService(app, resolveMultiTenancyConfig(config)), {
    methods: ['create', 'remove'],
  });
  app.service('/session-streams').hooks({
    before: { all: [ctx.requireAuth] },
  });
  app.service('/session-streams').publish(() => []);

  app.use('/tasks', tasksService, {
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
  const deliveryRepository = new DiscordMessageDeliveryRepository(db);
  const messagesService = createMessagesService(db, (tx, message) =>
    deliveryRepository.enqueueForMessageInTransaction(tx, message).then(() => undefined)
  ) as unknown as MessagesServiceImpl;
  const messageOpenApiProperties = {
    message_id: { type: 'string', format: 'uuid' },
    session_id: { type: 'string', format: 'uuid' },
    task_id: { type: 'string', format: 'uuid' },
    type: {
      type: 'string',
      enum: [
        'user',
        'assistant',
        'system',
        'file-history-snapshot',
        'permission_request',
        'input_request',
        'daemon_restart',
        'daemon_crash',
        'widget_request',
      ],
    },
    role: { type: 'string', enum: ['user', 'assistant', 'system'] },
    index: { type: 'integer', minimum: 0 },
    timestamp: { type: 'string', format: 'date-time' },
    content_preview: { type: 'string' },
    content: {
      oneOf: [{ type: 'string' }, { type: 'array', items: {} }, { type: 'object' }],
    },
    tool_uses: { type: 'array', items: { type: 'object' } },
    parent_tool_use_id: { type: 'string', nullable: true },
    metadata: { type: 'object', additionalProperties: true },
  };

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
      refs: { createRequest: 'messagesCreate', createResponse: 'messages' },
      definitions: {
        messages: {
          type: 'object',
          properties: messageOpenApiProperties,
        },
        messagesCreate: {
          type: 'object',
          required: [
            'session_id',
            'type',
            'role',
            'index',
            'timestamp',
            'content_preview',
            'content',
          ],
          additionalProperties: false,
          properties: messageOpenApiProperties,
        },
        messagesList: {
          type: 'object',
          required: ['total', 'limit', 'skip', 'data'],
          properties: {
            total: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 0, maximum: MESSAGE_PAGINATION.MAX_LIMIT },
            skip: { type: 'integer', minimum: 0 },
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/messages' },
            },
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

  app.use('/branches', createBranchesService(db, app, { appRbacEnabled: branchRbacEnabled }), {
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

  app.use('/groups', createGroupsService(db), {
    methods: [...GROUPS_SERVICE_TRANSPORT_METHODS],
  });
  app.use('/group-memberships', createGroupMembershipsService(db), {
    methods: [...GROUP_MEMBERSHIPS_SERVICE_TRANSPORT_METHODS],
  });
  setupBranchEffectiveAccessService(app, new BranchRepository(db), { allowSuperadmin });
  setupBoardEffectiveAccessService(app, new BoardRepository(db), { allowSuperadmin });
  setupBoardAlignedBranchesService(app, new BranchRepository(db));
  setupBranchFsAccessUsersService(app, new BranchRepository(db));
  setupCapabilityPolicyServices(app, db, { allowSuperadmin });

  // `createBranch` is deliberately NOT a transport method: it takes `(id, data)`,
  // which is not the Feathers custom-method contract, and it is already exposed as
  // the RBAC-guarded `/repos/:id/branches` route that the UI and CLI both use.
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
    const mcpResult = await registerMCPServices(ctx);
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
    app.use('/gateway', createGatewayService(db, app, { appRbacEnabled: branchRbacEnabled }), {
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
  // it 0600 into the resolved Codex credential home and flips the caller's auth
  // method to subscription. Token material never leaves the daemon.
  const codexDeviceAttempts =
    ctx.deployment.mode === 'ha' ? new CodexDeviceAuthAttemptAuthority(db) : undefined;
  const invalidateCodexCredentialBinds = (input: {
    tenantId: string;
    userId: UserID;
    reason: 'credentials_imported' | 'credentials_removed';
  }) =>
    hasSecureLocalCredentialOverlay(config)
      ? invalidateLiveBranchCodexCredentialBinds({ app, db, ...input })
      : Promise.resolve();

  app.use(
    '/codex-auth/import',
    createCodexAuthImportService(app, db, codexDeviceAttempts, invalidateCodexCredentialBinds)
  );
  app.service('/codex-auth/import').hooks({ before: { create: [ctx.requireAuth] } });

  // ChatGPT device-code sign-in: create starts an attempt (code + verification
  // URL back to the UI, daemon polls OpenAI for approval); find reports the
  // caller's attempt status. Tokens stay daemon-side end to end.
  app.use(
    '/codex-auth/device',
    codexDeviceAttempts
      ? createDurableCodexDeviceAuthService(
          app,
          db,
          codexDeviceAttempts,
          undefined,
          invalidateCodexCredentialBinds
        )
      : createCodexDeviceAuthService(app, db, invalidateCodexCredentialBinds)
  );
  app.service('/codex-auth/device').hooks({
    before: { create: [ctx.requireAuth], find: [ctx.requireAuth], remove: [ctx.requireAuth] },
  });

  // Removes the caller's Codex login — deletes auth.json through the resolved
  // credential route and clears the stored auth method (emitting `patched` so the
  // UI re-probes to disconnected). Server-local only; does not revoke the OAuth
  // grant, so other machines stay signed in.
  app.use(
    '/codex-auth/logout',
    createCodexAuthLogoutService(app, db, codexDeviceAttempts, invalidateCodexCredentialBinds)
  );
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
  // Top-level /session-env-selections — compatibility placeholder only.
  //
  // Unlike /session-mcp-servers, selection NAMES are a confidentiality
  // concern (they reveal which of the session creator's private env vars
  // are wired into a session), so we deliberately do NOT surface a
  // queryable read here — a branch collaborator with `view`/`prompt`
  // must not see another user's selection names.
  //
  // Reads go exclusively through `/sessions/:id/env-selections`, which
  // enforces session-creator / admin RBAC (see register-routes.ts). This
  // service remains registered for API/client compatibility, but its
  // realtime publisher audience is `none` until an owner-aware consumer and
  // disclosure contract are added.
  app.use('/session-env-selections', {
    // Empty find() — clients cannot query rows via this top-level service.
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
  // avatar sync helpers. Listing `update` here makes Feathers' hook
  // wiring throw "Can not apply hooks. 'update' is not a function" at startup.
  app.use('/users', usersService, {
    methods: [...USERS_SERVICE_TRANSPORT_METHODS],
  });

  // Plaintext Git credentials are not a Users RPC. They are exposed only to
  // the exact daemon-issued Git executor command acting as its token owner.
  app.use('/executor-git-environment', createExecutorGitEnvironmentService(db), {
    methods: ['create'],
  });

  // Bootstrap superadmin users
  await bootstrapSuperadminUsers(config, db, allowSuperadmin);

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
  sessionTokenService: import('./services/session-token-service.js').SessionTokenService,
  tasksService: TasksService
) {
  const { db, app, config, daemonUrl } = ctx;
  const deploymentAgenticToolPolicy = resolveDeploymentAgenticToolPolicy(config);
  // Only delegated execution reads the creator's home key back; local modes
  // do not consume the compatibility stamp.
  const unixIdentityGuard = resolveExecutionSecurityMode(config).requiresExecutionHomeKey
    ? {
        loadCreator: (tenantDb: TenantScopedDatabase) => (userId: string) =>
          new UsersRepository(tenantDb).findById(userId),
      }
    : undefined;

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
    const launchStartedAt = performance.now();
    const metrics = getDaemonMetrics(app);
    const tenantId = getCurrentTenantId();
    const session = await prepareSessionForExecutorStart(
      db,
      sessionsService,
      sessionId,
      params,
      deploymentAgenticToolPolicy,
      unixIdentityGuard
    );
    assertHaTaskPermissionSupported(ctx.deployment, {
      session,
      requestedMode: data.permissionMode,
    });
    if (!tenantId) throw new Error('Missing active tenant context for executor launch');
    const launchAuthority = await runWithTenantDatabaseScope(db, tenantId, () =>
      tasksService.bindExecutorLaunchAuthority(data.taskId)
    );
    if (
      launchAuthority.session_id !== sessionId ||
      launchAuthority.branch_id !== session.branch_id
    ) {
      throw new Error('Task launch authority does not match its prepared Session');
    }
    // Principal, Session, Branch, and projected filesystem floor all come from
    // the locked Task and normalized capability policy, never request params.
    const userId = launchAuthority.principal_user_id as UserID;
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

    const taskId = data.taskId;
    const runInFreshTerminationTenantWriteDatabase = <T>(work: () => Promise<T>) =>
      withFreshTenantWrite(db, tenantId, work);

    // Get branch path (+ authoritative base repo path for the sandbox) and, for
    // RBAC-aware mounting, the current PROMPT ACTOR's effective filesystem
    // access to the branch. A shared branch Session still must not upgrade the
    // caller's branch mounts to the Session owner's access.
    // The filesystem sandbox binds `<baseRepoPath>/.git` writable so
    // worktree commits work; we resolve `repo.local_path` from Agor's own DB
    // state rather than parsing the on-disk `.git` pointer (deterministic, and
    // unaffected if a worktree's origin/gitdir is later rewritten).
    const sandboxCfg = config.execution?.sandbox;
    let cwd = process.cwd();
    let sandboxBaseRepoPath: string | undefined;
    // Per-branch SDK home intent read from the branch record (design §9.2/§8B.3).
    let branchSdkHomeIntent: 'per_branch' | null = null;
    const sandboxWorktreesRoot =
      sandboxCfg?.enabled === true
        ? resolveSandboxStoragePaths(config, tenantId).worktreesRoot
        : undefined;
    // Effective fs access of the prompt actor on the branch: write/read/none.
    // Drives whether the sandbox binds the branch rw / ro / not at all. Defaults
    // to 'write' when RBAC is off (open-access behavior).
    const principalBranchAccess = launchAuthority.fs_access;
    if (session.branch_id) {
      const branchMounts = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
        const branchRepo = new BranchRepository(tenantDb);
        const branch = await branchRepo.findById(session.branch_id);
        if (!branch?.path) return undefined;
        let baseRepoPath: string | undefined;
        // Only linked worktrees need the shared git dir; a clone carries its
        // own `.git` inside the branch dir — EXCEPT for its object store when
        // it was created with `git clone --reference`, which leaves an
        // alternates pointer into `<data_home>/repos/<slug>/.git/objects`.
        // The daemon refuses to create that pointer when this sandbox would
        // hide it (see `shouldUseCloneReferencePath`), so a clone-mode branch
        // needs nothing mounted from `repos/`.
        if (branch.storage_mode !== 'clone' && branch.repo_id) {
          const repo = await new RepoRepository(tenantDb).findById(branch.repo_id);
          baseRepoPath = repo?.local_path ?? undefined;
        }
        return { path: branch.path, baseRepoPath, sdkHome: branch.sdk_home ?? null };
      });
      if (!branchMounts)
        throw new Error(`Branch ${session.branch_id} not found for executor startup`);
      cwd = branchMounts.path;
      sandboxBaseRepoPath = branchMounts.baseRepoPath;
      branchSdkHomeIntent = branchMounts.sdkHome;
      // Under the sandbox, 'none' means the branch would not be mounted at all,
      // so the task cannot operate on it. Fail fast with a clear message rather
      // than letting bwrap abort on a missing chdir target.
      if (sandboxCfg?.enabled === true && principalBranchAccess === 'none') {
        throw new Error(
          `The prompt actor has no filesystem access to branch ${session.branch_id}. ` +
            'Grant at least Read file access in the branch policy to run sessions under ' +
            'the filesystem sandbox.'
        );
      }
    }

    // Per-execution home store for `sandbox.home_mode: per_user` — a private,
    // persistent home overlaid at the passwd home inside the sandbox. Legacy
    // `execution_home` sessions keep using their immutable owner identity.
    // Branch-scoped sessions instead use the prompt actor's home: resumable SDK
    // state comes from the branch overlay, so exposing the session owner's
    // arbitrary files would be both unnecessary and unsafe. The SOURCE is the
    // selected user's `filesystem_home`
    // if set (the migration points it at their existing /home/<user> so no files
    // move), else the canonical store (see resolveOwnerHomeStore). Only computed
    // when the mode is active — and FAIL CLOSED if the owner can't be resolved.
    let sandboxHomeStore: string | undefined;
    if (sandboxCfg?.enabled === true && sandboxCfg?.home_mode === 'per_user') {
      const executionHomeUserId =
        session.sdk_home_scope === 'branch' ? userId : (session.created_by as UserID | undefined);
      if (!executionHomeUserId) {
        throw new Error(
          'sandbox home_mode=per_user requires a resolvable execution user; refusing to spawn ' +
            'without a caller-scoped home (fail closed).'
        );
      }
      const executionFilesystemHome = await runWithTenantDatabaseScope(db, tenantId, (tenantDb) =>
        new UsersRepository(tenantDb)
          .findById(executionHomeUserId as string)
          .then((u) => u?.filesystem_home?.trim() || undefined)
      );
      sandboxHomeStore = resolveOwnerHomeStore({
        config,
        tenantId,
        ownerUserId: executionHomeUserId,
        filesystemHome: executionFilesystemHome,
      });
    }

    // ── Per-branch SDK home (design §7/§8/§11) ─────────────────────────────
    // Executor startup follows the SESSION stamp, never today's deployment
    // flag or branch intent alone. This is the compatibility seam that lets an
    // old, resumable session keep its historical execution home while a fresh
    // session on the same adopted branch uses branch-owned SDK state.
    const sdkHomeTool = session.agentic_tool as AgenticToolName;
    const isDelegatedExecution = (config.execution?.unix_user_mode ?? 'simple') === 'delegated';
    let sandboxBranchSdkHome: string | undefined;
    let branchSdkHomeEnv: Record<string, string> | undefined;
    let branchSdkHomeTemplatePath = '';
    let branchCodexAuthBind:
      | { source: string; destination: string; handle?: FileHandle }
      | undefined;
    const useBranchSdkHome = sessionUsesBranchSdkHome({
      sessionScope: session.sdk_home_scope,
      branchSdkHomeIntent,
    });
    if (useBranchSdkHome) {
      if (!session.branch_id) {
        throw new Error(`Branch-scoped session ${session.session_id} has no branch`);
      }
      const branchId = session.branch_id as string;
      // A relocatable directory is necessary but not sufficient: OpenCode's
      // current XDG data home also contains its native credential file. Until
      // its actor credential namespace is split from branch-owned state, a
      // branch home would either lose configured credentials or share them.
      const compatibility = await runWithTenantDatabaseScope(db, tenantId, (tenantDb) =>
        resolveBranchSdkHomeCompatibility({
          tool: sdkHomeTool,
          delegated: isDelegatedExecution,
          secureLocalCredentialOverlay: hasSecureLocalCredentialOverlay(config),
          userId,
          db: tenantDb,
        })
      );
      if (compatibility.unsupportedReason) {
        throw new BadRequest(
          `${AGENTIC_TOOL_DISPLAY_NAMES[sdkHomeTool]} cannot run in a branch-scoped session ` +
            `because ${compatibility.unsupportedReason}. Use a supported tool or authentication mode.`
        );
      }
      const branchHomeDir = getBranchHomePath(branchId, tenantId ?? undefined);
      // Delegated mode: Agor mounts nothing; the external launcher owns
      // enforcement and is told the path via `{branch_sdk_home}` (§7.4). We do
      // not inject env, create dirs, or mount here.
      branchSdkHomeTemplatePath = branchHomeDir;
      if (!isDelegatedExecution) {
        // Lazy-create the branch home + per-tool subdirs on first prompt
        // (§6.2); idempotent, and the bwrap --bind source must exist pre-spawn
        // (§7.2 — dropMasksForMissingTargets never drops a --bind).
        await mkdir(branchHomeDir, { recursive: true });
        const launch = resolveBranchSdkHomeLaunch({
          tool: sdkHomeTool,
          branchId,
          tenantId: tenantId ?? undefined,
        });
        branchSdkHomeEnv = launch.envVars;
        for (const dir of launch.ensureDirs) await mkdir(dir, { recursive: true });
        if (compatibility.requiresLocalCodexAuthOverlay) {
          if (!userId) throw new BadRequest('Codex subscription auth requires a prompt actor');
          const credentialRoute = await resolveCodexCredentialRoute(
            userId,
            (work) => runWithTenantDatabaseScope(db, tenantId, work),
            config
          );
          if (!credentialRoute.ok || !credentialRoute.codexHome) {
            throw new BadRequest(
              credentialRoute.ok
                ? 'Codex subscription auth requires a persistent per-user credential home'
                : credentialRoute.message
            );
          }
          const branchCodexHome = launch.envVars.CODEX_HOME;
          if (!branchCodexHome) {
            throw new Error('Codex branch SDK-home launch is missing CODEX_HOME');
          }
          const destination = join(branchCodexHome, 'auth.json');
          // Bubblewrap requires an existing file mountpoint. Keep the
          // branch-owned inode deliberately empty: the caller credential is
          // visible only as a per-executor mount and is never copied into
          // shared branch state. The capability-based writer refuses symlinked
          // parent directories and replaces an adversarial final symlink.
          await mutateCredentialFile({ target: destination, content: '' });
          branchCodexAuthBind = {
            source: join(credentialRoute.codexHome, 'auth.json'),
            destination,
          };
        }
        // Bind the branch home into the sandbox (consumed by buildSandboxWrap).
        // Harmless when the sandbox is disabled (buildSandboxWrap returns null).
        sandboxBranchSdkHome = branchHomeDir;
      }
    }

    // Resolve the optional delegated home key reported to an external launcher.
    // Local execution always runs as the daemon user.
    const { resolveDelegatedHomeKey } = await import('@agor/core/unix');

    const unixUserMode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;
    let executionHomeKey = session.unix_username;
    if (unixUserMode === 'delegated' && session.sdk_home_scope === 'branch') {
      if (!userId) throw new Error('Missing prompt actor for delegated branch-scoped execution');
      executionHomeKey = await runWithTenantDatabaseScope(db, tenantId, (tenantDb) =>
        new UsersRepository(tenantDb)
          .findById(userId)
          .then((user) => user?.unix_username?.trim() || null)
      );
    }

    const delegatedHomeKeyResolution = resolveDelegatedHomeKey({
      mode: unixUserMode,
      executionHomeKey,
    });

    const executorHomeDir = homedir();
    const effectivePermissionMode =
      data.permissionMode || session.permission_config?.mode || undefined;
    const permissionModeForPayload =
      effectivePermissionMode === 'default' ? undefined : effectivePermissionMode;

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
          gatewayEnv = channel.agentic_config.envVars.flatMap((v) => {
            if (!v.value || !isEncrypted(v.value)) return [v];
            try {
              // Compatibility for rows created through the historical
              // double-encryption hook. New rows are decrypted once by the
              // repository and never enter this branch.
              return [{ ...v, value: decryptApiKey(v.value) }];
            } catch {
              console.error(`[gateway] Dropping unreadable gateway env var ${v.key}`);
              return [];
            }
          });
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

    // MCP-only secret material is resolved by the daemon proxy. Remove both
    // referenced keys and high-signal literal-value collisions from the
    // executor environment; short/low-entropy values such as DEBUG=1 are not
    // classified as credentials.
    await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
      const mode = await getMCPEgressGatewayMode(tenantDb);
      if (mode !== 'compatibility' && mode !== 'enforced') return;
      const attached = await new SessionMCPServerRepository(tenantDb).listServers(
        sessionId as SessionID,
        true
      );
      if (!userId) throw new Error('Missing prompt actor for MCP credential scrubbing');
      const usableAttached = attached.filter((server) => isMCPServerUsableBy(server, userId));
      const global = await new MCPServerRepository(tenantDb).findAll({
        scope: 'global',
        enabled: true,
        usableByUserId: userId,
      });
      scrubMCPSecretsFromExecutorEnv(executorEnv, [...usableAttached, ...global]);
    });

    // Point the tool's SDK/config-home env var(s) at the per-branch SDK home
    // (design §8). These are relocations, NOT credentials — so the MCP scrub
    // above leaves them alone, and they compose with the caller-scoped
    // credential env injected by createUserProcessEnvironment (#2555): different
    // keys, no collision (verified — the branch home never carries a credential,
    // §8A.3). Skipped in delegated mode (the launcher owns the environment).
    if (branchSdkHomeEnv) {
      Object.assign(executorEnv, branchSdkHomeEnv);
    }

    executorEnv.DAEMON_URL = daemonUrl;

    // Generalized executor-launch hook (design §4/§13 Phase 2). Every tool has a
    // daemon contribution; only OpenCode implements getExecutorLaunch today, so
    // this stays a no-op for all other tools and preserves prior behavior.
    const executorLaunch = (() => {
      const contribution = getAgenticToolDaemonContribution(session.agentic_tool);
      if (!contribution?.getExecutorLaunch) return undefined;
      // These guards fire for any tool with a launch hook (currently OpenCode).
      if (!tenantId) throw new Error('Missing active tenant context for executor-launch hook');
      if (!executorHomeDir) throw new Error('Missing executor home for executor-launch hook');
      return contribution.getExecutorLaunch({
        tenantId,
        session,
        homeDir: executorHomeDir,
      });
    })();

    // Issue only after every launch prerequisite succeeds. The credential
    // scope repeats the locked, server-derived launch authority; token retries
    // cannot lower the already-bound filesystem floor.
    const sessionToken = await sessionTokenService.generateToken(sessionId, userId, {
      taskId: data.taskId,
      branchId: launchAuthority.branch_id,
      // Runtime JWTs reconnect and authenticate frequently. Expiry + lifecycle
      // revocation, not bounded validation uses, retire this credential.
      maxUses: -1,
    });

    // Build executor payload
    const executorPayload = {
      command: 'prompt' as const,
      sessionToken,
      daemonUrl,
      ...(executorLaunch?.executorPayload ?? {}),
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
        // Authoritative sandbox mount inputs (consumed in spawn-executor →
        // buildSandboxWrap). Undefined when the sandbox / per_user home is off.
        sandboxBaseRepoPath,
        sandboxHomeStore,
        sandboxWorktreesRoot,
        principalBranchAccess,
        // Per-branch SDK home to bind into the sandbox (design §7). Undefined
        // for execution-home sessions and in delegated mode (where the launcher
        // mounts it via the {branch_sdk_home} template).
        sandboxBranchSdkHome,
      },
    };

    const logPrefix = `[Executor ${shortId(sessionId)}]`;

    // Open as late as possible and keep the capability alive only through
    // child_process.spawn(). The directory-capability helper rejects every
    // symlink component and the final file; `--bind-fd` then mounts this exact
    // inode even if another sandbox renames the pathname concurrently.
    if (branchCodexAuthBind) {
      try {
        branchCodexAuthBind.handle = await openCredentialFileForBind(branchCodexAuthBind.source);
      } catch {
        throw new BadRequest(
          'Codex subscription credentials are missing or unsafe to mount. Reconnect Codex in Agent Setup or use an API key.'
        );
      }
    }

    type NativeStateSpawn = {
      fence: OpenCodeNativeStateMutationFence;
      ready: ReturnType<typeof createDeferredSignal>;
      finished: ReturnType<typeof createDeferredSignal>;
      markSpawned(): void;
    };

    let localExecutorPid: number | undefined;
    const executorOptions = (nativeState?: NativeStateSpawn): SpawnExecutorOptions => ({
      delegatedHomeKey: delegatedHomeKeyResolution.delegatedHomeKey || undefined,
      preparedEnv: executorEnv,
      logPrefix,
      ...(branchCodexAuthBind?.handle
        ? {
            localSandboxFileBinds: [
              {
                sourceFd: branchCodexAuthBind.handle.fd,
                destination: branchCodexAuthBind.destination,
              },
            ],
          }
        : {}),
      templateVariables: {
        session_id: sessionId,
        task_id: taskId,
        branch_id: session.branch_id,
        user_id: userId,
        branch_fs_access: principalBranchAccess,
        // Delegated launchers own SDK-home enforcement (§7.4): absolute path for
        // a branch-scoped session, empty string for an execution-home session.
        branch_sdk_home: branchSdkHomeTemplatePath,
      },
      onSpawn: (child, spawnContext) => {
        metrics.increment('executor.launches', 1, { mode: spawnContext.mode });
        metrics.distribution(
          'executor.launch.duration_ms',
          Math.max(0, performance.now() - launchStartedAt),
          { mode: spawnContext.mode }
        );
        nativeState?.markSpawned();
        if (spawnContext.mode === 'local' && child.pid) {
          localExecutorPid = child.pid;
          trackExecutorProcess(
            {
              sessionId,
              taskId,
              pid: child.pid,
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
        metrics.increment('executor.process_exits', 1, {
          mode: spawnContext.mode,
          outcome: code === 0 ? 'success' : code === null ? 'unknown' : 'failure',
        });
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
                await runInFreshTerminationTenantWriteDatabase(() =>
                  (
                    app.service('tasks') as unknown as TasksServiceImpl
                  ).recordExecutorStartupWarning(
                    taskId,
                    `Executor launcher exited with code ${code ?? 'unknown'}, but configuration says remote work may have been dispatched.`,
                    { ...params, provider: undefined }
                  )
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
            runInFreshTenantWriteDatabase: runInFreshTerminationTenantWriteDatabase,
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
          await runWithoutTenantDatabaseScope(() => sessionTokenService.revokeToken(sessionToken));
        } finally {
          nativeState?.finished.resolve();
        }
      },
    });

    if (executorLaunch) {
      const ready = createDeferredSignal();
      const finished = createDeferredSignal();
      let spawned = false;
      const slot = inOpenCodeNativeStateMutationSlot(executorLaunch.namespaceKey, async (fence) => {
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
      try {
        spawnExecutor(executorPayload, executorOptions());
      } finally {
        // The child inherits its own descriptor during synchronous spawn.
        // Close only the daemon's copy once spawn returns or throws.
        await branchCodexAuthBind?.handle?.close().catch(() => undefined);
      }
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

export async function registerMCPServices(
  ctx: RegisterServicesContext
): Promise<{ oauthCallbackHandler: (req: express.Request, res: express.Response) => void }> {
  const { db, app } = ctx;
  const sessionsRepository = new SessionRepository(db);
  const postgresOAuthDeployment = isPostgresDatabaseHandle(db);
  const durableOAuthFlows =
    ctx.mcpOAuthPendingFlowAuthority ??
    (postgresOAuthDeployment ? new MCPOAuthPendingFlowAuthority(db) : null);
  const lockOAuthGrantConfiguration =
    ctx.lockMcpOAuthGrantConfiguration ?? lockMCPOAuthGrantConfiguration;
  const externalFailure = (event: string, stage: MCPExternalErrorStage, error: unknown) => {
    const safe = sanitizeMCPExternalError(error, { stage });
    const { type, code } = safe.diagnostic;
    console.error(
      `[${event}] event=mcp_external_failure stage=${stage} category=${safe.category} type=${type}${code ? ` code=${code}` : ''}`
    );
    return safe;
  };
  const oauthFetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
    assertCurrent?: () => void
  ): Promise<Response> => {
    assertCurrent?.();
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
      allowLocalhostHttp: !postgresOAuthDeployment,
      assertCurrent,
      resolveDns: ctx.mcpOutboundDnsLookup,
    });
  };
  const refreshGrantValidator =
    (tenantId: string | undefined, serverId: MCPServerID) =>
    async (
      grant: UserMCPOAuthToken,
      refreshDb: Parameters<RefreshAndPersistDeps['validateGrant']>[1]
    ): Promise<boolean> =>
      isCurrentMCPOAuthGrantAuthorized({
        // Core accepts a raw repository-compatible handle for standalone
        // tests, but daemon refreshes always enter here with the long-lived
        // tenant-aware proxy or a short-lived tenant-scoped transaction.
        db: refreshDb as TenantScopeAwareDatabase | TenantScopedDatabase,
        serverId,
        grant,
        tenantId,
        // PostgreSQL Settings mutations use the same advisory lock. SQLite
        // relies on exact-generation/fingerprint CAS plus its serialized writer.
        lockConfiguration: true,
      });

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
    /**
     * Exact saved row that authorized a standalone/SQLite flow. The callback
     * re-reads and compares this authority both before and after the provider
     * exchange, so consuming the in-memory state cannot detach the grant from
     * a concurrent Settings edit.
     */
    savedServerAuthority?: MCPServer;
    /** Bound grant envelope issued for new standalone flows. */
    localGrantBinding?: NonNullable<SaveTokenInput['grantBinding']>;
    /** Subject key whose temporary generation reservation this flow owns. */
    localGrantSubjectKey?: string;
  };

  // Store pending OAuth flow contexts
  const pendingOAuthFlows = new Map<string, PendingOAuthFlow>();
  // SQLite has no cross-process flow, but callbacks and Settings mutations can
  // interleave within this daemon. Keep every active attempt represented and
  // allocate from a process-lifetime monotonic high-water mark: releasing a
  // newer failed attempt must never make an older generation reusable (ABA).
  const localOAuthGrantReservations = new Map<
    string,
    Map<MCPOAuthAttemptID, { generation: number; reservedAt: number }>
  >();
  let localOAuthGrantGenerationHighWater = 0;
  const releaseLocalGrantGeneration = (flow: PendingOAuthFlow): void => {
    if (!flow.localGrantSubjectKey || !flow.localGrantBinding) return;
    const subjectReservations = localOAuthGrantReservations.get(flow.localGrantSubjectKey);
    const reserved = subjectReservations?.get(flow.attemptId);
    // Release only this attempt. A different attempt may never free or replace
    // an exchanging callback's active generation authority.
    if (reserved?.generation === flow.localGrantBinding.generation) {
      subjectReservations!.delete(flow.attemptId);
      if (subjectReservations!.size === 0) {
        localOAuthGrantReservations.delete(flow.localGrantSubjectKey);
      }
    }
  };
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

  /**
   * How long a standalone pending flow may sit between `oauth-start` and the
   * provider redirect.
   *
   * Enforced wherever a flow is *taken*, not only by the sweeper below. A
   * periodic job alone makes this a TTL plus up to one sweep interval of
   * jitter, and the reason the extra minute matters is that a demotion can land
   * inside it — the flow would then be consumed and its token persisted.
   */
  const LOCAL_OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
  const isLocalOAuthFlowExpired = (flow: PendingOAuthFlow): boolean =>
    Date.now() - flow.createdAt > LOCAL_OAUTH_FLOW_TTL_MS;

  // Standalone cleanup remains process-local. PostgreSQL cleanup is a
  // fleet-safe, idempotent state-machine transition plus terminal retention.
  const oauthCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [state, flow] of pendingOAuthFlows.entries()) {
      if (isLocalOAuthFlowExpired(flow)) {
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
        releaseLocalGrantGeneration(flow);
        flow.tokenReject?.(new Error('OAuth flow expired before callback was received'));
      }
    }
    // Defense-in-depth for a callback which was claimed and then abandoned by
    // an unexpected local failure before its terminal-status path ran. OAuth
    // provider exchanges are bounded to seconds; after the full flow TTL no
    // live exchange can safely depend on the process-local reservation.
    for (const [subjectKey, reservations] of localOAuthGrantReservations) {
      for (const [attemptId, reservation] of reservations) {
        if (now - reservation.reservedAt > LOCAL_OAUTH_FLOW_TTL_MS) {
          reservations.delete(attemptId);
        }
      }
      if (reservations.size === 0) {
        localOAuthGrantReservations.delete(subjectKey);
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

  async function resolveMCPOAuthRedirectUri(): Promise<string> {
    const baseUrl = await requirePublicBaseUrl();
    return new URL('/mcp-servers/oauth-callback', baseUrl).toString();
  }

  type OAuthBrowserReservationClaim = {
    reservationToken: string;
    /** Immutable deadline retained after the one-shot map entry is consumed. */
    expiresAt: number;
    operation: MCPOAuthBrowserOperation;
    mcpServerId?: string;
    userId: string;
    role: string;
    tenantId?: string;
    socketId: string;
    authorityFingerprint?: string;
  };

  type LiveSocketRequestAuthorityClaim = Pick<
    OAuthBrowserReservationClaim,
    'userId' | 'role' | 'tenantId' | 'socketId' | 'authorityFingerprint'
  >;

  type OAuthPostBrowserAuthorityClaim = LiveSocketRequestAuthorityClaim &
    Pick<OAuthBrowserReservationClaim, 'operation' | 'mcpServerId'> & {
      /** Server-issued attempt that promoted the pre-browser reservation. */
      attemptId: MCPOAuthAttemptID;
    };

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
    compatibilityMode?: MCPOAuthRuntimeCompatibilityMode;
    dcrMode?: MCPOAuthDCRMode;
    socketId?: string;
    browserReservation?: OAuthBrowserReservationClaim;
    /**
     * Immutable live Socket.io request authority for public flows which do
     * not use a browser-event reservation (notably oauth-start).
     */
    requestAuthority?: () => void;
  };

  type StartTwoPhaseOAuthResult = {
    attemptId: MCPOAuthAttemptID;
    state: string;
    authorizationUrl: string;
    redirectUri: string;
  };

  type StartTwoPhaseOAuthAndAwaitResult = StartTwoPhaseOAuthResult & {
    awaitToken: () => Promise<OAuthTokenResponse>;
    /**
     * The reservation TTL protects provider discovery, DCR, and browser emit.
     * Once emitted, this attempt-bound assertion protects the longer callback
     * wait and every use of its returned token without extending reservation
     * capacity or accepting a client-supplied generation.
     */
    assertRequestAuthority?: () => void;
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
    const assertFlowAuthority =
      opts.requestAuthority || opts.browserReservation
        ? () => {
            opts.requestAuthority?.();
            if (opts.browserReservation) {
              assertOAuthBrowserReservationStillCurrent(opts.browserReservation);
            }
          }
        : undefined;
    assertFlowAuthority?.();
    const { startMCPOAuthFlow } = await runWithinOAuthAuthority(
      assertFlowAuthority,
      () => import('@agor/core/tools/mcp/oauth-mcp-transport')
    );

    // Strict public base URL — see oauth-start endpoint for the rationale.
    const redirectUri = await runWithinOAuthAuthority(
      assertFlowAuthority,
      resolveMCPOAuthRedirectUri
    );

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

    let savedServerAuthority: MCPServer | undefined;
    let effectiveMcpUrl = opts.mcpUrl;
    let effectiveClientId = opts.clientId;
    let effectiveClientSecret = opts.clientSecret;
    let effectiveAuthorizationUrlOverride = opts.authorizationUrlOverride;
    let effectiveTokenUrlOverride = opts.tokenUrlOverride;
    let effectiveScope = opts.scope;
    let effectiveCompatibilityMode = opts.compatibilityMode ?? 'strict';
    let effectiveDcrMode = opts.dcrMode;
    let effectiveOAuthMode = opts.oauthMode ?? 'per_user';
    let durableBinding:
      | {
          tenantId: string;
          userId: UserID;
          mcpServerId: MCPServerID;
          oauthMode: 'per_user' | 'shared';
        }
      | undefined;
    if (durableOAuthFlows && (!opts.tenantId || !opts.userId || !opts.mcpServerId)) {
      throw new Error(
        'PostgreSQL OAuth requires a saved MCP server and authenticated tenant/user binding. Save the server, then restart OAuth.'
      );
    }
    if (opts.mcpServerId) {
      if (!opts.userId) {
        throw new Error(
          'Saved MCP OAuth requires an authenticated user binding. Sign in, then restart OAuth.'
        );
      }
      const server = await runWithinOAuthAuthority(assertFlowAuthority, () =>
        runInOAuthTenantScope(db, opts.tenantId, () =>
          new MCPServerRepository(db).findById(opts.mcpServerId!)
        )
      );
      if (!server?.enabled || server.url !== opts.mcpUrl || server.auth?.type !== 'oauth') {
        throw new Error(
          'The saved MCP server no longer matches this OAuth request. Save changes, then restart OAuth.'
        );
      }
      const compatibilityPolicy = await runWithinOAuthAuthority(assertFlowAuthority, () =>
        resolveMCPOAuthCompatibilityPolicy(server)
      );
      logMCPOAuthCompatibilityPolicy('flow-start', server.mcp_server_id, compatibilityPolicy);
      // The row reloaded in the tenant scope is the only durable authority.
      // Callers may have discovered metadata from a transient form snapshot,
      // but no grant may bind values that differ from the saved definition.
      effectiveMcpUrl = server.url;
      effectiveClientId = server.auth.oauth_client_id;
      effectiveClientSecret = server.auth.oauth_client_secret;
      effectiveAuthorizationUrlOverride = server.auth.oauth_authorization_url;
      effectiveTokenUrlOverride = server.auth.oauth_token_url;
      effectiveScope = server.auth.oauth_scope;
      effectiveCompatibilityMode = compatibilityPolicy.mode;
      effectiveDcrMode = server.auth.oauth_dcr_mode;
      effectiveOAuthMode = server.auth.oauth_mode ?? 'per_user';
      if (effectiveOAuthMode === 'shared') {
        const initiatingUser = await runWithinOAuthAuthority(assertFlowAuthority, () =>
          runInOAuthTenantScope(db, opts.tenantId, () =>
            new UsersRepository(db).findById(opts.userId!)
          )
        );
        if (!hasMinimumRole(initiatingUser?.role, ROLES.ADMIN)) {
          throw new Forbidden('Shared MCP OAuth grants can only be started by an admin');
        }
      }
      // Clone the row so later repository/service mutations cannot change the
      // in-memory authority captured by a standalone pending flow.
      savedServerAuthority = structuredClone(server);
      if (durableOAuthFlows) {
        durableBinding = {
          tenantId: opts.tenantId!,
          userId: opts.userId as UserID,
          mcpServerId: opts.mcpServerId as MCPServerID,
          oauthMode: effectiveOAuthMode,
        };
      }
    }

    // Local reservations are attempt-aware, so establish identity before
    // allocating a generation. PostgreSQL obtains its durable attempt ID from
    // the pending-flow authority below instead.
    const localAttemptId = durableOAuthFlows ? undefined : (generateId() as MCPOAuthAttemptID);

    // Metadata discovery and DCR are the first provider-owned side effects in
    // this helper. Re-check the live socket authority immediately before they
    // begin; consuming a valid A reservation is not enough if that same socket
    // has since authenticated as B.
    assertFlowAuthority?.();
    const context = await runWithinOAuthAuthority(assertFlowAuthority, () =>
      startMCPOAuthFlow(opts.wwwAuthenticate, effectiveClientId, redirectUri, {
        authorizationUrlOverride: effectiveAuthorizationUrlOverride,
        tokenUrlOverride: effectiveTokenUrlOverride,
        clientSecret: effectiveClientSecret,
        scope: effectiveScope,
        resourceMetadataUrl: opts.resourceMetadataUrl,
        prefetchedAuthServerMetadata: opts.prefetchedAuthServerMetadata,
        // The core helper still needs a stable metadata key for its standalone
        // flow context. Daemon callers never read or populate its origin-only
        // bearer cache.
        cacheKey: opts.prefetchedAuthServerMetadata ? effectiveMcpUrl : undefined,
        // Process-global DCR credentials are not a tenant/user/server namespace.
        // Daemon flows never share them, including in SQLite deployments.
        reuseDynamicClientRegistration: false,
        resourceUri: effectiveMcpUrl,
        compatibilityMode: effectiveCompatibilityMode,
        dcrMode: effectiveDcrMode,
        allowLocalhostHttp: !postgresOAuthDeployment,
        // The reservation is consumed before provider work starts, but its
        // deadline remains authoritative throughout discovery/DCR/flow setup.
        assertCurrent: assertFlowAuthority,
      })
    );
    assertFlowAuthority?.();

    const resolvedGrantBinding = {
      resourceUri: context.resourceUri,
      metadataUrl: context.metadataUrl,
      issuer: context.issuer,
      authorizationEndpoint: context.authorizationEndpoint,
      tokenEndpoint: context.tokenEndpoint,
      redirectUri: context.redirectUri,
      clientId: context.clientId,
      clientSecret: context.clientSecret,
      compatibilityMode: context.compatibilityMode,
    } satisfies import('./services/mcp-oauth-grant-binding.js').MCPOAuthResolvedGrantBinding;

    let localGrantBinding: NonNullable<SaveTokenInput['grantBinding']> | undefined;
    let localGrantSubjectKey: string | undefined;
    if (savedServerAuthority && !durableOAuthFlows) {
      assertFlowAuthority?.();
      localGrantBinding = await runWithinOAuthAuthority(assertFlowAuthority, () =>
        runInOAuthTenantScope(db, opts.tenantId, async () => {
          const currentServer = await runWithinOAuthAuthority(assertFlowAuthority, () =>
            new MCPServerRepository(db).findById(savedServerAuthority!.mcp_server_id)
          );
          assertFlowAuthority?.();
          const currentPolicy = currentServer
            ? await runWithinOAuthAuthority(assertFlowAuthority, () =>
                resolveMCPOAuthCompatibilityPolicy(currentServer)
              )
            : undefined;
          assertFlowAuthority?.();
          if (
            !currentServer?.enabled ||
            currentServer.auth?.type !== 'oauth' ||
            currentServer.url !== context.resourceUri ||
            (currentServer.auth.oauth_mode ?? 'per_user') !== effectiveOAuthMode ||
            currentPolicy?.mode !== context.compatibilityMode ||
            hasMCPOAuthRelevantServerConfigurationChanged(savedServerAuthority, currentServer)
          ) {
            throw new Error(
              'The MCP server changed while OAuth metadata was being resolved. Restart OAuth.'
            );
          }
          assertFlowAuthority?.();

          const subjectUserId = effectiveOAuthMode === 'per_user' ? (opts.userId as UserID) : null;
          const subjectKey = [
            currentServer.mcp_server_id,
            effectiveOAuthMode,
            subjectUserId ?? '<shared>',
          ].join('\u001f');
          const existingGrant = await runWithinOAuthAuthority(assertFlowAuthority, () =>
            new UserMCPOAuthTokenRepository(db).getToken(subjectUserId, currentServer.mcp_server_id)
          );
          assertFlowAuthority?.();
          const generation =
            Math.max(existingGrant?.grant_generation ?? 0, localOAuthGrantGenerationHighWater) + 1;
          if (!Number.isSafeInteger(generation)) {
            throw new Error('Standalone OAuth grant generation authority is exhausted');
          }
          localOAuthGrantGenerationHighWater = generation;
          const subjectReservations =
            localOAuthGrantReservations.get(subjectKey) ??
            new Map<MCPOAuthAttemptID, { generation: number; reservedAt: number }>();
          subjectReservations.set(localAttemptId!, { generation, reservedAt: Date.now() });
          localOAuthGrantReservations.set(subjectKey, subjectReservations);
          localGrantSubjectKey = subjectKey;
          const version = grantBindingVersionForCompatibilityMode(context.compatibilityMode);
          return {
            generation,
            version,
            fingerprint: fingerprintMCPOAuthGrantConfiguration(
              process.env.AGOR_MASTER_SECRET!,
              currentServer,
              resolvedGrantBinding,
              version
            ),
            metadataUri: context.metadataUrl,
            resourceUri: context.resourceUri,
            issuer: context.issuer,
            authorizationEndpoint: context.authorizationEndpoint,
            tokenEndpoint: context.tokenEndpoint,
            redirectUri: context.redirectUri,
          };
        })
      );
    }

    assertFlowAuthority?.();
    const attemptId = durableBinding
      ? await runWithinOAuthAuthority(assertFlowAuthority, () =>
          runInOAuthTenantWriteScope(db, durableBinding.tenantId, async () => {
            await runWithinOAuthAuthority(assertFlowAuthority, () =>
              lockOAuthGrantConfiguration(db, durableBinding.tenantId, durableBinding.mcpServerId)
            );
            assertFlowAuthority?.();
            const currentServer = await runWithinOAuthAuthority(assertFlowAuthority, () =>
              new MCPServerRepository(db).findById(durableBinding.mcpServerId)
            );
            assertFlowAuthority?.();
            if (
              !currentServer ||
              hasMCPOAuthRelevantServerConfigurationChanged(savedServerAuthority, currentServer)
            ) {
              throw new Error(
                'The MCP server changed while OAuth metadata was being resolved. Restart OAuth.'
              );
            }
            assertFlowAuthority?.();
            const createdAttempt = await runWithinOAuthAuthority(assertFlowAuthority, () =>
              durableOAuthFlows!.create({
                context,
                ...durableBinding,
                configFingerprint: fingerprintMCPOAuthGrantConfiguration(
                  process.env.AGOR_MASTER_SECRET!,
                  currentServer,
                  resolvedGrantBinding
                ),
              })
            );
            assertFlowAuthority?.();
            return createdAttempt;
          })
        )
      : localAttemptId!;

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
              releaseLocalGrantGeneration(pending);
              localOAuthAttemptStatuses.set(attemptId, {
                status: 'expired',
                userId: opts.userId,
                tenantId: opts.tenantId,
                mcpServerId: opts.mcpServerId,
                oauthMode: effectiveOAuthMode,
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

    assertFlowAuthority?.();
    if (!durableOAuthFlows) {
      for (const [olderState, older] of pendingOAuthFlows) {
        const sameSubject =
          older.tenantId === (opts.tenantId ?? getCurrentTenantId()) &&
          older.mcpServerId === opts.mcpServerId &&
          (older.oauthMode ?? 'per_user') === effectiveOAuthMode &&
          (effectiveOAuthMode === 'shared' || older.userId === opts.userId);
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
        oauthMode: effectiveOAuthMode,
        tenantId: opts.tenantId ?? getCurrentTenantId(),
        socketId: opts.socketId,
        createdAt: Date.now(),
        tokenResolve,
        tokenReject,
        savedServerAuthority,
        localGrantBinding,
        localGrantSubjectKey,
      });
      localOAuthAttemptStatuses.set(attemptId, {
        status: 'pending',
        userId: opts.userId,
        tenantId: opts.tenantId,
        mcpServerId: opts.mcpServerId,
        oauthMode: effectiveOAuthMode,
        updatedAt: Date.now(),
      });
    }

    if (awaitToken && opts.browserReservation && app.io) {
      assertFlowAuthority?.();
      // Compatibility hint for blocking discover/test callers, which cannot
      // return the URL before their callback arrives. Target the exact
      // authenticated initiating socket only — never a user/tenant/global
      // room — and keep durable status as the completion authority.
      app.io.local.to(opts.browserReservation.socketId).emit('oauth:open_browser', {
        authUrl: context.authorizationUrl,
        attempt_id: attemptId,
        reservation_token: opts.browserReservation.reservationToken,
        caller_user_id: opts.browserReservation.userId,
      });
    }

    // The short reservation deadline intentionally ends after the browser URL
    // is emitted. Provider interaction can legitimately outlive that minute,
    // while the blocking HTTP request remains bounded by AWAIT_TOKEN_TIMEOUT.
    // Promote only the server-issued attempt and its exact live socket/caller
    // authority; no client generation or reflected token participates.
    const postBrowserAuthorityClaim =
      awaitToken && opts.browserReservation
        ? ({
            attemptId,
            operation: opts.browserReservation.operation,
            mcpServerId: opts.browserReservation.mcpServerId,
            userId: opts.browserReservation.userId,
            role: opts.browserReservation.role,
            tenantId: opts.browserReservation.tenantId,
            socketId: opts.browserReservation.socketId,
            authorityFingerprint: opts.browserReservation.authorityFingerprint,
          } satisfies OAuthPostBrowserAuthorityClaim)
        : undefined;
    const assertRequestAuthority = postBrowserAuthorityClaim
      ? () => assertOAuthPostBrowserAuthorityStillCurrent(postBrowserAuthorityClaim)
      : undefined;

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
            const attempt = await runWithinOAuthAuthority(assertRequestAuthority, () =>
              durableOAuthFlows!.getForUser(
                durableBinding.tenantId,
                durableBinding.userId,
                attemptId
              )
            );
            if (!attempt) throw new Error('OAuth attempt is no longer available. Restart OAuth.');
            if (attempt.status === 'succeeded') {
              const tokenUserId: UserID | null =
                durableBinding.oauthMode === 'per_user' ? durableBinding.userId : null;
              const token = await runWithinOAuthAuthority(assertRequestAuthority, () =>
                runInOAuthTenantScope(db, durableBinding.tenantId, () =>
                  new UserMCPOAuthTokenRepository(db).getToken(
                    tokenUserId,
                    durableBinding.mcpServerId
                  )
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
            await runWithinOAuthAuthority(
              assertRequestAuthority,
              () => new Promise((resolve) => setTimeout(resolve, 500))
            );
          }
          throw new Error(
            'Timed out waiting for OAuth callback. Restart OAuth if it completes later.'
          );
        };
        return {
          ...base,
          assertRequestAuthority,
          awaitToken: () => runWithinOAuthAuthority(assertRequestAuthority, awaitDurableToken),
        };
      }
      return {
        ...base,
        assertRequestAuthority,
        awaitToken: () => runWithinOAuthAuthority(assertRequestAuthority, () => tokenPromise!),
      };
    }
    assertFlowAuthority?.();
    return base;
  }

  const tenantIdFromParams = (params?: AuthenticatedParams): string | undefined =>
    (params as (AuthenticatedParams & { tenant?: { tenant_id?: string } }) | undefined)?.tenant
      ?.tenant_id ?? getCurrentTenantId();

  const OAUTH_BROWSER_RESERVATION_TTL_MS = 60_000;
  const MAX_OAUTH_BROWSER_RESERVATIONS = 1_024;
  // Layered bounds prevent a single busy socket, user, or tenant from
  // exhausting the process-global reservation pool. A tenant can use its full
  // share without depending on reservation order in another tenant.
  const MAX_OAUTH_BROWSER_RESERVATIONS_PER_TENANT = 128;
  const MAX_OAUTH_BROWSER_RESERVATIONS_PER_USER = 32;
  const MAX_OAUTH_BROWSER_RESERVATIONS_PER_SOCKET = 8;
  type OAuthBrowserReservationRecord = OAuthBrowserReservationClaim & {
    authorityFingerprint?: string;
    cleanupTimer: ReturnType<typeof setTimeout>;
  };
  const oauthBrowserReservations = new Map<string, OAuthBrowserReservationRecord>();

  const socketIdFromParams = (params?: AuthenticatedParams): string | undefined => {
    // Feathers intentionally exposes `socket.feathers`, not the Socket.IO
    // socket itself, as params.connection. Accept only the immutable marker
    // installed on that exact server-owned connection object and prove that
    // it still belongs to the live socket map. Never trust an id supplied in
    // request data, headers, auth payload, or a fabricated connection object.
    if (params?.provider !== 'socketio') return undefined;
    const socketId = readSocketAuthorityId(params.connection);
    if (!socketId) return undefined;
    const socket = app.io?.sockets?.sockets?.get(socketId) as
      | { feathers?: unknown; connected?: boolean }
      | undefined;
    if (
      !socket ||
      socket.connected === false ||
      socket.feathers !== params.connection ||
      readSocketAuthorityId(socket.feathers) !== socketId
    ) {
      return undefined;
    }
    return socketId;
  };
  const authorityFingerprintFromParams = (params?: AuthenticatedParams): string | undefined => {
    const connection = params?.connection as
      | { authentication?: { accessToken?: unknown } }
      | undefined;
    const token =
      typeof params?.authentication?.accessToken === 'string'
        ? params.authentication.accessToken
        : typeof connection?.authentication?.accessToken === 'string'
          ? connection.authentication.accessToken
          : undefined;
    return token ? createHash('sha256').update(token).digest('base64url').slice(0, 22) : undefined;
  };
  const liveSocketAuthority = (
    socketId: string
  ):
    | {
        userId?: string;
        role?: string;
        tenantId?: string;
        authorityFingerprint?: string;
      }
    | undefined => {
    const socket = app.io?.sockets?.sockets?.get(socketId) as
      | {
          feathers?: AuthenticatedParams;
          data?: { tenant?: { tenant_id?: string } };
          connected?: boolean;
        }
      | undefined;
    if (!socket || socket.connected === false) return undefined;
    const connection = socket.feathers;
    if (readSocketAuthorityId(connection) !== socketId) return undefined;
    return {
      userId: connection?.user?.user_id,
      role: connection?.user?.role,
      tenantId:
        socket.data?.tenant?.tenant_id ??
        (connection as (AuthenticatedParams & { tenant?: { tenant_id?: string } }) | undefined)
          ?.tenant?.tenant_id,
      authorityFingerprint: authorityFingerprintFromParams({
        ...(connection ?? {}),
        connection,
        authentication: connection?.authentication,
      } as AuthenticatedParams),
    };
  };
  const isLiveSocketRequestAuthorityCurrent = (claim: LiveSocketRequestAuthorityClaim): boolean => {
    const authority = liveSocketAuthority(claim.socketId);
    return !!(
      authority &&
      authority.userId === claim.userId &&
      authority.role === claim.role &&
      authority.tenantId === claim.tenantId &&
      (claim.authorityFingerprint === undefined ||
        authority.authorityFingerprint === claim.authorityFingerprint)
    );
  };
  const requestAuthorityAssertion = (params?: AuthenticatedParams): (() => void) | undefined => {
    // REST requests are already tied to one authenticated HTTP request and
    // internal calls intentionally use their caller-owned authority model.
    // A real Socket.IO request, however, must always carry the server marker:
    // silently falling back here would disable in-place identity fencing.
    if (params?.provider !== 'socketio') return undefined;
    const userId = params?.user?.user_id;
    const role = params?.user?.role;
    const socketId = socketIdFromParams(params);
    if (!userId || !role || !socketId) {
      throw new Forbidden('MCP Socket.IO request authority is unavailable');
    }
    const claim: LiveSocketRequestAuthorityClaim = {
      userId,
      role,
      tenantId: tenantIdFromParams(params),
      socketId,
      authorityFingerprint: authorityFingerprintFromParams(params),
    };
    return () => {
      if (!isLiveSocketRequestAuthorityCurrent(claim)) {
        throw new Forbidden('MCP request socket authority is no longer current');
      }
    };
  };
  const assertOAuthBrowserReservationStillCurrent = (
    reservation: OAuthBrowserReservationClaim
  ): void => {
    if (Date.now() >= reservation.expiresAt) {
      throw new Forbidden('OAuth browser reservation has expired');
    }
    const authority = liveSocketAuthority(reservation.socketId);
    if (
      !authority ||
      authority.userId !== reservation.userId ||
      authority.role !== reservation.role ||
      authority.tenantId !== reservation.tenantId ||
      (reservation.authorityFingerprint !== undefined &&
        authority.authorityFingerprint !== reservation.authorityFingerprint)
    ) {
      throw new Forbidden('OAuth browser reservation authority is no longer current');
    }
  };
  const assertOAuthPostBrowserAuthorityStillCurrent = (
    claim: OAuthPostBrowserAuthorityClaim
  ): void => {
    if (!isLiveSocketRequestAuthorityCurrent(claim)) {
      throw new Forbidden(
        `OAuth attempt ${claim.attemptId} request authority is no longer current`
      );
    }
  };
  const reservationAssertion = (
    reservation?: OAuthBrowserReservationClaim
  ): (() => void) | undefined =>
    reservation ? () => assertOAuthBrowserReservationStillCurrent(reservation) : undefined;
  const runWithinOAuthAuthority = async <T>(
    assertCurrent: (() => void) | undefined,
    work: () => Promise<T>
  ): Promise<T> => {
    assertCurrent?.();
    try {
      const result = await work();
      assertCurrent?.();
      return result;
    } catch (error) {
      // Authority loss wins over simultaneous provider/DB/SDK failure. Never
      // let an obsolete request fall into a permissive retry or fallback.
      assertCurrent?.();
      throw error;
    }
  };
  const runWithinOAuthBrowserReservation = async <T>(
    reservation: OAuthBrowserReservationClaim | undefined,
    work: () => Promise<T>
  ): Promise<T> => runWithinOAuthAuthority(reservationAssertion(reservation), work);
  const deleteOAuthBrowserReservation = (token: string): void => {
    const current = oauthBrowserReservations.get(token);
    if (!current) return;
    clearTimeout(current.cleanupTimer);
    oauthBrowserReservations.delete(token);
  };
  const pruneOAuthBrowserReservations = (now = Date.now()): void => {
    for (const [token, reservation] of oauthBrowserReservations) {
      if (reservation.expiresAt <= now) deleteOAuthBrowserReservation(token);
    }
  };
  const clearOAuthBrowserReservationsForSocket = (socketId: string): void => {
    for (const [token, reservation] of oauthBrowserReservations) {
      if (reservation.socketId === socketId) deleteOAuthBrowserReservation(token);
    }
  };
  // Reservations are bound to one physical transport. Socket setup emits this
  // daemon-internal event synchronously for every disconnect, including when
  // Socket.IO itself is created only after services have registered.
  app.on(AGOR_SOCKET_AUTHORITY_DISCONNECTED_EVENT, clearOAuthBrowserReservationsForSocket);
  const readReservationToken = (value: unknown): string | undefined => {
    // Older/non-browser callers may omit the compatibility hint. Nullish
    // values are equivalently absent and must never crash the request path.
    if (value === undefined || value === null) return undefined;
    if (!value || typeof value !== 'object') {
      throw new BadRequest('oauth_browser_event must be an object');
    }
    const token = (value as Partial<MCPOAuthBrowserEventRequest>).reservation_token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      throw new BadRequest('oauth_browser_event.reservation_token is invalid');
    }
    return token;
  };
  const consumeOAuthBrowserReservation = (
    value: unknown,
    params: AuthenticatedParams | undefined,
    expected: { operation: MCPOAuthBrowserOperation; mcpServerId?: string }
  ): OAuthBrowserReservationClaim | undefined => {
    const token = readReservationToken(value);
    if (!token) return undefined;
    pruneOAuthBrowserReservations();
    const reservation = oauthBrowserReservations.get(token);
    if (!reservation) {
      throw new Forbidden('OAuth browser reservation is invalid, expired, or already used');
    }
    // Consume before comparing any binding. A guessed or replayed token gets
    // exactly one attempt and can never be corrected into a valid request.
    deleteOAuthBrowserReservation(token);
    const callerUserId = params?.user?.user_id;
    const socketId = socketIdFromParams(params);
    const tenantId = tenantIdFromParams(params);
    const authorityFingerprint = authorityFingerprintFromParams(params);
    if (
      !callerUserId ||
      !socketId ||
      reservation.userId !== callerUserId ||
      reservation.role !== params?.user?.role ||
      reservation.socketId !== socketId ||
      reservation.tenantId !== tenantId ||
      reservation.operation !== expected.operation ||
      reservation.mcpServerId !== expected.mcpServerId ||
      (reservation.authorityFingerprint !== undefined &&
        reservation.authorityFingerprint !== authorityFingerprint)
    ) {
      throw new Forbidden('OAuth browser reservation does not match this authority or operation');
    }
    const claim = {
      reservationToken: token,
      expiresAt: reservation.expiresAt,
      operation: reservation.operation,
      mcpServerId: reservation.mcpServerId,
      userId: reservation.userId,
      role: reservation.role,
      tenantId: reservation.tenantId,
      socketId: reservation.socketId,
      authorityFingerprint: reservation.authorityFingerprint,
    };
    assertOAuthBrowserReservationStillCurrent(claim);
    return claim;
  };

  /**
   * The standing of whoever started a flow, re-asked at the moment it completes.
   *
   * `oauth-start` carries a role floor, but the provider redirect can arrive
   * minutes later — up to the 10-minute pending-flow TTL — and the callback is
   * unauthenticated, so nothing between the two re-asks. Without this, a member
   * who starts a flow and is demoted before finishing it still gets a token
   * exchanged and persisted, which is the floor being on the start rather than
   * on the issuance.
   *
   * Keyed on the flow's recorded initiator, not on a caller: at the callback
   * there is no caller, only `state`. Both deployment modes record one — the
   * durable record on Postgres and the in-memory entry on SQLite — so this
   * covers both, which is why it sits ahead of the `!record` return below
   * rather than inside the durable-only block.
   *
   * Fails closed when the flow names no initiator. Every flow-start path takes
   * its `userId` from an authenticated caller, so an unattributable flow is not
   * a legitimate case to keep working.
   */
  const assertFlowInitiatorStillEntitled = async (
    initiatorId: string | undefined,
    tenantId: string | undefined,
    oauthMode: 'per_user' | 'shared'
  ): Promise<void> => {
    if (!(await isMcpGrantOwnerEntitled(db, tenantId, initiatorId, oauthMode))) {
      throw new Error(
        oauthMode === 'shared'
          ? 'Shared MCP OAuth grant requires current admin access'
          : 'MCP OAuth grant requires current member access'
      );
    }
  };

  const assertPendingFlowStillAuthorized = async (
    pendingFlow: PendingOAuthFlow,
    afterProviderExchange = false
  ): Promise<void> => {
    const record = pendingFlow.durableRecord;
    try {
      await assertFlowInitiatorStillEntitled(
        record?.userId ?? pendingFlow.userId,
        record?.tenantId ?? pendingFlow.tenantId,
        record?.oauthMode ?? pendingFlow.oauthMode ?? 'per_user'
      );
      if (!record) {
        if (!pendingFlow.mcpServerId) return;
        const savedAuthority = pendingFlow.savedServerAuthority;
        const grantBinding = pendingFlow.localGrantBinding;
        if (!savedAuthority || !grantBinding) {
          throw new Error('Saved standalone OAuth flow is missing its server authority');
        }
        await runInOAuthTenantScope(db, pendingFlow.tenantId, async () => {
          const server = await new MCPServerRepository(db).findById(
            pendingFlow.mcpServerId as MCPServerID
          );
          const compatibilityPolicy = server
            ? await resolveMCPOAuthCompatibilityPolicy(server)
            : undefined;
          if (
            !server?.enabled ||
            server.auth?.type !== 'oauth' ||
            (server.auth.oauth_mode ?? 'per_user') !== (pendingFlow.oauthMode ?? 'per_user') ||
            server.url !== pendingFlow.context.resourceUri ||
            compatibilityPolicy?.mode !== pendingFlow.context.compatibilityMode ||
            hasMCPOAuthRelevantServerConfigurationChanged(savedAuthority, server) ||
            !isMCPOAuthGrantBindingVersion(grantBinding.version)
          ) {
            throw new Error('MCP OAuth server configuration changed; restart authorization');
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
              compatibilityMode: pendingFlow.context.compatibilityMode,
            },
            grantBinding.version
          );
          if (fingerprint !== grantBinding.fingerprint) {
            throw new Error('MCP OAuth grant binding changed; restart authorization');
          }
        });
        return;
      }
      await runInOAuthTenantScope(db, record.tenantId, async () => {
        const server = await new MCPServerRepository(db).findById(record.mcpServerId);
        const compatibilityPolicy = server
          ? await resolveMCPOAuthCompatibilityPolicy(server)
          : undefined;
        if (
          !server?.enabled ||
          server.auth?.type !== 'oauth' ||
          (server.auth.oauth_mode ?? 'per_user') !== record.oauthMode ||
          server.url !== pendingFlow.context.resourceUri ||
          compatibilityPolicy?.mode !== pendingFlow.context.compatibilityMode ||
          !isMCPOAuthGrantBindingVersion(record.configFingerprintVersion)
        ) {
          throw new Error('MCP OAuth server configuration changed; restart authorization');
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
            compatibilityMode: pendingFlow.context.compatibilityMode,
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
    const grantBinding = pendingFlow.durableRecord
      ? {
          generation: pendingFlow.durableRecord.grantGeneration,
          version: durableGrantBindingVersion!,
          fingerprint: pendingFlow.durableRecord.configFingerprint,
          metadataUri: pendingFlow.context.metadataUrl,
          resourceUri: pendingFlow.context.resourceUri,
          issuer: pendingFlow.context.issuer,
          authorizationEndpoint: pendingFlow.context.authorizationEndpoint,
          tokenEndpoint: pendingFlow.context.tokenEndpoint,
          redirectUri: pendingFlow.context.redirectUri,
        }
      : pendingFlow.localGrantBinding;
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
          ...(grantBinding ? { grantBinding } : {}),
        },
        logPrefix
      );

    const persistAndFinish = async () => {
      // Recheck role and the complete server/config fingerprint inside the same
      // transaction that persists the grant and consumes the success fence.
      if (pendingFlow.durableRecord) {
        await lockOAuthGrantConfiguration(
          db,
          pendingFlow.durableRecord.tenantId,
          pendingFlow.durableRecord.mcpServerId
        );
      }
      await assertPendingFlowStillAuthorized(pendingFlow, true);
      await work();
      if (!pendingFlow.durableRecord && pendingFlow.localGrantBinding) {
        try {
          // SQLite cannot hold PostgreSQL's transaction-scoped advisory lock.
          // Recheck after the write as well: a Settings mutation interleaved
          // after the pre-write check either invalidates the row itself or is
          // detected here, where only this exact generation is removed.
          await assertPendingFlowStillAuthorized(pendingFlow, true);
        } catch (error) {
          const tokenUserId =
            (pendingFlow.oauthMode ?? 'per_user') === 'per_user'
              ? (pendingFlow.userId as UserID)
              : null;
          if (pendingFlow.mcpServerId) {
            await new UserMCPOAuthTokenRepository(db).deleteGrantVersion(
              tokenUserId,
              pendingFlow.mcpServerId as MCPServerID,
              pendingFlow.localGrantBinding.generation,
              pendingFlow.localGrantBinding.fingerprint
            );
          }
          throw error;
        }
      }
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
    if (status !== 'pending' && status !== 'exchanging') {
      releaseLocalGrantGeneration(pendingFlow);
    }
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
      return 'OAuth authentication has already completed successfully.';
    }
    if (status === 'ambiguous' || status === 'exchanging') {
      return 'OAuth exchange outcome is uncertain. Start a new OAuth flow; the previous authorization code will not be replayed.';
    }
    return 'OAuth flow did not complete. Please start a new flow.';
  };

  const sendOAuthResultPage = (
    res: express.Response,
    success: boolean,
    message: string,
    status = 200
  ): void => {
    const page = renderOAuthResultPage(success, message);
    res.setHeader('Content-Security-Policy', page.contentSecurityPolicy);
    res.status(status).send(page.html);
  };

  // Set the OAuth callback handler
  const oauthCallbackHandler = async (req: express.Request, res: express.Response) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
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
        sendOAuthResultPage(
          res,
          false,
          'Authorization was not completed. Please restart OAuth.',
          400
        );
        return;
      }

      if (!code || !state) {
        sendOAuthResultPage(res, false, 'Missing code or state parameter', 400);
        return;
      }

      let pendingFlow: PendingOAuthFlow | undefined;
      if (durableOAuthFlows) {
        const claimed = await durableOAuthFlows.claimForCallback(state);
        if (claimed.outcome === 'not_claimed') {
          if (claimed.flow?.status === 'succeeded') {
            sendOAuthResultPage(res, true, terminalMessageForStatus('succeeded'));
            return;
          }
          sendOAuthResultPage(
            res,
            false,
            claimed.flow
              ? terminalMessageForStatus(claimed.flow.status)
              : 'OAuth flow expired or not found. Please start the flow again.',
            409
          );
          return;
        }
        try {
          pendingFlow = pendingFromDurableClaim(durableOAuthFlows.openClaim(claimed.flow, state));
        } catch {
          await durableOAuthFlows.finish(claimed.flow, 'failed', 'sealed_material_unavailable');
          sendOAuthResultPage(res, false, 'OAuth flow cannot be resumed. Please start again.', 409);
          return;
        }
      } else {
        pendingFlow = pendingOAuthFlows.get(state);
        if (pendingFlow) {
          // Consume before the provider call. A second callback can never run
          // the single-use authorization code concurrently.
          pendingOAuthFlows.delete(state);
          // Age checked on retrieval, not left to the sweeper. That timer runs
          // once a minute, so a flow created just after a pass stayed usable
          // for up to 10m59s — a TTL with a jitter window, and the reason the
          // window matters is that a demotion can land inside it.
          if (isLocalOAuthFlowExpired(pendingFlow)) {
            markLocalOAuthAttempt(pendingFlow, 'expired', 'authorization_timed_out');
            pendingFlow.tokenReject?.(new Error('OAuth flow expired before callback was received'));
            pendingFlow = undefined;
          } else {
            markLocalOAuthAttempt(pendingFlow, 'exchanging');
          }
        }
      }
      if (!pendingFlow) {
        sendOAuthResultPage(
          res,
          false,
          'OAuth flow expired or not found. Please start the flow again.',
          400
        );
        return;
      }

      try {
        await assertPendingFlowStillAuthorized(pendingFlow);
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
        sendOAuthResultPage(res, true, 'OAuth authentication was successful.');
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
        sendOAuthResultPage(
          res,
          false,
          terminalMessageForStatus(ambiguous ? 'ambiguous' : 'failed'),
          ambiguous ? 409 : 400
        );
        return;
      }
    } catch (err) {
      externalFailure('OAuth Callback', 'oauth_callback', err);
      sendOAuthResultPage(
        res,
        false,
        'Authentication could not be completed. Please start a new OAuth flow.',
        500
      );
    }
  };

  app.use('/mcp-servers', createMCPServersService(db), {
    // The policy endpoint is RPC-shaped and does not publish its caller-shaped
    // response. It invalidates through this already tenant-scoped service
    // instead; browsers then refetch their own `can_configure` answer.
    events: [MCP_MEMBER_POLICY_CHANGED_EVENT],
  });
  app.use('/mcp-servers/oauth-browser-reservations', {
    async create(
      data: MCPOAuthBrowserReservationRequest,
      params?: AuthenticatedParams
    ): Promise<MCPOAuthBrowserReservation> {
      if (
        !data ||
        !MCP_OAUTH_BROWSER_OPERATIONS.includes(data.operation as MCPOAuthBrowserOperation)
      ) {
        throw new BadRequest('OAuth browser reservation operation is invalid');
      }
      if (
        data.mcp_server_id !== undefined &&
        (typeof data.mcp_server_id !== 'string' || !data.mcp_server_id)
      ) {
        throw new BadRequest('OAuth browser reservation server is invalid');
      }
      const userId = params?.user?.user_id;
      const role = params?.user?.role;
      const socketId = socketIdFromParams(params);
      const tenantId = tenantIdFromParams(params);
      const authorityFingerprint = authorityFingerprintFromParams(params);
      // Newer-main deliberately removes raw bearer material from the immutable
      // Socket.IO connection projection. The physical socket id plus its
      // server-owned user/role/tenant projection is therefore the authority
      // binding for handshake-authenticated sockets. Keep the optional token
      // fingerprint for legacy/synthetic callers that still expose one, but
      // never require the bearer to be retained merely to reserve a browser
      // event.
      if (!userId || !role || !socketId) {
        throw new BadRequest('OAuth browser reservations require an authenticated live socket');
      }
      const currentAuthority = liveSocketAuthority(socketId);
      if (
        currentAuthority?.userId !== userId ||
        currentAuthority.role !== role ||
        currentAuthority.tenantId !== tenantId ||
        currentAuthority.authorityFingerprint !== authorityFingerprint
      ) {
        throw new Forbidden('OAuth browser reservation authority is not current');
      }
      pruneOAuthBrowserReservations();
      let tenantReservations = 0;
      let userReservations = 0;
      let socketReservations = 0;
      for (const reservation of oauthBrowserReservations.values()) {
        if (reservation.tenantId === tenantId) {
          tenantReservations += 1;
          if (reservation.userId === userId) userReservations += 1;
        }
        if (reservation.socketId === socketId) socketReservations += 1;
      }
      if (socketReservations >= MAX_OAUTH_BROWSER_RESERVATIONS_PER_SOCKET) {
        throw new BadRequest('Too many pending OAuth browser reservations for this connection');
      }
      if (userReservations >= MAX_OAUTH_BROWSER_RESERVATIONS_PER_USER) {
        throw new BadRequest('Too many pending OAuth browser reservations for this user');
      }
      if (tenantReservations >= MAX_OAUTH_BROWSER_RESERVATIONS_PER_TENANT) {
        throw new BadRequest('Too many pending OAuth browser reservations for this tenant');
      }
      if (oauthBrowserReservations.size >= MAX_OAUTH_BROWSER_RESERVATIONS) {
        throw new BadRequest('Too many pending OAuth browser reservations');
      }
      const reservationToken = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + OAUTH_BROWSER_RESERVATION_TTL_MS;
      const cleanupTimer = setTimeout(
        () => deleteOAuthBrowserReservation(reservationToken),
        OAUTH_BROWSER_RESERVATION_TTL_MS
      );
      cleanupTimer.unref();
      oauthBrowserReservations.set(reservationToken, {
        reservationToken,
        operation: data.operation,
        mcpServerId: data.mcp_server_id,
        userId,
        role,
        tenantId,
        socketId,
        expiresAt,
        authorityFingerprint,
        cleanupTimer,
      });
      return { reservation_token: reservationToken, expires_at: expiresAt };
    },
  });
  app.service('mcp-servers/oauth-browser-reservations').hooks({
    before: { create: [ctx.requireAuth] },
  });
  // The returned token is a caller-private, one-shot capability. Feathers'
  // default `created` publication would otherwise put it on the tenant
  // realtime channel before the browser can use it.
  // `registerMCPServices` is also exercised without a realtime transport in
  // service-only harnesses; there is nothing to publish in that shape.
  app.service('mcp-servers/oauth-browser-reservations').publish?.(() => []);
  const coordinateMCPServerMutation = async (context: HookContext, next: () => Promise<void>) => {
    // Service-level around hooks wrap the normal before-hook chain. Over REST,
    // params.user/tenant do not exist until requireAuth runs, while Socket.io
    // often arrives pre-populated. Authenticate explicitly before this hook
    // reads tenant identity or opens the grant/config transaction; the regular
    // before hook remains defense in depth and is harmlessly idempotent.
    if (context.params.provider) await ctx.requireAuth(context);
    const tenantId = tenantIdFromParams(context.params as AuthenticatedParams);
    const requestedServerId = String(context.id ?? '');
    await runInOAuthTenantWriteTransaction(db, tenantId, async (scopedDb) => {
      const repository = new MCPServerRepository(scopedDb);
      let serverId: MCPServerID;
      try {
        serverId = await repository.resolveCanonicalId(requestedServerId);
      } catch (error) {
        if (!(error instanceof EntityNotFoundError) && !(error instanceof AmbiguousIdError)) {
          throw error;
        }
        // Preserve the service's normal not-found/ambiguous-ID error mapping.
        await next();
        return;
      }
      // Around hooks run before the ordinary authorization hooks. Rewriting to
      // the canonical ID makes authorization, the repository write, advisory
      // locking, snapshots, grants, and pending-flow cleanup use one identity.
      context.id = serverId;
      if (durableOAuthFlows && tenantId) {
        await lockOAuthGrantConfiguration(scopedDb, tenantId, serverId);
      }
      const before = await repository.findById(serverId);
      await runWithMCPServerMutationDatabase(scopedDb, next);
      const after = await repository.findById(serverId);
      if (!hasMCPOAuthRelevantServerConfigurationChanged(before, after)) return;
      await new UserMCPOAuthTokenRepository(scopedDb).deleteAllForServer(serverId);
      if (durableOAuthFlows && tenantId) {
        await durableOAuthFlows.invalidateForServer(tenantId, serverId);
      } else {
        const affectedLocalFlows = [...pendingOAuthFlows].filter(
          ([, flow]) => flow.mcpServerId === serverId
        );
        // SQLite pending flows live in memory and therefore cannot join the DB
        // transaction. Stage their destructive notification after commit so a
        // failed config/grant transaction leaves them intact. A callback that
        // races the tiny commit-to-callback interval still revalidates its
        // saved-server fingerprint before token exchange/persistence.
        const queued = enqueueAfterTenantDatabaseCommit(() => {
          for (const [state, flow] of affectedLocalFlows) {
            if (pendingOAuthFlows.get(state) !== flow) continue;
            pendingOAuthFlows.delete(state);
            markLocalOAuthAttempt(flow, 'failed', 'server_configuration_changed');
            flow.tokenReject?.(new Error('MCP OAuth server configuration changed'));
          }
        });
        if (!queued) {
          throw new Error('MCP OAuth mutation did not own an atomic database transaction');
        }
      }
      console.log('[MCP OAuth Grant] grants_invalidated category=server_configuration_changed');
    });
  };
  app.service('mcp-servers').hooks({
    around: {
      patch: [coordinateMCPServerMutation],
      update: [coordinateMCPServerMutation],
    },
  });

  // Read-only marketplace browse surface. Only find/get are exposed; the
  // catalog is a file in this repository and has no writers at runtime.
  app.use('/mcp-catalog', createMCPCatalogService(), { methods: ['find', 'get'] });
  app.use(
    '/mcp-catalog/readiness',
    new MCPCatalogReadinessService(app, {
      listCandidates: (userId) => new MCPCatalogCandidateRepository(db).listForUser(userId),
      // Readiness is advisory and may not open credential material merely to
      // draw a button. Normal configuration writes revoke bound grants; this
      // ID/boolean projection is enough to predict reuse. Connect separately
      // re-reads and verifies the full HMAC at its final authority boundary.
      isGrantAuthorized: async (candidate) => candidate.grant?.binding_ready === true,
    }),
    { methods: ['get'] }
  );
  const marketplaceServerRepository = new MCPServerRepository(db);
  const marketplaceTokenRepository = new UserMCPOAuthTokenRepository(db);
  app.use(
    '/mcp-marketplace',
    new MCPMarketplaceService(
      new MCPMarketplaceRepository(db, async (userId, serverIds) => {
        // Marketplace receives only this closed boolean map. The daemon reuses the same
        // mode/binding authority as execution and refresh; no token, client,
        // issuer, resource, or binding material crosses the service boundary.
        return resolveMCPMarketplaceOAuthGrantAuthority({
          db,
          userId,
          serverIds,
          serverRepository: marketplaceServerRepository,
          tokenRepository: marketplaceTokenRepository,
        });
      })
    ),
    { methods: ['find'] }
  );
  app.use(
    '/mcp-marketplace/remove-unattached',
    new MCPMarketplaceRemoveServerService(db, (userIds, params) =>
      emitMarketplaceChanged(app, params.tenant?.tenant_id, userIds)
    ),
    { methods: ['create'] }
  );
  app.use(
    '/mcp-marketplace/tool-permission',
    new MCPMarketplaceToolPermissionService(db, (userIds, params) =>
      emitMarketplaceChanged(app, params.tenant?.tenant_id, userIds)
    ),
    { methods: ['create'] }
  );
  // Action replies are private acknowledgements. These services mutate through
  // repository transactions, so they explicitly emit the user-targeted empty
  // Marketplace freshness hint rather than pretending the ordinary MCP CRUD
  // service emitted a lifecycle event.
  for (const path of [
    'mcp-marketplace/remove-unattached',
    'mcp-marketplace/tool-permission',
  ] as const) {
    // Feathers services have `publish` once a realtime provider is configured.
    // Narrow service-only harnesses intentionally omit that provider.
    const action = app.service(path) as unknown as {
      publish?: (publisher: () => never[]) => void;
    };
    action.publish?.(() => []);
  }

  // JWT test endpoint
  app.use('/mcp-servers/test-jwt', {
    async create(
      data: {
        api_url: string;
        api_token: string;
        api_secret: string;
        mcp_url?: string;
      },
      params?: AuthenticatedParams
    ) {
      const assertRequestAuthority = requestAuthorityAssertion(params);
      try {
        const { fetchJWTToken } = await runWithinOAuthAuthority(
          assertRequestAuthority,
          () => import('@agor/core/tools/mcp/jwt-auth')
        );
        await runWithinOAuthAuthority(assertRequestAuthority, () =>
          fetchJWTToken(
            {
              api_url: data.api_url,
              api_token: data.api_token,
              api_secret: data.api_secret,
            },
            {
              allowLocalhostHttp: !postgresOAuthDeployment,
              // A connection test must exercise the provider and must never
              // leave a caller secret in the process-global compatibility cache.
              cache: false,
              assertCurrent: assertRequestAuthority,
              resolveDns: ctx.mcpOutboundDnsLookup,
            }
          )
        );
        assertRequestAuthority?.();
        return { success: true, tokenValid: true };
      } catch (error) {
        // Socket replacement wins over provider/DNS/parse failures. In
        // particular, never downgrade a stale A request to a normal failure
        // response that B's mounted UI could consume.
        assertRequestAuthority?.();
        const safe = externalFailure('MCP JWT Test', 'jwt', error);
        return { success: false, error: safe.message, category: safe.category };
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
  async function probeMcpAuthViaReadOnlyToolCall(
    mcpUrl: string,
    assertCurrent?: () => void
  ): Promise<Response | null> {
    try {
      assertCurrent?.();
      const listResponse = await oauthFetch(
        mcpUrl,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
          signal: AbortSignal.timeout(15_000),
        },
        assertCurrent
      );
      assertCurrent?.();
      if (!listResponse.ok) return null;

      const listBody = (await listResponse.json()) as {
        result?: { tools?: Array<{ name?: string; annotations?: { readOnlyHint?: boolean } }> };
      };
      assertCurrent?.();
      const readOnlyTool = listBody.result?.tools?.find(
        (tool) => tool.annotations?.readOnlyHint === true && typeof tool.name === 'string'
      );
      if (!readOnlyTool?.name) return null;

      assertCurrent?.();
      const callResponse = await oauthFetch(
        mcpUrl,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/call',
            id: 2,
            params: { name: readOnlyTool.name, arguments: {} },
          }),
          signal: AbortSignal.timeout(15_000),
        },
        assertCurrent
      );
      assertCurrent?.();
      return callResponse.status === 401 ? callResponse : null;
    } catch (probeError) {
      // Do not downgrade an authority/deadline failure into "no fallback
      // challenge" and continue the browser flow.
      assertCurrent?.();
      externalFailure('OAuth Probe', 'discovery', probeError);
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
        oauth_browser_event?: MCPOAuthBrowserEventRequest;
        compatibility_mode?: 'strict' | 'legacy';
        dcr_mode?: MCPOAuthDCRMode;
      },
      params?: AuthenticatedParams
    ) {
      try {
        const browserReservation = data.start_browser_flow
          ? consumeOAuthBrowserReservation(data.oauth_browser_event, params, {
              operation: 'test-oauth',
              mcpServerId: data.mcp_server_id,
            })
          : undefined;
        if (data.start_browser_flow && !browserReservation) {
          throw new BadRequest('A valid OAuth browser reservation is required');
        }
        const assertBrowserReservation = reservationAssertion(browserReservation);
        const assertInitialRequestAuthority =
          assertBrowserReservation ?? requestAuthorityAssertion(params);
        assertInitialRequestAuthority?.();
        assertPublicMCPOAuthCompatibilityMode({
          oauth_compatibility_mode: data.compatibility_mode,
        });
        // Completing this flow writes a per-user or explicitly shared token
        // onto the named row and backfills its token endpoint, so the same
        // saved-row authority as every other flow-start endpoint applies.
        // Testing a not-yet-created server passes no id and is unaffected.
        const authoritativeServer = data.mcp_server_id
          ? await runWithinOAuthAuthority(assertInitialRequestAuthority, () =>
              runInOAuthTenantScope(
                db,
                tenantIdFromParams(params as AuthenticatedParams | undefined),
                () =>
                  loadMcpServerForCaller(
                    db,
                    data.mcp_server_id as string,
                    params as AuthenticatedParams | undefined
                  )
              )
            )
          : undefined;
        if (
          authoritativeServer &&
          (!authoritativeServer.enabled ||
            !authoritativeServer.url ||
            authoritativeServer.auth?.type !== 'oauth')
        ) {
          return {
            success: false,
            error:
              'OAuth testing requires an enabled OAuth server. Save changes, then retry the test.',
          };
        }
        if (authoritativeServer?.url && authoritativeServer.url !== data.mcp_url) {
          return {
            success: false,
            error:
              'The saved MCP server URL no longer matches this test. Save changes, then retry.',
          };
        }

        const effectiveMcpUrl = authoritativeServer?.url ?? data.mcp_url;
        const effectiveAuth = authoritativeServer?.auth;
        const compatibilityPolicy = authoritativeServer
          ? await runWithinOAuthAuthority(assertInitialRequestAuthority, () =>
              resolveMCPOAuthCompatibilityPolicy(authoritativeServer)
            )
          : undefined;
        const compatibilityMode = compatibilityPolicy?.mode ?? data.compatibility_mode ?? 'strict';
        if (compatibilityPolicy) {
          logMCPOAuthCompatibilityPolicy(
            'test-oauth',
            authoritativeServer?.mcp_server_id,
            compatibilityPolicy
          );
        }
        const effectiveClientId = authoritativeServer
          ? effectiveAuth?.oauth_client_id
          : data.client_id;
        const effectiveClientSecret = authoritativeServer
          ? effectiveAuth?.oauth_client_secret
          : data.client_secret;
        const effectiveScope = authoritativeServer ? effectiveAuth?.oauth_scope : data.scope;
        const effectiveGrantType = authoritativeServer
          ? effectiveAuth?.oauth_grant_type
          : data.grant_type;
        const effectiveDcrMode = authoritativeServer
          ? effectiveAuth?.oauth_dcr_mode
          : data.dcr_mode;
        // Match oauth-start, hydration, refresh, and persistence: omission is
        // per-user. `/test-oauth` must never widen a legacy/default row into a
        // tenant-shared NULL-subject grant merely because this endpoint was
        // used to begin the browser flow.
        const effectiveOAuthMode = effectiveAuth?.oauth_mode ?? 'per_user';

        console.log('[OAuth Test] Probing configured MCP server');

        let probeResponse: Response;
        try {
          probeResponse = await runWithinOAuthAuthority(assertInitialRequestAuthority, () =>
            oauthFetch(
              effectiveMcpUrl,
              {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
                signal: AbortSignal.timeout(15_000),
              },
              assertInitialRequestAuthority
            )
          );
        } catch (fetchError) {
          assertInitialRequestAuthority?.();
          const safe = externalFailure('OAuth Test', 'discovery', fetchError);
          return { success: false, error: safe.message, category: safe.category };
        }

        if (probeResponse.status !== 401) {
          const fallbackProbe = await probeMcpAuthViaReadOnlyToolCall(
            effectiveMcpUrl,
            assertInitialRequestAuthority
          );
          if (fallbackProbe) {
            console.log(
              '[OAuth Test] Handshake-level probe returned no auth requirement; ' +
                'a read-only tool call did — server defers auth to tool invocation.'
            );
            probeResponse = fallbackProbe;
          }
        }

        const wwwAuthenticate = probeResponse.headers.get('www-authenticate');
        console.log(`[OAuth Test] Probe response status=${probeResponse.status}`);

        let metadataUrl: string | null = null;
        let prefetchedAuthServerMetadata:
          | import('@agor/core/tools/mcp/oauth-mcp-transport').AuthorizationServerMetadata
          | null = null;
        let discoverySource: string | null = null;
        if (probeResponse.status === 401) {
          assertInitialRequestAuthority?.();
          const { resolveMCPOAuthDiscovery } = await import(
            '@agor/core/tools/mcp/oauth-mcp-transport'
          );
          const discovery = await resolveMCPOAuthDiscovery(wwwAuthenticate, effectiveMcpUrl, {
            compatibilityMode,
            allowLocalhostHttp: !postgresOAuthDeployment,
            assertCurrent: assertInitialRequestAuthority,
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
            if (
              effectiveOAuthMode === 'shared' &&
              !hasMinimumRole((params as AuthenticatedParams)?.user?.role, ROLES.ADMIN)
            ) {
              throw new Forbidden('Shared MCP OAuth grants can only be started by an admin');
            }
            console.log('[OAuth Test] Starting browser-based OAuth 2.1 flow...');

            try {
              // Route through the daemon's two-phase flow so the redirect_uri
              // is the daemon's public base URL (browser-reachable for any
              // user) rather than a 127.0.0.1 callback server bound to the
              // daemon process.
              let started: StartTwoPhaseOAuthAndAwaitResult;
              try {
                started = await startTwoPhaseMCPOAuthFlowAndAwaitToken({
                  mcpUrl: effectiveMcpUrl,
                  wwwAuthenticate: wwwAuthenticate || '',
                  resourceMetadataUrl: metadataUrl ?? undefined,
                  prefetchedAuthServerMetadata: prefetchedAuthServerMetadata ?? undefined,
                  mcpServerId: data.mcp_server_id,
                  userId: (params as AuthenticatedParams)?.user?.user_id,
                  // The saved row selects the grant subject; omission is the
                  // product-wide per-user default.
                  oauthMode: effectiveOAuthMode,
                  clientId: effectiveClientId,
                  tenantId: tenantIdFromParams(params as AuthenticatedParams | undefined),
                  socketId: socketIdFromParams(params as AuthenticatedParams | undefined),
                  browserReservation,
                  clientSecret: effectiveClientSecret,
                  scope: effectiveScope,
                  compatibilityMode,
                  dcrMode: effectiveDcrMode,
                });
              } catch (err) {
                const recovery = classifyMCPAuthRecovery(err);
                if (recovery.category === 'redirect_configuration_required') {
                  return {
                    success: false,
                    error: recovery.message,
                    recovery,
                    oauthType: 'oauth2.1',
                  };
                }
                throw err;
              }

              const assertRequestAuthority = started.assertRequestAuthority;
              if (!assertRequestAuthority) {
                throw new Forbidden('OAuth callback request authority is unavailable');
              }
              const tokenResponse = await started.awaitToken();

              const testResponse = await runWithinOAuthAuthority(assertRequestAuthority, () =>
                oauthFetch(
                  effectiveMcpUrl,
                  {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${tokenResponse.access_token}`,
                      Accept: 'application/json',
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'initialize',
                      id: 1,
                    }),
                    signal: AbortSignal.timeout(15_000),
                  },
                  assertRequestAuthority
                )
              );

              return {
                success: true,
                oauthType: 'oauth2.1',
                message: 'OAuth 2.1 authentication successful!',
                tokenValid: true,
                mcpStatus: testResponse.status,
              };
            } catch (flowError) {
              const recovery = classifyMCPAuthRecovery(flowError, {
                mcpServerId: data.mcp_server_id,
              });
              // Recovery must be fully derived before the external sanitizer;
              // no post-sanitization branch may inspect the original unknown.
              externalFailure('OAuth Test', 'oauth', flowError);
              return {
                success: false,
                error: recovery.message,
                recovery,
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
            const metadataResponse = await oauthFetch(
              rfc9728Url,
              {},
              assertInitialRequestAuthority
            );
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
              authServerMetadata = await fetchAuthorizationServerMetadata(authServerUrl, {
                allowLocalhostHttp: !postgresOAuthDeployment,
                assertCurrent: assertInitialRequestAuthority,
              });
              console.log('[OAuth Test] Authorization-server metadata resolved');
            } catch {
              assertInitialRequestAuthority?.();
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
            const safe = externalFailure('OAuth Test', 'oauth_metadata', metadataError);
            return {
              success: false,
              error: safe.message,
              category: safe.category,
              oauthType: 'oauth2.1',
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
          if (effectiveClientId && effectiveClientSecret) {
            console.log('[OAuth Test] Using Client Credentials flow');
            const { fetchOAuthToken, inferOAuthTokenUrl } = await import(
              '@agor/core/tools/mcp/oauth-auth'
            );
            let tokenUrl = authoritativeServer ? effectiveAuth?.oauth_token_url : data.token_url;
            let tokenUrlSource: 'provided' | 'auto-detected' = 'provided';
            if (!tokenUrl) {
              tokenUrl = inferOAuthTokenUrl(effectiveMcpUrl);
              tokenUrlSource = 'auto-detected';
              if (!tokenUrl)
                return {
                  success: false,
                  error: 'Could not auto-detect OAuth token URL. Please provide it explicitly.',
                  oauthType: 'client_credentials',
                };
            }
            const { token } = await fetchOAuthToken(
              {
                token_url: tokenUrl,
                client_id: effectiveClientId,
                client_secret: effectiveClientSecret,
                scope: effectiveScope,
                grant_type: effectiveGrantType || 'client_credentials',
                allowLocalhostHttp: !postgresOAuthDeployment,
                cacheNamespace: [
                  tenantIdFromParams(params as AuthenticatedParams | undefined) ?? '<standalone>',
                  data.mcp_server_id ?? '<unsaved>',
                  (params as AuthenticatedParams | undefined)?.user?.user_id ?? '<unknown-user>',
                ].join(':'),
                cache: !durableOAuthFlows,
                assertCurrent: assertInitialRequestAuthority,
              },
              true
            );
            let mcpStatus: number | undefined;
            let mcpStatusText: string | undefined;
            try {
              const mcpResponse = await oauthFetch(
                effectiveMcpUrl,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
                },
                assertInitialRequestAuthority
              );
              mcpStatus = mcpResponse.status;
            } catch (mcpError) {
              assertInitialRequestAuthority?.();
              mcpStatusText = externalFailure('OAuth Test', 'runtime', mcpError).message;
            }
            return {
              success: true,
              oauthType: 'client_credentials',
              tokenValid: true,
              tokenUrlSource,
              mcpStatus,
              mcpStatusText,
            };
          }

          return {
            success: false,
            error:
              'Server requires authentication (401) but OAuth 2.1 auto-discovery failed at every step.',
            oauthType: 'unknown',
            mcpStatus: probeResponse.status,
            hint:
              `${DISCOVERY_CASCADE_TRIED} ` +
              'None returned valid metadata. Options: (a) provide Client Credentials with explicit token URL, ' +
              '(b) ask the MCP server operator to publish OAuth metadata, or (c) configure manual OAuth URLs in the server settings.',
          };
        }

        return {
          success: false,
          error: `MCP server returned status ${probeResponse.status}.`,
          mcpStatus: probeResponse.status,
        };
      } catch (error) {
        const recovery = classifyMCPAuthRecovery(error, {
          mcpServerId: data.mcp_server_id,
        });
        if (
          recovery.category === 'authentication_required' ||
          recovery.category === 'permission_changed' ||
          recovery.category === 'configuration_changed'
        ) {
          return {
            success: false,
            error: recovery.message,
            recovery,
          };
        }
        const safe = externalFailure('OAuth Test', 'oauth', error);
        return { success: false, error: safe.message, category: safe.category };
      }
    },
  });

  app.service('mcp-servers/test-oauth').hooks({ before: { create: [ctx.requireAuth] } });

  // OAuth start endpoint
  app.use('/mcp-servers/oauth-start', {
    async create(
      data: { mcp_url?: string; mcp_server_id?: string; client_id?: string },
      params?: AuthenticatedParams
    ) {
      const assertRequestAuthority = requestAuthorityAssertion(params);
      try {
        assertRequestAuthority?.();
        console.log('[OAuth Start] Starting two-phase OAuth flow');
        const userId = params?.user?.user_id;
        const tenantId = tenantIdFromParams(params);

        let oauthMode: 'per_user' | 'shared' | undefined;
        let authorizationUrlOverride: string | undefined;
        let tokenUrlOverride: string | undefined;
        let clientSecretOverride: string | undefined;
        let clientIdFromConfig: string | undefined;
        let scopeOverride: string | undefined;
        let compatibilityMode: MCPOAuthRuntimeCompatibilityMode = 'strict';
        let dcrMode: MCPOAuthDCRMode | undefined;
        const savedServerId = data.mcp_server_id;
        // Its stored OAuth client configuration belongs to whoever owns the
        // row; a caller who may not use the server may not borrow it either.
        const savedServer = savedServerId
          ? await runWithinOAuthAuthority(assertRequestAuthority, () =>
              runInOAuthTenantScope(db, tenantId, () => {
                return loadMcpServerForCaller(db, savedServerId, params);
              })
            )
          : null;

        if (
          savedServerId &&
          (!savedServer?.enabled || !savedServer.url || savedServer.auth?.type !== 'oauth')
        ) {
          const recovery = {
            category: 'configuration_changed' as const,
            action: 'save_and_retry' as const,
            message:
              'OAuth requires an enabled, saved MCP server in the current tenant. Save changes, then restart OAuth.',
            ...(savedServerId ? { mcp_server_id: savedServerId as MCPServerID } : {}),
          };
          return {
            success: false,
            error: recovery.message,
            recovery,
          } satisfies MCPOAuthStartFailure;
        }

        // Once an ID is supplied, its tenant-scoped row is authoritative for
        // the provider URL and client configuration. The duplicate payload
        // fields remain accepted only for older callers.
        const effectiveMcpUrl = savedServer?.url ?? data.mcp_url;
        if (!effectiveMcpUrl) {
          const recovery = classifyMCPAuthRecovery(
            new OAuthConfigurationError('metadata_unavailable'),
            { mcpServerId: savedServerId }
          );
          return {
            success: false,
            error: recovery.message,
            recovery,
          } satisfies MCPOAuthStartFailure;
        }

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
          const recovery = {
            category: 'configuration_changed' as const,
            action: 'save_and_retry' as const,
            message:
              'The saved MCP server changed before OAuth could start. Reload it, save the intended configuration, then retry.',
            ...(savedServerId ? { mcp_server_id: savedServerId as MCPServerID } : {}),
          };
          return {
            success: false,
            error: recovery.message,
            recovery,
          } satisfies MCPOAuthStartFailure;
        }

        if (savedServer?.auth?.type === 'oauth') {
          oauthMode = savedServer.auth.oauth_mode || 'per_user';
          authorizationUrlOverride = savedServer.auth.oauth_authorization_url;
          tokenUrlOverride = savedServer.auth.oauth_token_url;
          clientIdFromConfig = savedServer.auth.oauth_client_id;
          clientSecretOverride = savedServer.auth.oauth_client_secret;
          scopeOverride = savedServer.auth.oauth_scope;
          const compatibilityPolicy = await runWithinOAuthAuthority(assertRequestAuthority, () =>
            resolveMCPOAuthCompatibilityPolicy(savedServer)
          );
          compatibilityMode = compatibilityPolicy.mode;
          logMCPOAuthCompatibilityPolicy(
            'oauth-start',
            savedServer.mcp_server_id,
            compatibilityPolicy
          );
          dcrMode = savedServer.auth.oauth_dcr_mode;
          if (oauthMode === 'shared') {
            const currentUser =
              durableOAuthFlows && tenantId && userId
                ? await runWithinOAuthAuthority(assertRequestAuthority, () =>
                    runInOAuthTenantScope(db, tenantId, () =>
                      new UsersRepository(db).findById(userId)
                    )
                  )
                : params?.user;
            if (!hasMinimumRole(currentUser?.role, ROLES.ADMIN)) {
              throw new Forbidden('Shared MCP OAuth grants can only be started by an admin');
            }
          }
        }

        let probeResponse = await oauthFetch(
          effectiveMcpUrl,
          {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
            signal: AbortSignal.timeout(15_000),
          },
          assertRequestAuthority
        );

        if (probeResponse.status !== 401) {
          const fallbackProbe = await runWithinOAuthAuthority(assertRequestAuthority, () =>
            probeMcpAuthViaReadOnlyToolCall(effectiveMcpUrl, assertRequestAuthority)
          );
          if (fallbackProbe) {
            console.log(
              '[OAuth Start] Handshake-level probe returned no auth requirement; ' +
                'a read-only tool call did — server defers auth to tool invocation.'
            );
            probeResponse = fallbackProbe;
          }
        }

        if (probeResponse.status !== 401) {
          const recovery = {
            category: 'configuration_changed' as const,
            action: 'save_and_retry' as const,
            message:
              'This MCP server did not request OAuth authentication. Verify the saved MCP URL and authentication type, then retry.',
            ...(savedServerId ? { mcp_server_id: savedServerId as MCPServerID } : {}),
          };
          return {
            success: false,
            error: recovery.message,
            recovery,
          } satisfies MCPOAuthStartFailure;
        }

        const wwwAuthenticate = probeResponse.headers.get('www-authenticate') || '';
        const { resolveMCPOAuthDiscovery } = await runWithinOAuthAuthority(
          assertRequestAuthority,
          () => import('@agor/core/tools/mcp/oauth-mcp-transport')
        );
        const discovery = await runWithinOAuthAuthority(assertRequestAuthority, () =>
          resolveMCPOAuthDiscovery(wwwAuthenticate, effectiveMcpUrl, {
            compatibilityMode,
            allowLocalhostHttp: !postgresOAuthDeployment,
            assertCurrent: assertRequestAuthority,
          })
        );
        if (!discovery) {
          const recovery = classifyMCPAuthRecovery(
            new OAuthConfigurationError('metadata_unavailable'),
            {
              mcpServerId: savedServerId,
            }
          );
          return {
            success: false,
            error: recovery.message,
            recovery,
          } satisfies MCPOAuthStartFailure;
        }

        const socketId = socketIdFromParams(params);

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
            requestAuthority: assertRequestAuthority,
          });
        } catch (err) {
          const recovery = classifyMCPAuthRecovery(err, {
            mcpServerId: data.mcp_server_id,
          });
          if (recovery.category === 'redirect_configuration_required') {
            console.error('[OAuth Start] Failed category=PublicBaseUrlNotConfiguredError');
            return {
              success: false,
              error: recovery.message,
              recovery,
            } satisfies MCPOAuthStartFailure;
          }
          throw err;
        }

        assertRequestAuthority?.();
        return {
          success: true,
          authorizationUrl: result.authorizationUrl,
          attempt_id: result.attemptId,
          state: result.state,
          message:
            'Browser opened for authentication. After signing in, copy the callback URL and paste it below.',
        };
      } catch (error) {
        // A live-authority failure must never be normalized into an ordinary
        // provider diagnostic; callers may otherwise continue an obsolete
        // flow under the replacement identity on the same socket.
        assertRequestAuthority?.();
        const preliminaryRecovery = classifyMCPAuthRecovery(error, {
          mcpServerId: data.mcp_server_id,
        });
        let redirectUri: string | null = null;
        if (
          preliminaryRecovery.category === 'client_registration_required' ||
          preliminaryRecovery.category === 'client_registration_failed'
        ) {
          try {
            redirectUri = await runWithinOAuthAuthority(
              assertRequestAuthority,
              resolveMCPOAuthRedirectUri
            );
          } catch {
            assertRequestAuthority?.();
          }
        }
        assertRequestAuthority?.();
        const recovery = redirectUri
          ? classifyMCPAuthRecovery(error, {
              mcpServerId: data.mcp_server_id,
              redirectUri,
            })
          : preliminaryRecovery;
        // This is deliberately the final consumer of the original unknown.
        // Response construction below uses only the closed recovery contract.
        externalFailure('OAuth Start', 'oauth', error);
        return {
          success: false,
          error: recovery.message,
          recovery,
          ...(redirectUri ? { redirect_uri: redirectUri } : {}),
        } satisfies MCPOAuthStartFailure;
      }
    },
  });

  app.service('mcp-servers/oauth-start').hooks({ before: { create: [ctx.requireAuth] } });

  // OAuth complete endpoint
  const oauthCompletionFailure = (
    failureCode: string,
    mcpServerId?: string,
    messageOverride?: string
  ) => {
    const recovery = recoveryForOAuthAttemptFailure(failureCode, mcpServerId);
    return {
      success: false as const,
      error:
        messageOverride ??
        recovery?.message ??
        'OAuth completion could not be validated. Reconnect this MCP server and try again.',
      tokenObtained: false,
      ...(recovery ? { recovery } : {}),
    };
  };
  app.use('/mcp-servers/oauth-complete', {
    async create(
      data: { callback_url: string } | { code: string; state: string; iss?: string },
      params?: AuthenticatedParams
    ) {
      let pendingFlow: PendingOAuthFlow | undefined;
      let completionStatus: 'failed' | 'ambiguous' | undefined;
      let completionFailureCode: string | undefined;
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
            if (claimed.flow?.status === 'succeeded') {
              return { success: true, tokenObtained: true };
            }
            return oauthCompletionFailure(
              claimed.flow?.failureCode ?? 'authorization_failed',
              claimed.flow?.mcpServerId
            );
          }
          pendingFlow = pendingFromDurableClaim(durableOAuthFlows.openClaim(claimed.flow, state));
        } else {
          pendingFlow = pendingOAuthFlows.get(state);
          if (!pendingFlow) {
            return oauthCompletionFailure('authorization_timed_out');
          }
          if (pendingFlow.tenantId && activeTenantId && pendingFlow.tenantId !== activeTenantId) {
            return oauthCompletionFailure(
              'authorization_failed',
              undefined,
              'OAuth flow belongs to a different tenant. Please restart the OAuth flow.'
            );
          }
          if (pendingFlow.userId && activeUserId && pendingFlow.userId !== activeUserId) {
            return oauthCompletionFailure(
              'permission_changed',
              pendingFlow.mcpServerId,
              'OAuth flow belongs to a different user. Please restart the OAuth flow.'
            );
          }
          pendingOAuthFlows.delete(state);
          // Same age check the callback applies — see `isLocalOAuthFlowExpired`.
          if (isLocalOAuthFlowExpired(pendingFlow)) {
            markLocalOAuthAttempt(pendingFlow, 'expired', 'authorization_timed_out');
            pendingFlow.tokenReject?.(new Error('OAuth flow expired before callback was received'));
            return oauthCompletionFailure('authorization_timed_out', pendingFlow.mcpServerId);
          }
          markLocalOAuthAttempt(pendingFlow, 'exchanging');
        }

        await assertPendingFlowStillAuthorized(pendingFlow);
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
          completionFailureCode = failureCode;
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
        externalFailure('OAuth Complete', 'oauth_callback', error);
        const recovery = recoveryForOAuthAttemptFailure(
          completionFailureCode ?? 'authorization_failed',
          pendingFlow?.mcpServerId
        );
        return {
          success: false,
          error:
            recovery?.message ??
            (pendingFlow
              ? terminalMessageForStatus(completionStatus ?? 'failed')
              : 'OAuth completion could not be validated. Start a new OAuth flow.'),
          ...(recovery ? { recovery } : {}),
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
          requireGrantBinding: true,
          isGrantBoundToServer: (server, grant) =>
            isMCPOAuthGrantAuthorizedForServer(db, server, grant),
        });
        return { authenticated_server_ids: authenticatedServerIds };
      } catch (error) {
        externalFailure('OAuth Status', 'oauth', error);
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
        if (!attempt) {
          return {
            status: 'not_found' as const,
            recovery: recoveryForOAuthAttemptFailure('authorization_failed'),
          };
        }
        return {
          status: attempt.status,
          mcp_server_id: attempt.mcpServerId,
          oauth_mode: attempt.oauthMode,
          failure_code: attempt.failureCode ?? undefined,
          recovery: recoveryForOAuthAttemptFailure(attempt.failureCode, attempt.mcpServerId),
        };
      }

      const attempt = localOAuthAttemptStatuses.get(attemptId as MCPOAuthAttemptID);
      if (
        !attempt ||
        attempt.userId !== userId ||
        (attempt.tenantId && attempt.tenantId !== tenantId)
      ) {
        return {
          status: 'not_found' as const,
          recovery: recoveryForOAuthAttemptFailure('authorization_failed'),
        };
      }
      return {
        status: attempt.status,
        mcp_server_id: attempt.mcpServerId,
        oauth_mode: attempt.oauthMode,
        failure_code: attempt.failureCode,
        recovery: recoveryForOAuthAttemptFailure(attempt.failureCode, attempt.mcpServerId),
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
      data: { mcp_server_ids: string[] },
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

      const executorSessionId = authenticatedTaskExecutorRuntimeScope(params)?.sessionId;
      const trustedInternalOrService = shouldExposeMCPServerSecrets(params);
      const trustedSessionExecutor = shouldExposeMCPServerSecretsForSessionToken(params, {
        sessionId: executorSessionId,
      });
      if (!trustedInternalOrService && !trustedSessionExecutor) {
        throw new Forbidden('oauth-auth-headers is only available to trusted executor paths');
      }
      const tenantId = tenantIdFromParams(params);
      if (!tenantId) throw new NotAuthenticated('oauth-auth-headers requires tenant identity');
      const mcpEgressAssertCurrent = (
        params as
          | (AuthenticatedParams & {
              mcp_egress_assert_current?: () => void | Promise<void>;
            })
          | undefined
      )?.mcp_egress_assert_current;
      const egressMode = await runInOAuthTenantScope(db, tenantId, () =>
        getMCPEgressGatewayMode(db)
      );
      if (params?.provider && (egressMode === 'compatibility' || egressMode === 'enforced')) {
        throw new Forbidden(
          'MCP OAuth headers are daemon-only while authoritative egress mediation is enabled'
        );
      }
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
                // The task token is issued to the actual prompter. Connector
                // credentials and private server visibility stay with that
                // caller rather than silently borrowing the Session owner.
                usableByUserId: userId,
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
      const {
        needsRefresh,
        refreshAndPersistToken,
        InvalidGrantError,
        OAuthRefreshAuthorityCancelledError,
      } = await import('@agor/core/tools/mcp/oauth-refresh');

      /**
       * The grant owner's current standing, for the refresh paths below.
       *
       * A refresh is not a read: `refreshAndPersistToken` obtains and stores a
       * *new* access token, which is issuance by the same definition the rest of
       * this file uses. A delegated task executor already carries its user's
       * identity; an explicit daemon service account does not. In either case,
       * the standing that matters belongs to the user the grant is keyed on.
       *
       * Resolved once. Every per-user grant in one request belongs to the same
       * user: `tokenUserId` is the caller's own id, and cross-user lookup is
       * reserved for service accounts by `resolveForUserIdWithGate`.
       */
      let perUserGrantOwnerEntitled: Promise<boolean> | undefined;
      const isPerUserGrantOwnerEntitled = (): Promise<boolean> => {
        perUserGrantOwnerEntitled ??= isMcpGrantOwnerEntitled(db, tenantId, userId, 'per_user');
        return perUserGrantOwnerEntitled;
      };

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
            const compatibilityMode = (await resolveMCPOAuthCompatibilityPolicy(server)).mode;
            if (
              shouldVerifyMCPOAuthGrantBinding(
                isPostgresDatabaseHandle(db),
                row.grant_binding_version
              ) &&
              !isMCPOAuthGrantBoundToServer(
                process.env.AGOR_MASTER_SECRET!,
                server,
                row,
                compatibilityMode
              )
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

            /**
             * Refuse to *extend* a grant whose owner no longer stands where they
             * did, while still vending one that is already valid.
             *
             * That is deliberately where the line falls. A demoted user's
             * running session keeps its MCP tools until the access token
             * expires, then reports `needs_reauth` — an error the executor
             * already surfaces and a person can act on, and which is literally
             * true: re-authorizing needs member standing back. The alternative,
             * cutting a running task off the moment its owner is demoted, fails
             * mid-tool-call with nothing the agent or the user can do about it,
             * and revoking a credential is not what a role change has ever meant
             * here (#2301 — demotion is still a column write that revokes
             * nothing).
             *
             * `shared` grants are out of scope: they belong to the tenant rather
             * than to a person, are admin-only to establish, and have no owner
             * whose demotion this could describe.
             */
            const refreshWouldRun =
              row.refresh_status === 'refreshing' ||
              (needsRefresh(row.oauth_token_expires_at) && !!row.oauth_refresh_token);
            if (refreshWouldRun && mode === 'per_user' && !(await isPerUserGrantOwnerEntitled())) {
              console.warn('[OAuth AuthHeaders] refresh_refused category=grant_owner_role');
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
                    grantBindingFingerprint: row.grant_binding_fingerprint,
                    refreshGeneration: row.refresh_generation,
                  },
                  validateGrant: refreshGrantValidator(tenantId, serverId as MCPServerID),
                  assertCurrent: mcpEgressAssertCurrent,
                });
                headers[serverId] = { authorization: `Bearer ${observed}` };
              } catch (refreshErr) {
                if (refreshErr instanceof OAuthRefreshAuthorityCancelledError) throw refreshErr;
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
                    grantBindingFingerprint: row.grant_binding_fingerprint,
                    refreshGeneration: row.refresh_generation,
                  },
                  validateGrant: refreshGrantValidator(tenantId, serverId as MCPServerID),
                  assertCurrent: mcpEgressAssertCurrent,
                });
              } catch (refreshErr) {
                if (refreshErr instanceof OAuthRefreshAuthorityCancelledError) throw refreshErr;
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
            if (err instanceof OAuthRefreshAuthorityCancelledError) throw err;
            externalFailure('OAuth AuthHeaders', 'oauth', err);
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
        GrantConfigurationChangedError,
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

        const currentGrant = await runInOAuthTenantScope(db, tenantId, () =>
          new UserMCPOAuthTokenRepository(db).getToken(tokenUserId, serverId as MCPServerID)
        );
        if (!currentGrant) return { success: false, error: 'needs_reauth' };
        if (!(await isMCPOAuthGrantAuthorizedForServer(db, server, currentGrant))) {
          await runInOAuthTenantWriteScope(db, tenantId, () =>
            new UserMCPOAuthTokenRepository(db).deleteGrantVersion(
              tokenUserId,
              serverId as MCPServerID,
              currentGrant.grant_generation,
              currentGrant.grant_binding_fingerprint
            )
          );
          return { success: false, error: 'needs_reauth' };
        }
        const observedRefreshVersion = {
          grantGeneration: currentGrant.grant_generation,
          grantBindingFingerprint: currentGrant.grant_binding_fingerprint,
          refreshGeneration: currentGrant.refresh_generation,
        };

        await refreshAndPersistToken({
          db,
          tenantId,
          userId: tokenUserId,
          mcpServerId: serverId as MCPServerID,
          observedRefreshVersion,
          validateGrant: refreshGrantValidator(tenantId, serverId as MCPServerID),
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
        try {
          if (
            err instanceof InvalidGrantError ||
            err instanceof MissingRefreshTokenError ||
            err instanceof AmbiguousRefreshError ||
            err instanceof GrantConfigurationChangedError
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
        } catch {
          // Hostile proxies are not trusted local refresh errors. Continue to
          // the closed external sanitizer without serializing the original.
        }
        externalFailure('OAuth Refresh', 'oauth', err);
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
   *
   * Ownership, not scope, is the discriminator, and the `scope === 'session'
   * → admin only` line this replaced is not a rule to restore. That line dates
   * from #960, when every row was shared and scope was the only thing there
   * was to key on; it was never a decision about a session-scoped row somebody
   * owns, because none existed. A marketplace install is exactly that row, so
   * keying on scope would mean the member who installed a server could never
   * refresh its capabilities.
   *
   * Nothing that existed before this loosens: a pre-ownership row has
   * `owner_user_id = NULL`, so the owner test fails and it falls through to
   * the admin check exactly as it used to. The caller-visibility gate in front
   * of this (`loadMcpServerForCaller`) is a separate question and still runs —
   * it answers whether the row may be named at all.
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
          oauth_compatibility_mode?: 'strict' | 'legacy';
          oauth_dcr_mode?: MCPOAuthDCRMode;
        };
        headers?: Record<string, string>;
        oauth_browser_event?: MCPOAuthBrowserEventRequest;
      },
      params?: AuthenticatedParams
    ) {
      try {
        const browserReservation = consumeOAuthBrowserReservation(
          data.oauth_browser_event,
          params,
          {
            operation: 'discover',
            mcpServerId: data.mcp_server_id,
          }
        );
        const assertBrowserReservation = reservationAssertion(browserReservation);
        // Before browser emit this is the expiring reservation assertion. A
        // successful server-issued attempt promotes it to a non-expiring,
        // request-bounded live-socket assertion while the callback is pending.
        let assertRequestAuthority = assertBrowserReservation ?? requestAuthorityAssertion(params);
        const assertCurrentRequestAuthority = () => assertRequestAuthority?.();
        assertBrowserReservation?.();
        assertPublicMCPOAuthCompatibilityMode(data.auth);
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StreamableHTTPClientTransport } = await import(
          '@modelcontextprotocol/sdk/client/streamableHttp.js'
        );
        const { resolveMCPAuthHeaders } = await import('@agor/core/tools/mcp/jwt-auth');
        const { mergeMCPRemoteHeaders } = await import('@agor/core/tools/mcp/http-headers');
        const tenantId = tenantIdFromParams(params);

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
        const isTemplated = (url: string): boolean => hasTemplateMarker(url);

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
          source?: MCPServer['source'];
          catalog_entry_name?: string;
        };
        let serverId: string | undefined;
        let authoritativeServer: MCPServer | undefined;
        let discoveryAuthority: MCPDiscoveryAuthoritySnapshot | undefined;

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
            const server = await runWithinOAuthBrowserReservation(browserReservation, () =>
              runInOAuthTenantScope(db, tenantId, () =>
                loadMcpServerForCaller(db, data.mcp_server_id as string, params)
              )
            );
            const denial = denyDiscoverOfAnotherUsersServer(server, params);
            if (denial) return denial;
            authoritativeServer = server;
            // Supplying a saved ID makes the row authoritative on every
            // database. Settings may submit an unsaved form snapshot for a
            // connection test, but a grant-producing OAuth probe must never
            // authorize that transient URL/auth/header configuration and then
            // persist the token under a different saved row.
            serverConfig = {
              url: server.url || '',
              transport: (server.transport as 'http' | 'sse') || (server.url ? 'http' : 'stdio'),
              auth: server.auth,
              headers: server.headers,
              name: server.name,
              scope: server.scope,
              owner_user_id: server.owner_user_id,
              source: server.source,
              catalog_entry_name: server.catalog_entry_name,
            };
            serverId = data.mcp_server_id;
          }
        } else if (data.mcp_server_id) {
          const server = await runWithinOAuthBrowserReservation(browserReservation, () =>
            runInOAuthTenantScope(db, tenantId, () =>
              loadMcpServerForCaller(db, data.mcp_server_id as string, params)
            )
          );
          const denial = denyDiscoverOfAnotherUsersServer(server, params);
          if (denial) return denial;
          authoritativeServer = server;
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
            source: server.source,
            catalog_entry_name: server.catalog_entry_name,
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
        if (serverId && authoritativeServer) {
          // Capture the exact authority/configuration used by this probe before
          // the first provider-controlled await. Persistence re-locks and
          // compares it after discovery; the request never carries this stamp.
          discoveryAuthority = await runWithinOAuthAuthority(assertCurrentRequestAuthority, () =>
            runWithTenantDatabaseScope(db, tenantId, (scopedDb) =>
              captureMCPDiscoveryAuthority(
                scopedDb,
                tenantId,
                userId,
                authoritativeServer as MCPServer
              )
            )
          );
        }

        const { resolveUserEnvironment } = await import('@agor/core/config');
        const { resolveProbeServerTemplates } = await import('./utils/mcp-probe-templates.js');

        const userEnv = await runWithinOAuthBrowserReservation(browserReservation, () =>
          runInOAuthTenantScope(db, tenantId, () => resolveUserEnvironment(userId, db))
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
        if (discoveryAuthority) {
          discoveryAuthority = bindMCPDiscoveryResolvedConfiguration(
            discoveryAuthority,
            {
              url: resolution.resolved.url,
              transport: resolution.resolved.transport,
              auth: resolution.resolved.auth,
              headers: resolution.resolved.headers,
            },
            process.env.AGOR_MASTER_SECRET ?? ''
          );
        }

        console.log('[MCP Discovery] Starting test for:', serverConfig.name || 'inline-config');

        assertBrowserReservation?.();
        let authHeaders = await runWithinOAuthBrowserReservation(browserReservation, () =>
          resolveMCPAuthHeaders(serverConfig.auth, serverConfig.url, {
            allowLocalhostHttp: !postgresOAuthDeployment,
            cacheNamespace: [tenantId ?? '<standalone>', serverId ?? '<unsaved>', userId].join(':'),
            disableProcessTokenCache: !!durableOAuthFlows,
            assertCurrent: assertRequestAuthority,
          })
        );

        const probeAndAcquireOAuthToken = async (mcpUrl: string): Promise<string | undefined> => {
          try {
            const probeResponse = await runWithinOAuthBrowserReservation(browserReservation, () =>
              oauthFetch(
                mcpUrl,
                {
                  method: 'GET',
                  headers: mergeMCPRemoteHeaders({
                    base: { Accept: 'application/json' },
                    custom: serverConfig.headers,
                  }) ?? { Accept: 'application/json' },
                },
                assertRequestAuthority
              )
            );
            const wwwAuthenticate = probeResponse.headers.get('www-authenticate');
            if (probeResponse.status !== 401) return undefined;
            // Provider discovery and dynamic client registration can create
            // durable state outside Agor. Never begin either unless this
            // exact socket/caller/operation already consumed a server-issued
            // one-shot reservation.
            if (!browserReservation) return undefined;
            assertBrowserReservation?.();
            const { resolveMCPOAuthDiscovery } = await import(
              '@agor/core/tools/mcp/oauth-mcp-transport'
            );
            const compatibilityPolicy = await runWithinOAuthBrowserReservation(
              browserReservation,
              () =>
                resolveMCPOAuthCompatibilityPolicy(
                  authoritativeServer ?? {
                    ...serverConfig,
                    source: serverConfig.source ?? 'user',
                  }
                )
            );
            const compatibilityMode = compatibilityPolicy.mode;
            logMCPOAuthCompatibilityPolicy('discover', serverId, compatibilityPolicy);
            const discovery = await resolveMCPOAuthDiscovery(wwwAuthenticate, mcpUrl, {
              compatibilityMode,
              allowLocalhostHttp: !postgresOAuthDeployment,
              assertCurrent: assertBrowserReservation,
            });
            if (!discovery) return undefined;

            // Route through the daemon's two-phase flow (callback → daemon's
            // public URL) instead of the legacy 127.0.0.1 callback server, so
            // remote browsers can complete the redirect on a deployed Agor.
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
              // A saved ID always binds discovery and any resulting grant to
              // the authoritative row. Only an unsaved standalone probe may
              // use inline configuration, and that path cannot persist a grant.
              oauthMode: serverConfig.auth?.oauth_mode ?? 'per_user',
              clientId: serverConfig.auth?.oauth_client_id,
              clientSecret: serverConfig.auth?.oauth_client_secret,
              authorizationUrlOverride: serverConfig.auth?.oauth_authorization_url,
              tokenUrlOverride: serverConfig.auth?.oauth_token_url,
              scope: serverConfig.auth?.oauth_scope,
              compatibilityMode,
              dcrMode: serverConfig.auth?.oauth_dcr_mode,
              tenantId,
              socketId: socketIdFromParams(params),
              browserReservation,
            });

            if (!started.assertRequestAuthority) {
              throw new Forbidden('OAuth callback request authority is unavailable');
            }
            assertRequestAuthority = started.assertRequestAuthority;
            const tokenResponse = await started.awaitToken();
            // The callback durably persisted the token row. The access token
            // is returned only to this in-flight request and is never cached
            // in an origin-only process namespace.
            if (serverId && discoveryAuthority) {
              const grantSubject =
                (serverConfig.auth?.oauth_mode ?? 'per_user') === 'shared' ? null : userId;
              const persistedGrant = await runWithTenantDatabaseScope(db, tenantId, (scopedDb) =>
                new UserMCPOAuthTokenRepository(scopedDb, process.env.AGOR_MASTER_SECRET).getToken(
                  grantSubject,
                  serverId as MCPServerID
                )
              );
              if (
                !persistedGrant ||
                persistedGrant.oauth_access_token !== tokenResponse.access_token
              ) {
                throw new Conflict('OAuth authorization changed during MCP discovery. Retry.');
              }
              discoveryAuthority = bindMCPDiscoveryOAuthGrant(
                discoveryAuthority,
                grantSubject,
                persistedGrant,
                process.env.AGOR_MASTER_SECRET ?? ''
              );
            }
            return tokenResponse.access_token;
          } catch (error) {
            // A provider/DB rejection is allowed to degrade to "no fresh
            // token" only while this exact browser authority is still live.
            // Expiry or socket replacement must escape before callers build
            // private headers or open another MCP connection.
            assertRequestAuthority?.();
            // Misconfigured public base URL is a daemon-level problem, not a
            // missing-token signal — re-throw so the discover endpoint can
            // surface it to the caller instead of silently falling through to
            // an unauthenticated MCP probe.
            const recovery = classifyMCPAuthRecovery(error);
            if (
              recovery.category === 'redirect_configuration_required' ||
              recovery.category === 'permission_changed' ||
              recovery.category === 'configuration_changed'
            ) {
              throw error;
            }
            externalFailure('MCP Discovery OAuth token acquisition', 'discovery', error);
            return undefined;
          }
        };

        if (!authHeaders && serverConfig.auth?.type === 'oauth' && serverConfig.url) {
          // Durable token rows are the only daemon authority. The old cache
          // keyed solely by MCP origin could cross tenant/server/user grants.
          let oauthToken: string | undefined;
          let selectedGrant: UserMCPOAuthToken | undefined;
          const lookupUserId = serverConfig.auth?.oauth_mode === 'shared' ? null : userId;
          if (serverId) {
            selectedGrant = await runWithinOAuthBrowserReservation(browserReservation, () =>
              runWithTenantDatabaseScope(db, tenantId, async (scopedDb) => {
                const tokenRepo = new UserMCPOAuthTokenRepository(scopedDb);
                const grant = await runWithinOAuthBrowserReservation(browserReservation, () =>
                  tokenRepo.getToken(lookupUserId, serverId as MCPServerID)
                );
                if (!grant) return undefined;
                const compatibilityPolicy = await runWithinOAuthBrowserReservation(
                  browserReservation,
                  () =>
                    resolveMCPOAuthCompatibilityPolicy(
                      authoritativeServer ?? {
                        ...serverConfig,
                        source: serverConfig.source ?? 'user',
                      }
                    )
                );
                if (
                  shouldVerifyMCPOAuthGrantBinding(
                    isPostgresDatabaseHandle(db),
                    grant.grant_binding_version
                  ) &&
                  !isMCPOAuthGrantBoundToServer(
                    process.env.AGOR_MASTER_SECRET!,
                    {
                      mcp_server_id: serverId as MCPServerID,
                      enabled: true,
                      transport: serverConfig.transport,
                      url: serverConfig.url,
                      source: serverConfig.source ?? 'user',
                      catalog_entry_name: serverConfig.catalog_entry_name,
                      headers: serverConfig.headers,
                      auth: serverConfig.auth,
                    },
                    grant,
                    compatibilityPolicy.mode
                  )
                ) {
                  return undefined;
                }
                if (grant.oauth_token_expires_at && grant.oauth_token_expires_at <= new Date()) {
                  return undefined;
                }
                return grant;
              })
            );
            oauthToken = selectedGrant?.oauth_access_token;
            if (selectedGrant && discoveryAuthority) {
              discoveryAuthority = bindMCPDiscoveryOAuthGrant(
                discoveryAuthority,
                lookupUserId,
                selectedGrant,
                process.env.AGOR_MASTER_SECRET ?? ''
              );
            }
          }
          if (!oauthToken) {
            const freshToken = await probeAndAcquireOAuthToken(serverConfig.url);
            if (freshToken) oauthToken = freshToken;
          }
          if (oauthToken) {
            assertCurrentRequestAuthority();
            authHeaders = { Authorization: `Bearer ${oauthToken}` };
          }
        }

        assertCurrentRequestAuthority();
        const headers = mergeMCPRemoteHeaders({
          base: { Accept: 'application/json, text/event-stream' },
          custom: serverConfig.headers,
          auth: authHeaders,
        }) ?? { Accept: 'application/json, text/event-stream' };

        const createMCPConnection = (connHeaders: Record<string, string>) => {
          const connSessionAwareFetch = createAuthorityGuardedMCPFetch(
            oauthFetch,
            assertCurrentRequestAuthority
          );
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
            await runWithinOAuthAuthority(assertCurrentRequestAuthority, () =>
              Promise.race([mcpClient.connect(mcpTransport), timeout])
            );
          };

          try {
            await connectWithTimeout(client, httpTransport);
          } catch (connectError) {
            assertCurrentRequestAuthority();
            if (classifyMCPAuthRecovery(connectError).category === 'permission_changed') {
              throw connectError;
            }
            if (hadCachedOAuthToken && serverConfig.url && serverConfig.auth?.type === 'oauth') {
              const freshToken = await probeAndAcquireOAuthToken(serverConfig.url);
              if (freshToken) {
                assertCurrentRequestAuthority();
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
          type ResourcesResult = MCPListResult<{
            uri: string;
            name: string;
            description?: string;
            mimeType?: string;
          }>;
          type PromptsResult = MCPListResult<{
            name: string;
            description?: string;
            arguments?: Array<{ name: string; description?: string; required?: boolean }>;
          }>;

          const toolsResult = (await runWithinOAuthAuthority(assertCurrentRequestAuthority, () =>
            Promise.race([client.listTools(), listTimeout])
          )) as ToolsResult;
          const optionalList = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
            try {
              return await runWithinOAuthAuthority(assertCurrentRequestAuthority, work);
            } catch {
              assertCurrentRequestAuthority();
              return fallback;
            }
          };
          const resourcesResult = (await Promise.race([
            optionalList(() => client.listResources(), { resources: [] }),
            listTimeout,
          ])) as ResourcesResult;
          const promptsResult = (await Promise.race([
            optionalList(() => client.listPrompts(), { prompts: [] }),
            listTimeout,
          ])) as PromptsResult;

          const discoveredCapabilities: DiscoveredMCPCapabilities = {
            tools: toolsResult.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
            resources: resourcesResult.resources.map((resource) => ({
              uri: resource.uri,
              name: resource.name,
              description: resource.description,
              mimeType: resource.mimeType,
            })),
            prompts: promptsResult.prompts.map((prompt) => ({
              name: prompt.name,
              description: prompt.description,
              arguments: prompt.arguments?.map((argument) => ({
                name: argument.name,
                description: argument.description,
                required: argument.required,
              })),
            })),
          };
          let responseCapabilities = discoveredCapabilities;

          if (serverId && discoveryAuthority) {
            responseCapabilities = await runWithinOAuthAuthority(
              assertCurrentRequestAuthority,
              () =>
                runWithTenantDatabaseTransaction(db, tenantId, (scopedDb) =>
                  persistDiscoveredMCPCapabilities(
                    scopedDb,
                    tenantId,
                    discoveryAuthority as MCPDiscoveryAuthoritySnapshot,
                    discoveredCapabilities,
                    process.env.AGOR_MASTER_SECRET ?? ''
                  )
                )
            );
            // Discovery writes through a short repository transaction rather
            // than the generic MCP service. Refresh every device belonging to
            // the actor and durable owner with the same empty, tenant-targeted
            // control event used by Marketplace actions.
            emitMarketplaceChanged(
              app,
              tenantId,
              [userId, authoritativeServer?.owner_user_id].filter(Boolean) as UserID[]
            );
          }

          return {
            success: true,
            capabilities: {
              tools: responseCapabilities.tools.length,
              resources: responseCapabilities.resources.length,
              prompts: responseCapabilities.prompts.length,
            },
            tools: responseCapabilities.tools.map((tool) => ({
              name: tool.name,
              description: tool.description || '',
            })),
            resources: responseCapabilities.resources.map((resource) => ({
              name: resource.name,
              uri: resource.uri,
              mimeType: resource.mimeType,
            })),
            prompts: responseCapabilities.prompts.map((prompt) => ({
              name: prompt.name,
              description: prompt.description || '',
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
        const recovery = classifyMCPAuthRecovery(error);
        if (recovery.category === 'redirect_configuration_required') {
          console.error('[MCP Discovery] category=redirect_configuration_required');
          return { success: false, error: recovery.message, recovery };
        }
        if (
          recovery.category === 'authentication_required' ||
          recovery.category === 'permission_changed' ||
          recovery.category === 'configuration_changed'
        ) {
          return { success: false, error: recovery.message, recovery };
        }
        const safe = externalFailure('MCP Discovery', 'discovery', error);
        return { success: false, error: safe.message, category: safe.category };
      }
    },
  });

  app.service('mcp-servers/discover').hooks({ before: { create: [ctx.requireAuth] } });

  /**
   * Role floor for the endpoints that issue capability rather than exercise it.
   *
   * Each of the services above authenticates and then admits the caller who
   * owns the named row (`loadMcpServerForCaller`). Ownership survives a role
   * change — nothing revisits `owner_user_id` when a user is demoted — so
   * without this a user demoted to `viewer` keeps every one of these: starting
   * an OAuth flow, exchanging the code, refreshing the grant, and re-probing
   * the server on its stored credential. Configuration CRUD already grew this
   * floor (`authorizeMcpServerWrite`); these are the rest of it.
   *
   * Registered by one pass over `MCP_CAPABILITY_ISSUING_SERVICE_PATHS` — where
   * the reasoning and the deliberate exclusions live — rather than added to
   * each `.hooks()` call above, which is spread over ~1,800 lines and is
   * exactly where the next endpoint would be forgotten. Same shape as the
   * tenant-identity registration loop.
   */
  registerMcpCapabilityRoleFloor(app);

  return { oauthCallbackHandler };
}

// ============================================================================
// Bootstrap Superadmin Users
// ============================================================================

export async function bootstrapSuperadminUsers(
  config: AgorConfig,
  db: TenantScopeAwareDatabase,
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

  const multiTenancy = resolveMultiTenancyConfig(config);
  if (multiTenancy.mode !== 'static') {
    throw new Error(
      'execution.bootstrap_superadmin_users requires multi_tenancy.mode=static; tenant identity is ambiguous in required_from_auth mode'
    );
  }
  const tenant = {
    tenant_id: multiTenancy.static_tenant_id,
    source: 'static' as const,
  };
  const trustedParams = { tenant } as unknown as Params;

  let promotedCount = 0;
  await runWithTenantDatabaseTransaction(db, tenant.tenant_id, async (scopedDb) => {
    // Bind the service to the transaction handle. A long-lived service owns the
    // base PostgreSQL handle and would execute outside the SET LOCAL RLS scope.
    const usersService = createTenantTransactionUsersService(scopedDb, config);
    for (const rawUserId of bootstrapUsers) {
      const userId = rawUserId?.trim();
      if (!userId) continue;
      try {
        // biome-ignore lint/suspicious/noExplicitAny: userId is a branded UserID at runtime
        const user = await usersService.get(userId as any, trustedParams);
        if (user.role === ROLES.SUPERADMIN) continue;
        // Deliberately use the provider-less, actor-less UsersService seam.
        // The surrounding static-tenant transaction supplies RLS identity and
        // lets UsersService take the tenant authorization fence.
        // biome-ignore lint/suspicious/noExplicitAny: userId is a branded UserID at runtime
        await usersService.patch(userId as any, { role: ROLES.SUPERADMIN }, trustedParams);
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
  });
  console.log(
    `[RBAC] Bootstrap superadmin sync complete (${promotedCount}/${bootstrapUsers.length} promoted)`
  );
}
