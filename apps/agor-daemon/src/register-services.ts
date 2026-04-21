/**
 * Service Registration
 *
 * Registers all FeathersJS services on the app instance.
 * Extracted from index.ts for maintainability.
 */

import {
  type AgorConfig,
  getBaseUrl,
  PublicBaseUrlNotConfiguredError,
  requirePublicBaseUrl,
} from '@agor/core/config';
import {
  and,
  type Database,
  eq,
  inArray,
  MCPServerRepository,
  type SessionMCPServerRow,
  select,
  sessionMcpServers,
  UserMCPOAuthTokenRepository,
  WorktreeRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  HookContext,
  MessageSource,
  SessionID,
  UserID,
} from '@agor/core/types';
import { AGENTIC_TOOL_CAPABILITIES, SessionStatus, TaskStatus } from '@agor/core/types';
import type { UnixUserMode } from '@agor/core/unix';
import type express from 'express';
import type {
  BoardsServiceImpl,
  MessagesServiceImpl,
  SessionsServiceImpl,
} from './declarations.js';
import { trackExecutorProcess, untrackExecutorProcess } from './executor-tracking.js';
import {
  cacheOAuth21Token,
  clearOAuth21Token,
  getOAuth21Token,
  getOAuth21TokenFromDB,
  getOAuth21TokenFromDBByUrl,
  oauth21TokenCache,
  persistOAuthToken,
} from './oauth-cache.js';
import type { ArtifactsService } from './services/artifacts.js';
import { createArtifactsService } from './services/artifacts.js';
import { createBoardCommentsService } from './services/board-comments.js';
import { createBoardObjectsService } from './services/board-objects.js';
import { createBoardsService } from './services/boards.js';
import { createCardTypesService } from './services/card-types.js';
import { createCardsService } from './services/cards.js';
import { createConfigService } from './services/config.js';
import { createContextService } from './services/context.js';
import { createFileService } from './services/file.js';
import { createFilesService } from './services/files.js';
import { createGatewayService } from './services/gateway.js';
import { createGatewayChannelsService } from './services/gateway-channels.js';
import { registerGitHubAppSetupRoutes } from './services/github-app-setup.js';
import { createLeaderboardService } from './services/leaderboard.js';
import { createMCPServersService } from './services/mcp-servers.js';
import { createMessagesService } from './services/messages.js';
import { performOAuthDisconnect } from './services/oauth-disconnect.js';
import { createReposService } from './services/repos.js';
import { createSessionEnvSelectionsService } from './services/session-env-selections.js';
import { createSessionMCPServersService } from './services/session-mcp-servers.js';
import { createSessionsService } from './services/sessions.js';
import { createTasksService } from './services/tasks.js';
import { TerminalsService } from './services/terminals.js';
import { createThreadSessionMapService } from './services/thread-session-map.js';
import { createUsersService } from './services/users.js';
import { setupWorktreeOwnersService } from './services/worktree-owners.js';
import { createWorktreesService } from './services/worktrees.js';
import { escapeHtml } from './utils/html.js';
import {
  computeFileHash,
  findCodexSessionFile,
  getCodexHome,
  getSessionFilePath,
} from './utils/session-state.js';
import { pullIfNeeded, pushAsync } from './utils/session-state-hooks.js';

/**
 * Interface for dependencies needed by service registration.
 */
export interface RegisterServicesContext {
  db: Database;
  app: Application & { io?: import('socket.io').Server };
  config: AgorConfig;
  svcEnabled: (group: string) => boolean;
  jwtSecret: string;
  daemonUrl: string;
  isProduction: boolean;
  DAEMON_PORT: number;
  UI_PORT: number;
  worktreeRbacEnabled: boolean;
  allowSuperadmin: boolean;
  requireAuth: (context: HookContext) => Promise<HookContext>;
}

/**
 * References to registered services (returned for use by hooks and routes).
 */
export interface RegisteredServices {
  sessionsService: SessionsServiceImpl;
  messagesService: MessagesServiceImpl;
  boardsService: BoardsServiceImpl | undefined;
  worktreeRepository: WorktreeRepository;
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
  const {
    db,
    app,
    config,
    svcEnabled,
    jwtSecret,
    daemonUrl,
    worktreeRbacEnabled,
    allowSuperadmin,
  } = ctx;

  const _superadminOpts = { allowSuperadmin };

  // Helper: safely get a service (returns undefined if not registered due to tier=off)
  const safeService = (path: string) => {
    try {
      return app.service(path);
    } catch {
      return undefined;
    }
  };

  // Initialize session token service
  const { SessionTokenService } = await import('./services/session-token-service.js');
  const sessionTokenService = new SessionTokenService({
    expiration_ms: config.execution?.session_token_expiration_ms || 24 * 60 * 60 * 1000,
    max_uses: config.execution?.session_token_max_uses || -1,
  });

  const appRecord = app as unknown as Record<string, unknown>;
  appRecord.sessionTokenService = sessionTokenService;

  // Initialize MCP token module.
  const { initMcpTokens } = await import('./mcp/tokens.js');
  initMcpTokens({
    db,
    expirationMs: config.execution?.mcp_token_expiration_ms,
  });

  // ============================================================================
  // Core services: sessions, tasks, messages
  // ============================================================================

  const sessionsService = createSessionsService(db, app) as unknown as SessionsServiceImpl;
  app.use('/sessions', sessionsService, {
    events: ['permission:request', 'permission:timeout'],
  });

  // Wire up the execute handler for spawning executor processes
  sessionsService.setExecuteHandler(
    createExecuteHandler(ctx, sessionsService, sessionTokenService)
  );

  app.use('/tasks', createTasksService(db, app), {
    events: ['tool:start', 'tool:complete', 'thinking:chunk'],
  });
  if (svcEnabled('leaderboard')) {
    app.use('/leaderboard', createLeaderboardService(db));
  }
  const messagesService = createMessagesService(db) as unknown as MessagesServiceImpl;

  app.use('/messages', messagesService, {
    methods: [
      'find',
      'get',
      'create',
      'update',
      'patch',
      'remove',
      'findBySession',
      'findByTask',
      'findByRange',
      'createMany',
    ],
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
      'input_resolved',
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

  // ============================================================================
  // Boards, board-objects, cards, artifacts, board-comments
  // ============================================================================

  if (svcEnabled('boards')) {
    app.use('/boards', createBoardsService(db), {
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
      ],
    });
    app.use('/board-objects', createBoardObjectsService(db));
  }

  const boardsService = safeService('boards') as unknown as BoardsServiceImpl | undefined;

  if (svcEnabled('cards')) {
    app.use('/card-types', createCardTypesService(db));
    app.use('/cards', createCardsService(db));
  }

  if (svcEnabled('artifacts')) {
    app.use('/artifacts', createArtifactsService(db, app));

    // Detect self-hosted Sandpack bundler
    {
      const pathMod = await import('node:path');
      const { fileURLToPath: toPath } = await import('node:url');
      const { existsSync: exists } = await import('node:fs');
      const dir =
        typeof __dirname !== 'undefined' ? __dirname : pathMod.dirname(toPath(import.meta.url));
      const sandpackPath = pathMod.resolve(dir, '../static/sandpack');
      if (exists(sandpackPath)) {
        const baseUrl = await getBaseUrl();
        const origin = new URL(baseUrl).origin;
        const bundlerURL = `${origin}/static/sandpack/`;
        const artifactsService = app.service('artifacts') as unknown as ArtifactsService;
        artifactsService.selfHostedBundlerURL = bundlerURL;
        console.log(`🧩 Self-hosted Sandpack bundler detected: ${bundlerURL}`);
      }
    }
  }

  if (svcEnabled('boards')) {
    app.use('/board-comments', createBoardCommentsService(db));
  }

  // ============================================================================
  // Worktrees, repos
  // ============================================================================

  app.use('/worktrees', createWorktreesService(db, app));

  console.log(`[RBAC] Worktree RBAC ${worktreeRbacEnabled ? 'Enabled' : 'Disabled'}`);
  console.log(`[RBAC] Superadmin bypass ${allowSuperadmin ? 'Enabled' : 'Disabled'}`);

  if (
    worktreeRbacEnabled &&
    !app.services['worktrees/:id/owners'] &&
    !app.services['worktrees/:id/owners/:userId']
  ) {
    const worktreeRepo = new WorktreeRepository(db);
    setupWorktreeOwnersService(app, worktreeRepo, {
      jwtSecret,
      daemonUser: config.daemon?.unix_user,
      allowSuperadmin,
    });
  }

  if (worktreeRbacEnabled) {
    const daemonUser = config.daemon?.unix_user || 'agor';
    console.log(`[Unix Integration] Executor-based sync enabled (daemon user: ${daemonUser})`);
  }

  app.use('/repos', createReposService(db, app));

  // ============================================================================
  // MCP Servers (conditionally registered)
  // ============================================================================

  let oauthCallbackHandler: ((req: express.Request, res: express.Response) => void) | null = null;

  // The OAuth callback middleware is registered in boot.ts; here we set the handler
  if (svcEnabled('mcp_servers')) {
    const mcpResult = await registerMCPServices(ctx, sessionsService);
    oauthCallbackHandler = mcpResult.oauthCallbackHandler;
  }

  // ============================================================================
  // Gateway services
  // ============================================================================

  if (svcEnabled('gateway')) {
    app.use('/gateway-channels', createGatewayChannelsService(db));
    app.use('/thread-session-map', createThreadSessionMapService(db));
    app.use('/gateway', createGatewayService(db, app), {
      methods: ['create', 'routeMessage'],
    });

    const isProduction = ctx.isProduction;
    const uiUrl = isProduction ? `${daemonUrl}/ui` : `http://localhost:${ctx.UI_PORT}`;
    registerGitHubAppSetupRoutes(app, { uiUrl, daemonUrl, db });
  }

  // ============================================================================
  // Config, context, file, files, terminals
  // ============================================================================

  const configService = createConfigService(db);
  configService.app = app;
  app.use('/config', configService);

  app.use('/config/resolve-api-key', {
    // biome-ignore lint/suspicious/noExplicitAny: taskId is branded UUID at runtime
    async create(data: any) {
      return await configService.resolveApiKey(data);
    },
  });

  const worktreeRepository = new WorktreeRepository(db);
  const { UsersRepository, SessionRepository } = await import('@agor/core/db');
  const usersRepository = new UsersRepository(db);
  const sessionsRepository = new SessionRepository(db);

  if (svcEnabled('file_browser')) {
    app.use('/context', createContextService(worktreeRepository));
    app.use('/file', createFileService(worktreeRepository));
    app.use('/files', createFilesService(db));
  }

  const terminalsService = svcEnabled('terminals') ? new TerminalsService(app, db) : null;
  if (terminalsService) {
    app.use('/terminals', terminalsService, {
      events: ['data', 'exit'],
    });
  }

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
  // queryable read here — a worktree collaborator with `view`/`prompt`
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

  if (svcEnabled('mcp_servers')) {
    app.use('/session-mcp-servers', {
      async find(params?: {
        query?: {
          session_id?: string | { $in?: string[] };
          mcp_server_id?: string;
          enabled?: boolean;
        };
      }) {
        const conditions: ReturnType<typeof eq>[] = [];
        // session_id may be a scalar string or `{ $in: [...] }` — the latter is
        // injected by the RBAC scoping hook to restrict rows to accessible sessions.
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
        let query = select(db).from(sessionMcpServers);
        if (conditions.length > 0) {
          query = query.where(and(...conditions)) as typeof query;
        }
        const rows = await query.all();
        return rows.map((row: SessionMCPServerRow) => ({
          session_id: row.session_id,
          mcp_server_id: row.mcp_server_id,
          enabled: Boolean(row.enabled),
          added_at: new Date(row.added_at),
        }));
      },
    });
  }

  // ============================================================================
  // Users service
  // ============================================================================

  const usersService = createUsersService(db);
  app.use('/users', usersService);

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
    worktreeRepository,
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

function createExecuteHandler(
  ctx: RegisterServicesContext,
  sessionsService: SessionsServiceImpl,
  sessionTokenService: import('./services/session-token-service.js').SessionTokenService
) {
  const { db, app, config, daemonUrl } = ctx;

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
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const session = await sessionsService.get(sessionId, params);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Validate stateless_fs_mode compatibility with agentic tool
    if (config.execution?.stateless_fs_mode) {
      const toolName = session.agentic_tool as import('@agor/core/types').AgenticToolName;
      const capabilities = AGENTIC_TOOL_CAPABILITIES[toolName];
      if (capabilities && !capabilities.supportsStatelessFsMode) {
        const supported = Object.entries(AGENTIC_TOOL_CAPABILITIES)
          .filter(([, caps]) => caps.supportsStatelessFsMode)
          .map(([name]) => name)
          .join(', ');
        throw new Error(
          `stateless_fs_mode is enabled but tool '${toolName}' does not support it. ` +
            `Supported tools: ${supported}`
        );
      }
    }

    // Generate session token for executor authentication
    const appWithExecutor = app as unknown as {
      sessionTokenService?: import('./services/session-token-service.js').SessionTokenService;
    };
    if (!appWithExecutor.sessionTokenService) {
      throw new Error('Session token service not initialized');
    }
    const sessionToken = await appWithExecutor.sessionTokenService.generateToken(
      sessionId,
      (params as AuthenticatedParams).user?.user_id || 'anonymous'
    );

    const taskId = data.taskId;

    // Get worktree path
    let cwd = process.cwd();
    if (session.worktree_id) {
      try {
        const worktree = await app.service('worktrees').get(session.worktree_id, params);
        cwd = worktree.path;
      } catch (error) {
        console.warn(`Could not get worktree path for ${session.worktree_id}:`, error);
      }
    }

    // Find executor binary
    const dirname =
      typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    const { existsSync } = await import('node:fs');
    const possiblePaths = [
      path.join(dirname, '../executor/cli.js'),
      path.join(dirname, '../../../packages/executor/bin/agor-executor'),
      path.join(dirname, '../../../packages/executor/dist/cli.js'),
    ];
    const executorPath = possiblePaths.find((p) => existsSync(p));
    if (!executorPath) {
      throw new Error(
        `Executor binary not found. Tried:\n${possiblePaths.map((p) => `  - ${p}`).join('\n')}`
      );
    }
    console.log(`[Daemon] Using executor at: ${executorPath}`);

    // Determine Unix user for executor
    const {
      resolveUnixUserForImpersonation,
      validateResolvedUnixUser,
      UnixUserNotFoundError,
      buildSpawnArgs,
      getHomedirFromUsername,
      prepareImpersonationEnv,
      attachEnvFileCleanup,
    } = await import('@agor/core/unix');

    const unixUserMode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;
    const configExecutorUser = config.execution?.executor_unix_user;
    const sessionUnixUser = session.unix_username;

    console.log('[Daemon] Determining executor Unix user:', {
      sessionId: session.session_id.slice(0, 8),
      unixUserMode,
      sessionUnixUser,
      configExecutorUser,
    });

    const impersonationResult = resolveUnixUserForImpersonation({
      mode: unixUserMode,
      userUnixUsername: sessionUnixUser,
      executorUnixUser: configExecutorUser,
    });

    const executorUnixUser = impersonationResult.unixUser;
    console.log(`[Daemon] Executor impersonation: ${impersonationResult.reason}`);

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
    const userId = (params as AuthenticatedParams).user?.user_id as UserID | undefined;

    // Resolve gateway-level env vars
    let gatewayEnv: import('@agor/core/types').GatewayEnvVar[] | undefined;
    const gatewaySource = (session.custom_context as Record<string, unknown> | undefined)
      ?.gateway_source as { channel_id?: string } | undefined;
    if (gatewaySource?.channel_id) {
      try {
        const { GatewayChannelRepository, decryptApiKey, isEncrypted } = await import(
          '@agor/core/db'
        );
        const channelRepo = new GatewayChannelRepository(db);
        const channel = await channelRepo.findById(gatewaySource.channel_id);
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
      } catch {
        // Non-fatal
      }
    }

    const executorEnv = await createUserProcessEnvironment(
      userId,
      db,
      undefined,
      !!executorUnixUser,
      gatewayEnv,
      sessionId as SessionID
    );

    // Validate required user environment variables
    const { SessionRepository: SessRepo, MessagesRepository: _MsgRepo } = await import(
      '@agor/core/db'
    );
    const sessionsRepository = new SessRepo(db);
    const requiredUserEnvVars = config.execution?.required_user_env_vars;
    if (requiredUserEnvVars && requiredUserEnvVars.length > 0) {
      const missingVars = requiredUserEnvVars.filter((v: string) => !executorEnv[v]);
      if (missingVars.length > 0) {
        const { generateId } = await import('@agor/core/db');
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
        const messagesService = app.service('messages') as unknown as MessagesServiceImpl;
        const systemMessage = {
          message_id: generateId() as import('@agor/core/types').Message['message_id'],
          session_id: sessionId as import('@agor/core/types').Message['session_id'],
          task_id: data.taskId as import('@agor/core/types').Message['task_id'],
          type: 'system' as const,
          role: 'system' as import('@agor/core/types').Message['role'],
          content: errorContent,
          content_preview: `Missing required env vars: ${missingVars.join(', ')}`,
          index: await sessionsRepository.countMessages(sessionId),
          timestamp: new Date().toISOString(),
        };
        await messagesService.create(systemMessage);
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
      }
    }

    executorEnv.DAEMON_URL = daemonUrl;

    // Build executor payload
    const executorPayload = {
      command: 'prompt' as const,
      sessionToken,
      daemonUrl,
      env: executorEnv,
      params: {
        sessionId,
        taskId,
        prompt: data.prompt,
        tool: session.agentic_tool as 'claude-code' | 'gemini' | 'codex' | 'opencode' | 'copilot',
        permissionMode: permissionModeForPayload as 'ask' | 'auto' | 'allow-all' | undefined,
        cwd,
        messageSource: data.messageSource,
      },
    };

    // Route secret-looking env vars through an on-disk env file owned by the
    // target user (mode 0600) so API keys/tokens never appear in argv.
    const prepared = executorUnixUser
      ? prepareImpersonationEnv({ asUser: executorUnixUser, env: executorEnv })
      : { inlineEnv: undefined, envFilePath: undefined };

    const { cmd, args } = buildSpawnArgs('node', [executorPath, '--stdin'], {
      asUser: executorUnixUser || undefined,
      env: executorUnixUser ? prepared.inlineEnv : undefined,
      envFilePath: prepared.envFilePath,
    });

    if (executorUnixUser) {
      console.log(
        `[Daemon] Spawning executor as user=${executorUnixUser}${
          prepared.envFilePath ? ' (secrets in env-file)' : ''
        }`
      );
    } else {
      console.log(`[Daemon] Spawning executor as current user (no impersonation)`);
    }

    // Stateless FS mode: resolve executor home dir for session file path
    const executorHomeDir = executorUnixUser ? getHomedirFromUsername(executorUnixUser) : undefined;

    // Stateless FS mode: restore session file from DB before executor starts
    if (config.execution?.stateless_fs_mode && session.sdk_session_id) {
      try {
        await pullIfNeeded({
          db,
          sessionId,
          sdkSessionId: session.sdk_session_id,
          worktreePath: cwd,
          tool: session.agentic_tool,
          executorHomeDir,
        });
      } catch (err) {
        console.error(
          '[stateless-fs] pullIfNeeded failed:',
          err instanceof Error ? err.message : err
        );
        // Don't block the executor — proceed with potentially stale/missing session file
      }
    }

    const executorProcess = spawn(cmd, args, {
      cwd,
      env: executorUnixUser ? undefined : executorEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Safety-net cleanup for the env file. The inner bash script `rm -f`s
    // the file before exec in the normal path, so this only fires if sudo
    // or bash failed to launch at all, or `set -eu` aborted the source
    // step. Uses sudo when asUser is set so it works under sticky /tmp.
    attachEnvFileCleanup(executorProcess, {
      envFilePath: prepared.envFilePath,
      asUser: executorUnixUser || undefined,
    });

    if (executorProcess.pid) {
      trackExecutorProcess(sessionId, executorProcess.pid);
      console.log(`[Executor ${sessionId.slice(0, 8)}] PID: ${executorProcess.pid}`);
    }

    executorProcess.stdin?.write(JSON.stringify(executorPayload));
    executorProcess.stdin?.end();

    executorProcess.stdout?.on('data', (data) => {
      console.log(`[Executor ${sessionId.slice(0, 8)}] ${data.toString().trim()}`);
    });
    executorProcess.stderr?.on('data', (data) => {
      console.error(`[Executor ${sessionId.slice(0, 8)}] ${data.toString().trim()}`);
    });

    executorProcess.on('exit', async (code) => {
      console.log(`[Executor ${sessionId.slice(0, 8)}] Exited with code ${code}`);
      untrackExecutorProcess(sessionId);

      // Safety net: check if task is still running
      try {
        const currentSession = await app.service('sessions').get(sessionId, params);
        const latestTaskId = currentSession.tasks?.[currentSession.tasks.length - 1];

        if (latestTaskId && latestTaskId !== taskId) {
          console.log(
            `⏭️ [Executor] Task ${taskId.slice(0, 8)} is not the latest (latest: ${latestTaskId.slice(0, 8)}), skipping safety net`
          );
        } else if (
          currentSession.status === SessionStatus.RUNNING ||
          currentSession.status === SessionStatus.AWAITING_PERMISSION ||
          currentSession.status === SessionStatus.AWAITING_INPUT ||
          currentSession.status === SessionStatus.STOPPING ||
          currentSession.status === SessionStatus.TIMED_OUT
        ) {
          try {
            const currentTask = await app.service('tasks').get(taskId, params);
            const isTaskStillActive =
              currentTask.status === TaskStatus.RUNNING ||
              currentTask.status === 'awaiting_permission' ||
              currentTask.status === 'awaiting_input' ||
              currentTask.status === 'stopping' ||
              currentTask.status === 'timed_out';

            if (isTaskStillActive) {
              await app.service('tasks').patch(taskId, { status: TaskStatus.FAILED }, params);
              console.log(
                `✅ [Executor] Task ${taskId.slice(0, 8)} marked as FAILED after executor exit (code: ${code})`
              );
            } else {
              console.log(
                `⚠️  [Executor] Task ${taskId.slice(0, 8)} already ${currentTask.status}, but session still ${currentSession.status} — repairing session state`
              );
              await app
                .service('sessions')
                .patch(sessionId, { status: SessionStatus.IDLE, ready_for_prompt: true }, params);
            }
          } catch (taskError) {
            console.error(
              `⚠️  [Executor] Failed to mark task ${taskId.slice(0, 8)} as FAILED, falling back to session IDLE update:`,
              taskError
            );
            await app
              .service('sessions')
              .patch(sessionId, { status: SessionStatus.IDLE, ready_for_prompt: true }, params);
            console.log(
              `✅ [Executor] Session ${sessionId.slice(0, 8)} status updated to IDLE after executor exit (was: ${currentSession.status})`
            );
          }
        } else {
          console.log(
            `ℹ️  [Executor] Session ${sessionId.slice(0, 8)} already in ${currentSession.status} state, skipping IDLE update`
          );
        }
      } catch (error) {
        console.error(`❌ [Executor] Failed to handle executor exit:`, error);
      }

      // Stateless FS mode: serialize session file to DB after executor exits
      if (config.execution?.stateless_fs_mode) {
        try {
          // Re-fetch session to get sdk_session_id (may have been set during execution)
          const freshSession = await app.service('sessions').get(sessionId, params);
          if (freshSession.sdk_session_id) {
            pushAsync({
              db,
              sessionId,
              worktreeId: freshSession.worktree_id,
              taskId,
              sdkSessionId: freshSession.sdk_session_id,
              worktreePath: cwd,
              tool: freshSession.agentic_tool,
              executorHomeDir,
            });

            // Also compute and write session_md5 to the task record
            try {
              let filePath: string;
              if (freshSession.agentic_tool === 'codex') {
                const codexHome = getCodexHome(sessionId);
                const found = await findCodexSessionFile(codexHome, freshSession.sdk_session_id);
                filePath = found || '';
              } else {
                filePath = getSessionFilePath(
                  freshSession.agentic_tool,
                  cwd,
                  freshSession.sdk_session_id,
                  executorHomeDir
                );
              }
              if (filePath) {
                const md5 = await computeFileHash(filePath);
                if (md5) {
                  await app.service('tasks').patch(taskId, { session_md5: md5 }, params);
                }
              }
            } catch (md5Err) {
              console.error(
                '[stateless-fs] Failed to write session_md5 to task:',
                md5Err instanceof Error ? md5Err.message : md5Err
              );
            }
          }
        } catch (pushErr) {
          console.error(
            '[stateless-fs] pushAsync setup failed:',
            pushErr instanceof Error ? pushErr.message : pushErr
          );
        }
      }

      appWithExecutor.sessionTokenService?.revokeToken(sessionToken);
    });

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

  type OAuthTokenResponse = {
    access_token: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
  };

  type PendingOAuthFlow = {
    context: {
      metadataUrl: string;
      tokenEndpoint: string;
      redirectUri: string;
      pkceVerifier: string;
      clientId: string;
      clientSecret?: string;
      state: string;
      authorizationUrl: string;
    };
    /**
     * Origin-stable key used by {@link persistOAuthToken} to populate the
     * daemon-level token cache (`oauth21TokenCache`). MUST be the MCP server
     * URL — NOT `context.metadataUrl` — because subsequent lookups via
     * {@link getOAuth21Token} are keyed by MCP URL origin. RFC 9728 metadata
     * URLs *should* sit on the resource-server origin, but nothing enforces
     * that, and a drift would silently bust the cache.
     */
    mcpUrl: string;
    mcpServerId?: string;
    userId?: string;
    oauthMode?: 'per_user' | 'shared';
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
  };

  // Store pending OAuth flow contexts
  const pendingOAuthFlows = new Map<string, PendingOAuthFlow>();

  /**
   * Hard ceiling on how long an inbound HTTP request will block waiting for
   * the user to complete the browser-side OAuth flow. The 10-minute sweeper
   * below is the *cleanup* upper bound; this is the *request* upper bound.
   * Most reverse proxies time out long before 10 minutes, so we surface a
   * clear error sooner than that and free the pending entry.
   */
  const AWAIT_TOKEN_TIMEOUT_MS = 5 * 60 * 1000;

  // Clean up expired flows (older than 10 minutes)
  setInterval(() => {
    const now = Date.now();
    const tenMinutes = 10 * 60 * 1000;
    for (const [state, flow] of pendingOAuthFlows.entries()) {
      if (now - flow.createdAt > tenMinutes) {
        pendingOAuthFlows.delete(state);
        flow.tokenReject?.(new Error('OAuth flow expired before callback was received'));
        console.log('[OAuth] Cleaned up expired flow:', state);
      }
    }
  }, 60_000);

  /**
   * Shared helper for starting the daemon's two-phase MCP OAuth flow.
   *
   * All daemon-side OAuth paths (Settings "Start OAuth Flow", discover probe,
   * test-oauth `start_browser_flow`) MUST go through one of these two helpers
   * so that:
   *   1. The `redirect_uri` is always the daemon's PUBLIC base URL, not
   *      `127.0.0.1:<random>` — the browser completing the flow may be on a
   *      different machine than the daemon (e.g. any remotely-deployed Agor).
   *   2. The `oauth:open_browser` socket event is emitted consistently to the
   *      user who initiated the flow.
   *   3. The pending-flow entry carries `mcpUrl` so the post-callback cache
   *      key matches the MCP server origin used by all subsequent lookups.
   *
   * Two flavors:
   *   - {@link startTwoPhaseMCPOAuthFlow} — fire-and-forget. Used by
   *     `oauth-start`, where the UI completes the flow asynchronously and the
   *     daemon broadcasts `oauth:completed` over the socket.
   *   - {@link startTwoPhaseMCPOAuthFlowAndAwaitToken} — blocks on a Promise
   *     that resolves once `oauthCallbackHandler` finishes exchanging + persisting
   *     the token. Used by `discover` and `test-oauth start_browser_flow`,
   *     which need to return the token-validation result in the same HTTP
   *     response. Bounded by {@link AWAIT_TOKEN_TIMEOUT_MS}.
   */
  type StartTwoPhaseOAuthOptions = {
    mcpUrl: string;
    wwwAuthenticate: string;
    resourceMetadataUrl: string;
    mcpServerId?: string;
    userId?: string;
    oauthMode?: 'per_user' | 'shared';
    clientId?: string;
    clientSecret?: string;
    authorizationUrlOverride?: string;
    tokenUrlOverride?: string;
    scope?: string;
    socketId?: string;
  };

  type StartTwoPhaseOAuthResult = {
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

    const context = await startMCPOAuthFlow(opts.wwwAuthenticate, opts.clientId, redirectUri, {
      authorizationUrlOverride: opts.authorizationUrlOverride,
      tokenUrlOverride: opts.tokenUrlOverride,
      clientSecret: opts.clientSecret,
      scope: opts.scope,
      resourceMetadataUrl: opts.resourceMetadataUrl,
    });

    let tokenPromise: Promise<OAuthTokenResponse> | undefined;
    let tokenResolve: ((t: OAuthTokenResponse) => void) | undefined;
    let tokenReject: ((err: Error) => void) | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    if (awaitToken) {
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
          const pending = pendingOAuthFlows.get(context.state);
          if (pending) {
            pendingOAuthFlows.delete(context.state);
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

    pendingOAuthFlows.set(context.state, {
      context,
      mcpUrl: opts.mcpUrl,
      mcpServerId: opts.mcpServerId,
      userId: opts.userId,
      oauthMode: opts.oauthMode,
      socketId: opts.socketId,
      createdAt: Date.now(),
      tokenResolve,
      tokenReject,
    });

    if (app.io) {
      const payload = { authUrl: context.authorizationUrl };
      if (opts.socketId) {
        app.io.to(opts.socketId).emit('oauth:open_browser', payload);
      } else {
        app.io.emit('oauth:open_browser', payload);
      }
    }

    const base: StartTwoPhaseOAuthResult = {
      state: context.state,
      authorizationUrl: context.authorizationUrl,
      redirectUri,
    };
    if (tokenPromise) {
      return { ...base, awaitToken: () => tokenPromise! };
    }
    return base;
  }

  // Set the OAuth callback handler
  const oauthCallbackHandler = async (req: express.Request, res: express.Response) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const code = req.query.code as string | undefined;
      const state = req.query.state as string | undefined;
      const error = req.query.error as string | undefined;

      if (error) {
        const errorDescription = (req.query.error_description as string) || error;
        console.error('[OAuth Callback] Authorization error:', errorDescription);
        // Reject any awaitToken() promise from the originating flow so the
        // caller (discover / test-oauth) can surface the failure.
        if (state) {
          const pending = pendingOAuthFlows.get(state);
          pending?.tokenReject?.(new Error(`Authorization failed: ${errorDescription}`));
          pendingOAuthFlows.delete(state);
        }
        res.status(400).send(oauthResultPage(false, `Authorization failed: ${errorDescription}`));
        return;
      }

      if (!code || !state) {
        res.status(400).send(oauthResultPage(false, 'Missing code or state parameter'));
        return;
      }

      console.log('[OAuth Callback] Received callback, state:', state, 'code length:', code.length);

      const pendingFlow = pendingOAuthFlows.get(state);
      console.log(
        '[OAuth Callback] Pending flows count:',
        pendingOAuthFlows.size,
        'found:',
        !!pendingFlow
      );
      if (!pendingFlow) {
        res
          .status(400)
          .send(
            oauthResultPage(false, 'OAuth flow expired or not found. Please start the flow again.')
          );
        return;
      }

      try {
        const { completeMCPOAuthFlow } = await import('@agor/core/tools/mcp/oauth-mcp-transport');
        const tokenResponse = await completeMCPOAuthFlow(pendingFlow.context, code, state);
        pendingOAuthFlows.delete(state);

        await persistOAuthToken(
          db,
          tokenResponse,
          pendingFlow.mcpUrl,
          pendingFlow,
          'OAuth Callback'
        );

        if (app.io) {
          const oauthEvent = {
            state,
            success: true,
            mcp_server_id: pendingFlow.mcpServerId,
            oauth_mode: pendingFlow.oauthMode || 'per_user',
          };
          if (pendingFlow.socketId) {
            app.io.to(pendingFlow.socketId).emit('oauth:completed', oauthEvent);
          } else {
            app.io.emit('oauth:completed', oauthEvent);
          }
        }

        // Notify any awaitToken() callers (discover / test-oauth) that the
        // token has been exchanged + persisted so their HTTP request can
        // complete with a real result instead of timing out.
        pendingFlow.tokenResolve?.(tokenResponse);

        console.log('[OAuth Callback] Flow completed successfully');
        res.send(oauthResultPage(true, 'OAuth authentication successful! You can close this tab.'));
      } catch (innerErr) {
        // Drop the pending entry and reject any awaitToken() promise so the
        // originating service call returns an error rather than hanging.
        pendingOAuthFlows.delete(state);
        pendingFlow.tokenReject?.(
          innerErr instanceof Error ? innerErr : new Error(String(innerErr))
        );
        throw innerErr;
      }
    } catch (err) {
      console.error('[OAuth Callback] Error:', err);
      res
        .status(500)
        .send(
          oauthResultPage(
            false,
            `Authentication failed: ${err instanceof Error ? err.message : String(err)}`
          )
        );
    }
  };

  app.use('/mcp-servers', createMCPServersService(db));

  // JWT test endpoint
  app.use('/mcp-servers/test-jwt', {
    async create(data: {
      api_url: string;
      api_token: string;
      api_secret: string;
      mcp_url?: string;
    }) {
      try {
        const response = await fetch(data.api_url, {
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
      },
      params?: { connection?: { id?: string } }
    ) {
      try {
        console.log('[OAuth Test] Probing MCP URL:', data.mcp_url);

        let probeResponse: Response;
        try {
          probeResponse = await fetch(data.mcp_url, {
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

        const wwwAuthenticate = probeResponse.headers.get('www-authenticate');
        const allHeaders: Record<string, string> = {};
        probeResponse.headers.forEach((value, key) => {
          allHeaders[key] = value;
        });
        console.log('[OAuth Test] Probe response:', {
          status: probeResponse.status,
          statusText: probeResponse.statusText,
          headers: allHeaders,
        });

        let metadataUrl: string | null = null;
        if (probeResponse.status === 401) {
          const { resolveResourceMetadataUrl } = await import(
            '@agor/core/tools/mcp/oauth-mcp-transport'
          );
          const resolved = await resolveResourceMetadataUrl(wwwAuthenticate, data.mcp_url);
          if (resolved) {
            metadataUrl = resolved.metadataUrl;
            console.log(`[OAuth Test] Resolved metadata URL (${resolved.source}):`, metadataUrl);
          }
        }

        if (probeResponse.status === 401 && metadataUrl) {
          console.log('[OAuth Test] OAuth 2.1 auto-discovery detected');

          if (data.start_browser_flow) {
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
                  resourceMetadataUrl: metadataUrl,
                  mcpServerId: data.mcp_server_id,
                  userId: (params as AuthenticatedParams)?.user?.user_id,
                  // Test endpoint mirrors the previous saveOAuth21TokenToDB
                  // call (writes to the shared MCP server row, not per-user).
                  oauthMode: 'shared',
                  clientId: data.client_id,
                  socketId: connection?.id,
                });
              } catch (err) {
                if (err instanceof PublicBaseUrlNotConfiguredError) {
                  return { success: false, error: err.message, oauthType: 'oauth2.1' };
                }
                throw err;
              }

              const tokenResponse = await started.awaitToken();

              const testResponse = await fetch(data.mcp_url, {
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
              console.error('[OAuth Test] Browser flow error:', flowError);
              return {
                success: false,
                error: `OAuth 2.1 browser flow failed: ${flowError instanceof Error ? flowError.message : String(flowError)}`,
                oauthType: 'oauth2.1',
              };
            }
          }

          // Just validate metadata without browser flow
          try {
            const metadataResponse = await fetch(metadataUrl);
            if (!metadataResponse.ok) {
              return {
                success: false,
                error: `OAuth resource metadata endpoint returned ${metadataResponse.status}`,
                oauthType: 'oauth2.1',
                metadataUrl,
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
                metadataUrl,
                metadata,
              };
            }

            const authServerUrl = metadata.authorization_servers[0];
            let authServerMetadata: {
              authorization_endpoint?: string;
              token_endpoint?: string;
              registration_endpoint?: string;
            } | null = null;

            for (const wellKnownPath of [
              '/.well-known/oauth-authorization-server',
              '/.well-known/openid-configuration',
            ]) {
              try {
                const authMetaResponse = await fetch(`${authServerUrl}${wellKnownPath}`);
                if (authMetaResponse.ok) {
                  authServerMetadata = (await authMetaResponse.json()) as {
                    authorization_endpoint?: string;
                    token_endpoint?: string;
                    registration_endpoint?: string;
                  };
                  console.log('[OAuth Test] Auth server metadata:', authServerMetadata);
                  break;
                }
              } catch {
                /* Try next */
              }
            }

            return {
              success: true,
              oauthType: 'oauth2.1',
              message: authServerMetadata?.registration_endpoint
                ? 'OAuth 2.1 auto-discovery successful (DCR supported). Click "Start OAuth Flow" to authenticate.'
                : 'OAuth 2.1 auto-discovery successful. Click "Start OAuth Flow" to authenticate.',
              metadataUrl,
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
              metadataUrl,
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
              },
              true
            );
            let mcpStatus: number | undefined;
            let mcpStatusText: string | undefined;
            try {
              const mcpResponse = await fetch(data.mcp_url, {
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
            error: `Server requires authentication (401) but no OAuth 2.1 auto-discovery headers found.`,
            oauthType: 'unknown',
            mcpStatus: probeResponse.status,
            wwwAuthenticate: wwwAuthenticate || '<not present>',
            responseHeaders: allHeaders,
            responseBody: responseBody.substring(0, 500),
            hint: 'The server may require: (1) OAuth 2.1 setup on server side, (2) Client Credentials with explicit token URL, or (3) Different auth method.',
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
        console.log('[OAuth Start] Starting two-phase OAuth flow for:', data.mcp_url);
        const userId = params?.user?.user_id;

        let oauthMode: 'per_user' | 'shared' | undefined;
        let authorizationUrlOverride: string | undefined;
        let tokenUrlOverride: string | undefined;
        let clientSecretOverride: string | undefined;
        let clientIdFromConfig: string | undefined;
        let scopeOverride: string | undefined;
        if (data.mcp_server_id) {
          const mcpServerRepo = new MCPServerRepository(db);
          const server = await mcpServerRepo.findById(data.mcp_server_id);
          if (server?.auth?.type === 'oauth') {
            oauthMode = server.auth.oauth_mode || 'per_user';
            authorizationUrlOverride = server.auth.oauth_authorization_url;
            tokenUrlOverride = server.auth.oauth_token_url;
            clientIdFromConfig = server.auth.oauth_client_id;
            clientSecretOverride = server.auth.oauth_client_secret;
            scopeOverride = server.auth.oauth_scope;
          }
        }

        const probeResponse = await fetch(data.mcp_url, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
          signal: AbortSignal.timeout(15_000),
        });

        if (probeResponse.status !== 401) {
          return {
            success: false,
            error: 'Server did not return 401 — OAuth 2.1 authentication may not be required',
          };
        }

        const wwwAuthenticate = probeResponse.headers.get('www-authenticate') || '';
        const { resolveResourceMetadataUrl } = await import(
          '@agor/core/tools/mcp/oauth-mcp-transport'
        );
        const resolved = await resolveResourceMetadataUrl(wwwAuthenticate, data.mcp_url);
        if (!resolved) {
          return {
            success: false,
            error:
              'Server returned 401 but does not advertise OAuth metadata. No resource_metadata in WWW-Authenticate header and no .well-known/oauth-protected-resource endpoint found.',
          };
        }

        const connection = params?.connection as { id?: string } | undefined;
        const socketId = connection?.id;

        let result: StartTwoPhaseOAuthResult;
        try {
          result = await startTwoPhaseMCPOAuthFlow({
            mcpUrl: data.mcp_url,
            wwwAuthenticate,
            resourceMetadataUrl: resolved.metadataUrl,
            mcpServerId: data.mcp_server_id,
            userId,
            oauthMode,
            clientId: data.client_id || clientIdFromConfig,
            clientSecret: clientSecretOverride,
            authorizationUrlOverride,
            tokenUrlOverride,
            scope: scopeOverride,
            socketId,
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
          state: result.state,
          message:
            'Browser opened for authentication. After signing in, copy the callback URL and paste it below.',
        };
      } catch (error) {
        console.error('[OAuth Start] Error:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  app.service('mcp-servers/oauth-start').hooks({ before: { create: [ctx.requireAuth] } });

  // OAuth complete endpoint
  app.use('/mcp-servers/oauth-complete', {
    async create(data: { callback_url: string } | { code: string; state: string }) {
      try {
        const { completeMCPOAuthFlow, parseOAuthCallback } = await import(
          '@agor/core/tools/mcp/oauth-mcp-transport'
        );
        let code: string;
        let state: string;
        if ('callback_url' in data) {
          const parsed = parseOAuthCallback(data.callback_url);
          code = parsed.code;
          state = parsed.state;
        } else {
          code = data.code;
          state = data.state;
        }

        const pendingFlow = pendingOAuthFlows.get(state);
        if (!pendingFlow)
          return {
            success: false,
            error: 'OAuth flow expired or not found. Please start the flow again.',
          };

        const tokenResponse = await completeMCPOAuthFlow(pendingFlow.context, code, state);
        pendingOAuthFlows.delete(state);

        await persistOAuthToken(
          db,
          tokenResponse,
          pendingFlow.mcpUrl,
          pendingFlow,
          'OAuth Complete'
        );
        return { success: true, message: 'OAuth authentication successful!', tokenObtained: true };
      } catch (error) {
        console.error('[OAuth Complete] Error:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  app.service('mcp-servers/oauth-complete').hooks({ before: { create: [ctx.requireAuth] } });

  // OAuth disconnect
  app.use('/mcp-servers/oauth-disconnect', {
    async create(data: { mcp_server_id: string }, params?: AuthenticatedParams) {
      const { clearAuthCodeTokenCache } = await import('@agor/core/tools/mcp/oauth-mcp-transport');
      return performOAuthDisconnect({
        userId: params?.user?.user_id,
        mcpServerId: data.mcp_server_id,
        userTokenRepo: new UserMCPOAuthTokenRepository(db),
        mcpServerRepo: new MCPServerRepository(db),
        oauthTokenCache: oauth21TokenCache,
        clearCoreTokenCache: clearAuthCodeTokenCache,
      });
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
        const tokens = await userTokenRepo.listForUser(userId as UserID);
        const now = new Date();
        const authenticatedServerIds = tokens
          .filter((t) => !t.oauth_token_expires_at || t.oauth_token_expires_at > now)
          .map((t) => t.mcp_server_id);
        return { authenticated_server_ids: authenticatedServerIds };
      } catch (error) {
        console.error('[OAuth Status] Error fetching user tokens:', error);
        return { authenticated_server_ids: [] };
      }
    },
  });
  app.service('mcp-servers/oauth-status').hooks({ before: { find: [ctx.requireAuth] } });

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
        };
      },
      params?: AuthenticatedParams
    ) {
      try {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StreamableHTTPClientTransport } = await import(
          '@modelcontextprotocol/sdk/client/streamableHttp.js'
        );
        const { resolveMCPAuthHeaders } = await import('@agor/core/tools/mcp/jwt-auth');
        const { hasMinimumRole, ROLES } = await import('@agor/core/types');

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

        const hasInlineConfig = !!data.url;
        let serverConfig: {
          url: string;
          transport: 'http' | 'sse' | 'stdio';
          auth?: typeof data.auth;
          name?: string;
          scope?: string;
          owner_user_id?: string;
        };
        let serverId: string | undefined;

        if (hasInlineConfig) {
          const urlValidation = validateUrl(data.url!);
          if (!urlValidation.valid) return { success: false, error: urlValidation.error };
          serverConfig = {
            url: data.url!,
            transport: data.transport || 'http',
            auth: data.auth,
            name: 'inline-test',
          };
          if (data.mcp_server_id) {
            const server = await mcpServerRepo.findById(data.mcp_server_id);
            if (!server) return { success: false, error: 'MCP server not found' };
            if (params?.provider && params.user) {
              const userId = params.user.user_id;
              const userRole = params.user.role?.toLowerCase();
              const isAdmin = hasMinimumRole(userRole, ROLES.ADMIN);
              const isOwner = server.owner_user_id === userId;
              if (server.scope === 'global' && !isOwner && !isAdmin)
                return {
                  success: false,
                  error: 'Access denied: only server owner or admin can update this MCP server',
                };
              if (server.scope === 'session' && !isAdmin)
                return {
                  success: false,
                  error: 'Access denied: admin role required to update session-scoped MCP servers',
                };
            }
            serverId = data.mcp_server_id;
          }
        } else if (data.mcp_server_id) {
          const server = await mcpServerRepo.findById(data.mcp_server_id);
          if (!server) return { success: false, error: 'MCP server not found' };
          if (params?.provider && params.user) {
            const userId = params.user.user_id;
            const userRole = params.user.role?.toLowerCase();
            const isAdmin = hasMinimumRole(userRole, ROLES.ADMIN);
            const isOwner = server.owner_user_id === userId;
            if (server.scope === 'global' && !isOwner && !isAdmin)
              return {
                success: false,
                error: 'Access denied: only server owner or admin can discover this MCP server',
              };
            if (server.scope === 'session' && !isAdmin)
              return {
                success: false,
                error: 'Access denied: admin role required to discover session-scoped MCP servers',
              };
          }
          if (server.url) {
            const urlValidation = validateUrl(server.url);
            if (!urlValidation.valid) return { success: false, error: urlValidation.error };
          }
          serverConfig = {
            url: server.url || '',
            transport: (server.transport as 'http' | 'sse') || (server.url ? 'http' : 'stdio'),
            auth: server.auth,
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

        console.log('[MCP Discovery] Starting test for:', serverConfig.name || 'inline-config');

        let authHeaders = await resolveMCPAuthHeaders(serverConfig.auth, serverConfig.url);

        const probeAndAcquireOAuthToken = async (mcpUrl: string): Promise<string | undefined> => {
          try {
            const probeResponse = await fetch(mcpUrl, {
              method: 'GET',
              headers: { Accept: 'application/json' },
            });
            const wwwAuthenticate = probeResponse.headers.get('www-authenticate');
            if (probeResponse.status !== 401) return undefined;
            const { resolveResourceMetadataUrl } = await import(
              '@agor/core/tools/mcp/oauth-mcp-transport'
            );
            const resolved = await resolveResourceMetadataUrl(wwwAuthenticate, mcpUrl);
            if (!resolved) return undefined;

            // Route through the daemon's two-phase flow (callback → daemon's
            // public URL) instead of the legacy 127.0.0.1 callback server, so
            // remote browsers can complete the redirect on a deployed Agor.
            const connection = params?.connection as { id?: string } | undefined;
            const started = await startTwoPhaseMCPOAuthFlowAndAwaitToken({
              mcpUrl,
              wwwAuthenticate: wwwAuthenticate || '',
              resourceMetadataUrl: resolved.metadataUrl,
              mcpServerId: serverId,
              userId: params?.user?.user_id,
              // Discover writes the token via the shared MCP server row when
              // a serverId is known (matches the previous saveOAuth21TokenToDB
              // call). Without a serverId nothing is persisted to the DB; the
              // daemon-level cache below carries the token for this request.
              oauthMode: 'shared',
              socketId: connection?.id,
            });

            const tokenResponse = await started.awaitToken();
            // persistOAuthToken (run inside oauthCallbackHandler) already
            // populated the daemon cache + the MCP server row, so we just
            // return the access token to the caller.
            return tokenResponse.access_token;
          } catch (error) {
            // Misconfigured public base URL is a daemon-level problem, not a
            // missing-token signal — re-throw so the discover endpoint can
            // surface it to the caller instead of silently falling through to
            // an unauthenticated MCP probe.
            if (error instanceof PublicBaseUrlNotConfiguredError) throw error;
            console.error('[MCP Discovery] OAuth token acquisition failed:', error);
            return undefined;
          }
        };

        if (!authHeaders && serverConfig.auth?.type === 'oauth' && serverConfig.url) {
          let cachedToken = getOAuth21Token(serverConfig.url);
          if (!cachedToken && serverId) {
            cachedToken = await getOAuth21TokenFromDB(mcpServerRepo, serverId);
            if (cachedToken) cacheOAuth21Token(serverConfig.url, cachedToken, 3600);
          }
          if (!cachedToken && !serverId) {
            const dbResult = await getOAuth21TokenFromDBByUrl(mcpServerRepo, serverConfig.url);
            if (dbResult) {
              cachedToken = dbResult.token;
              cacheOAuth21Token(serverConfig.url, cachedToken, 3600);
            }
          }
          if (!cachedToken) {
            const freshToken = await probeAndAcquireOAuthToken(serverConfig.url);
            if (freshToken) cachedToken = freshToken;
          }
          if (cachedToken) authHeaders = { Authorization: `Bearer ${cachedToken}` };
        }

        const headers: Record<string, string> = { Accept: 'application/json, text/event-stream' };
        if (authHeaders) Object.assign(headers, authHeaders);

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
            const response = await fetch(input, init);
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
              clearOAuth21Token(serverConfig.url);
              const freshToken = await probeAndAcquireOAuthToken(serverConfig.url);
              if (freshToken) {
                const freshHeaders: Record<string, string> = {
                  Accept: 'application/json, text/event-stream',
                  Authorization: `Bearer ${freshToken}`,
                };
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
        console.error('MCP discovery error:', error);
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
        `[RBAC] Bootstrap promoted user ${userId.substring(0, 8)} (${user.email}) to superadmin`
      );
    } catch (error) {
      console.warn(
        `[RBAC] Failed to bootstrap superadmin for user ${userId.substring(0, 8)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  console.log(
    `[RBAC] Bootstrap superadmin sync complete (${promotedCount}/${bootstrapUsers.length} promoted)`
  );
}
