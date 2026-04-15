/**
 * Sessions Service
 *
 * Provides REST + WebSocket API for session management.
 * Uses DrizzleService adapter with SessionRepository.
 */

import { PAGINATION } from '@agor/core/config';
import {
  type Database,
  SessionMCPServerRepository,
  SessionRepository,
  type SessionWithLastMessage,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  MCPServerID,
  Paginated,
  QueryParams,
  Session,
  SessionID,
  TaskID,
} from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Session runtime configuration that should be inherited across forks, spawns, and btw.
 *
 * Bundled into a single type so that adding a new inheritable field only requires
 * updating this type and getInheritableConfig() — all creation paths (fork, spawn, btw)
 * automatically pick it up.
 */
interface InheritableSessionConfig {
  permission_config?: Session['permission_config'];
  model_config?: Session['model_config'];
}

/**
 * Extract the inheritable runtime configuration from a parent session.
 * Used by fork() and spawn() to ensure consistent config inheritance.
 */
function getInheritableConfig(parent: Session): InheritableSessionConfig {
  return {
    permission_config: parent.permission_config,
    model_config: parent.model_config,
  };
}

/**
 * Internal service params shared between services that support last-message enrichment.
 * Bypasses Feathers query filtering for internal service-to-service calls.
 */
export interface InternalEnrichmentParams {
  /** Root-level truncation length (bypasses Feathers query filtering, used by internal service calls) */
  _last_message_truncation_length?: number;
}

/**
 * Session service params
 */
export type SessionParams = QueryParams<{
  status?: Session['status'];
  agentic_tool?: Session['agentic_tool'];
  board_id?: string;
  include_last_message?: boolean | 'true' | 'false'; // Opt-in last message enrichment
  last_message_truncation_length?: number; // Default: 500 chars, min: 50, max: 10000
}> &
  InternalEnrichmentParams & {
    /** Root-level include_last_message flag (bypasses Feathers query filtering, used by internal service calls) */
    _include_last_message?: boolean | 'true' | 'false';
  };

/**
 * Execute task data payload
 * Used by setExecuteHandler, executeTask, and related methods
 */
export type ExecuteTaskData = {
  taskId: string;
  prompt: string;
  permissionMode?: import('@agor/core/types').PermissionMode;
  stream?: boolean;
  messageSource?: import('@agor/core/types').MessageSource;
};

/**
 * Parse and validate last_message_truncation_length parameter
 * Feathers delivers query params as strings, so we need to parse and validate
 */
function parseTruncationLength(value: unknown): number {
  // Default value
  const DEFAULT = 500;
  const MIN = 50;
  const MAX = 10000;

  if (value === undefined || value === null) {
    return DEFAULT;
  }

  // Parse to number
  const parsed = typeof value === 'number' ? value : Number(value);

  // Validate: must be finite, positive, and within bounds
  if (!Number.isFinite(parsed) || parsed < MIN || parsed > MAX) {
    return DEFAULT;
  }

  return Math.floor(parsed); // Ensure integer
}

/**
 * Extended sessions service with custom methods
 */
export class SessionsService extends DrizzleService<Session, Partial<Session>, SessionParams> {
  private sessionRepo: SessionRepository;
  private app: Application;
  private sessionMCPRepo: SessionMCPServerRepository;

  constructor(db: Database, app: Application) {
    const sessionRepo = new SessionRepository(db);
    super(sessionRepo, {
      id: 'session_id',
      resourceType: 'Session',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
      multi: ['patch', 'remove'], // Allow multi-patch and multi-remove
    });

    this.sessionRepo = sessionRepo;
    this.app = app;
    this.sessionMCPRepo = new SessionMCPServerRepository(db);
  }

  /**
   * Attach explicit MCP server IDs to a session.
   * Emits WebSocket events so the UI updates in real-time.
   */
  async setMCPServers(sessionId: SessionID, serverIds: string[], label: string): Promise<void> {
    for (const serverId of serverIds) {
      try {
        await this.sessionMCPRepo.addServer(sessionId, serverId as MCPServerID);
        this.app?.service('session-mcp-servers')?.emit?.('created', {
          session_id: sessionId,
          mcp_server_id: serverId,
          enabled: true,
          added_at: new Date(),
        });
      } catch {
        console.warn(`Skipped MCP server ${serverId} during ${label}`);
      }
    }
  }

  /**
   * Copy MCP servers from a source session to a target session.
   * Emits WebSocket events so the UI updates in real-time.
   */
  private async copyMCPServers(
    sourceSessionId: SessionID,
    targetSessionId: SessionID,
    label: string
  ): Promise<void> {
    try {
      const parentServers = await this.sessionMCPRepo.listServers(sourceSessionId, true);
      for (const server of parentServers) {
        try {
          await this.sessionMCPRepo.addServer(targetSessionId, server.mcp_server_id as MCPServerID);
          // Emit WebSocket event for real-time UI updates
          this.app?.service('session-mcp-servers')?.emit?.('created', {
            session_id: targetSessionId,
            mcp_server_id: server.mcp_server_id,
            enabled: true,
            added_at: new Date(),
          });
        } catch {
          // Silently skip — server may have been deleted between list and add
        }
      }
    } catch (error) {
      console.warn(`Failed to copy MCP servers during ${label}:`, error);
    }
  }

  /**
   * Custom method: Fork a session
   *
   * Creates a new session branching from the current session at a decision point.
   */
  async fork(
    id: string,
    data: { prompt: string; task_id?: string },
    params?: SessionParams
  ): Promise<Session> {
    const parent = await this.get(id, params);

    const forkedSession = await this.create(
      {
        agentic_tool: parent.agentic_tool,
        status: SessionStatus.IDLE,
        title: data.prompt.substring(0, 100), // First 100 chars as title
        description: data.prompt,
        worktree_id: parent.worktree_id,
        created_by: parent.created_by, // Inherit parent's creator for proper attribution
        unix_username: parent.unix_username, // Inherit parent's unix_username for consistent execution context
        git_state: { ...parent.git_state },
        genealogy: {
          forked_from_session_id: parent.session_id,
          fork_point_task_id: data.task_id as TaskID,
          fork_point_message_index: await this.sessionRepo.countMessages(parent.session_id),
          children: [],
        },
        contextFiles: [...(parent.contextFiles || [])],
        ...getInheritableConfig(parent),
        tasks: [],
        // Don't copy sdk_session_id - fork will get its own via forkSession:true
      },
      params
    );

    // Cast forkedSession to Session to handle return type
    const session = forkedSession as Session;

    // Copy MCP servers from parent session to forked session
    await this.copyMCPServers(
      parent.session_id as SessionID,
      session.session_id as SessionID,
      'fork'
    );

    // Update parent's children list
    const parentChildren = parent.genealogy?.children || [];
    await this.patch(
      id,
      {
        genealogy: {
          ...parent.genealogy,
          children: [...parentChildren, session.session_id],
        },
      },
      params
    );

    return session;
  }

  /**
   * Custom method: Spawn a child session
   *
   * Creates a new session for delegating a subsession to another agent.
   *
   * Settings inheritance:
   * - If spawning the same agentic tool → inherit parent's settings (permission_config, model_config)
   * - If spawning a different tool → use user's preferred settings for that tool
   * - Explicit overrides in SpawnConfig take precedence over both
   */
  async spawn(
    id: string,
    data: Partial<import('@agor/core/types').SpawnConfig>,
    params?: SessionParams
  ): Promise<Session> {
    // Validate required fields
    if (!data.prompt) {
      throw new Error('Spawn requires a prompt');
    }
    const parent = await this.get(id, params);
    const targetTool = data.agent || parent.agentic_tool;
    const isSameTool = targetTool === parent.agentic_tool;

    // Determine settings based on:
    // 1. Explicit overrides in SpawnConfig (highest priority)
    // 2. User preferences (if spawning different tool)
    // 3. Parent settings (fallback via getInheritableConfig)

    const inherited = getInheritableConfig(parent);
    let permissionConfig = inherited.permission_config;
    let modelConfig = inherited.model_config;

    // If spawning a different tool and no explicit overrides, fetch user preferences
    if (!isSameTool && !data.permissionMode && !data.modelConfig) {
      const userId = parent.created_by;
      if (userId && this.app) {
        try {
          const user = await this.app.service('users').get(userId, params);
          const toolDefaults = user?.default_agentic_config?.[targetTool];

          if (toolDefaults) {
            // Use user's preferred settings for this tool
            permissionConfig = {
              mode: toolDefaults.permissionMode,
              ...(targetTool === 'codex' &&
              toolDefaults.codexSandboxMode &&
              toolDefaults.codexApprovalPolicy
                ? {
                    codex: {
                      sandboxMode: toolDefaults.codexSandboxMode,
                      approvalPolicy: toolDefaults.codexApprovalPolicy,
                      networkAccess: toolDefaults.codexNetworkAccess,
                    },
                  }
                : {}),
            };

            if (toolDefaults.modelConfig) {
              modelConfig = {
                mode: toolDefaults.modelConfig.mode || 'alias',
                model: toolDefaults.modelConfig.model || '',
                updated_at: new Date().toISOString(),
                effort: toolDefaults.modelConfig.effort,
              };
            }
          }
        } catch (error) {
          // If we can't fetch user preferences, fall back to parent settings
          console.warn(
            'Could not fetch user preferences for spawned session, using parent settings:',
            error
          );
        }
      }
    }

    // Apply explicit overrides from SpawnConfig
    if (data.permissionMode) {
      permissionConfig = {
        mode: data.permissionMode,
        ...(targetTool === 'codex' && data.codexSandboxMode && data.codexApprovalPolicy
          ? {
              codex: {
                sandboxMode: data.codexSandboxMode,
                approvalPolicy: data.codexApprovalPolicy,
                networkAccess: data.codexNetworkAccess,
              },
            }
          : permissionConfig?.codex
            ? { codex: permissionConfig.codex }
            : {}),
      };
    }

    if (data.modelConfig) {
      modelConfig = {
        mode: data.modelConfig.mode || 'alias',
        model: data.modelConfig.model || '',
        updated_at: new Date().toISOString(),
        effort: data.modelConfig.effort,
      };
    }

    // Build callback configuration
    // callback_session_id is the single source of truth for where to deliver callbacks.
    // Default to parent session when callbacks are enabled (which is the default for spawn).
    const isCallbackEnabled = data.enableCallback !== false; // default: true for spawn
    const callbackConfig = {
      ...(data.enableCallback !== undefined ? { enabled: data.enableCallback } : {}),
      ...(isCallbackEnabled
        ? { callback_session_id: parent.session_id, callback_created_by: parent.created_by }
        : {}),
      ...(data.includeLastMessage !== undefined
        ? { include_last_message: data.includeLastMessage }
        : {}),
      ...(data.includeOriginalPrompt !== undefined
        ? { include_original_prompt: data.includeOriginalPrompt }
        : {}),
      // Default callback mode to "once" — fires once then auto-disables
      callback_mode: data.callbackMode ?? 'once',
    };

    // Build final prompt (append extra instructions if provided)
    let finalPrompt = data.prompt;
    if (data.extraInstructions) {
      finalPrompt = `${data.prompt}\n\n${data.extraInstructions}`;
    }

    const spawnedSession = await this.create(
      {
        agentic_tool: targetTool,
        status: SessionStatus.IDLE,
        title: data.title || data.prompt.substring(0, 100), // Use provided title or first 100 chars
        description: finalPrompt, // Use final prompt with extra instructions if provided
        worktree_id: parent.worktree_id,
        created_by: parent.created_by, // Inherit parent's creator for proper attribution
        unix_username: parent.unix_username, // Inherit parent's unix_username for consistent execution context
        git_state: { ...parent.git_state },
        genealogy: {
          parent_session_id: parent.session_id,
          spawn_point_task_id: data.task_id as TaskID,
          spawn_point_message_index: await this.sessionRepo.countMessages(parent.session_id),
          children: [],
        },
        contextFiles: [...(parent.contextFiles || [])],
        tasks: [],
        permission_config: permissionConfig,
        model_config: modelConfig,
        callback_config: callbackConfig,
        // Don't copy sdk_session_id - spawn will get its own via forkSession:true
      },
      params
    );

    // Cast spawnedSession to Session to handle return type (create returns Session | Session[])
    const session = spawnedSession as Session;

    // MCP servers: explicit mcpServerIds > copy from parent
    // An explicit empty array means "no MCPs" — does NOT fall through to parent.
    if (data.mcpServerIds !== undefined) {
      await this.setMCPServers(session.session_id as SessionID, data.mcpServerIds, 'spawn');
    } else {
      await this.copyMCPServers(
        parent.session_id as SessionID,
        session.session_id as SessionID,
        'spawn'
      );
    }

    // Update parent's children list
    const parentChildren = parent.genealogy?.children || [];
    await this.patch(
      id,
      {
        genealogy: {
          ...parent.genealogy,
          children: [...parentChildren, session.session_id],
        },
      },
      params
    );

    return session;
  }

  /**
   * Custom method: Execute a prompt on this session
   *
   * Spawns an executor subprocess to run the prompt against the session.
   * The executor connects back to daemon via Feathers/WebSocket.
   *
   * NOTE: The actual implementation is provided by index.ts via setExecuteHandler
   */
  private executeHandler?: (
    sessionId: string,
    data: ExecuteTaskData,
    params?: SessionParams
  ) => Promise<{
    success: boolean;
    taskId: string;
    status: string;
    streaming: boolean;
  }>;

  setExecuteHandler(
    handler: (
      sessionId: string,
      data: ExecuteTaskData,
      params?: SessionParams
    ) => Promise<{
      success: boolean;
      taskId: string;
      status: string;
      streaming: boolean;
    }>
  ): void {
    this.executeHandler = handler;
  }

  async executeTask(
    id: string,
    data: ExecuteTaskData,
    params?: SessionParams
  ): Promise<{
    success: boolean;
    taskId: string;
    status: string;
    streaming: boolean;
  }> {
    if (this.executeHandler) {
      return this.executeHandler(id, data, params);
    }
    throw new Error('Execute handler not set - cannot execute task');
  }

  /**
   * Custom method: Trigger queue processing
   *
   * Processes the next queued message for an idle session.
   * Used by callback system to trigger immediate queue processing.
   *
   * NOTE: The actual implementation is provided by index.ts via setQueueProcessor
   */
  private queueProcessor?: (sessionId: string, params?: SessionParams) => Promise<void>;

  setQueueProcessor(processor: (sessionId: string, params?: SessionParams) => Promise<void>): void {
    this.queueProcessor = processor;
  }

  async triggerQueueProcessing(id: string, params?: SessionParams): Promise<void> {
    if (this.queueProcessor) {
      await this.queueProcessor(id, params);
    } else {
      console.warn('⚠️  [SessionsService] Queue processor not set, cannot trigger queue processing');
    }
  }

  /**
   * Custom method: Get session genealogy tree
   *
   * Returns ancestors and descendants for visualization.
   */
  async getGenealogy(
    id: string,
    params?: SessionParams
  ): Promise<{
    session: Session;
    ancestors: Session[];
    children: Session[];
  }> {
    const session = await this.get(id, params);

    // Get ancestors
    const ancestors = await this.sessionRepo.findAncestors(id);

    // Get children
    const children = await this.sessionRepo.findChildren(id);

    return {
      session,
      ancestors,
      children,
    };
  }

  /**
   * Override remove to cascade delete children (forks and subsessions)
   */
  async remove(
    id: import('@agor/core/types').NullableId,
    params?: SessionParams
  ): Promise<Session | Session[]> {
    // Handle batch delete
    if (id === null) {
      // For multi-delete, get all matching sessions and delete each one
      const sessions = (await super.find(params)) as Session[];
      const results: Session[] = [];

      for (const session of sessions) {
        const deleted = (await this.remove(session.session_id, params)) as Session;
        results.push(deleted);
      }

      return results;
    }

    // Single delete with cascade
    // Get the session before deleting
    const session = await this.get(String(id), params);

    // Find all children (forks and subsessions)
    const children = await this.sessionRepo.findChildren(String(id));

    // Recursively delete all children first
    if (children.length > 0) {
      for (const child of children) {
        await this.remove(child.session_id, params);
      }
    }

    // Now delete the current session (messages and tasks are cascade-deleted by DB)
    await this.sessionRepo.delete(id as string);

    // Emit removed event for WebSocket broadcasting
    this.emit?.('removed', session, params);

    return session;
  }

  /**
   * Override get to optionally enrich with last message
   *
   * Last message enrichment is opt-in via include_last_message query parameter
   */
  async get(id: string, params?: SessionParams): Promise<SessionWithLastMessage> {
    // Check both query params and root-level params (root-level bypasses Feathers query filtering)
    const includeLastMessageQuery = params?.query?.include_last_message;
    const includeLastMessageRoot = params?._include_last_message;
    const includeLastMessage = includeLastMessageRoot ?? includeLastMessageQuery;

    const session = await super.get(id, params);

    // Only enrich with last message if explicitly requested
    if (includeLastMessage === true || includeLastMessage === 'true') {
      const truncationLengthQuery = params?.query?.last_message_truncation_length;
      const truncationLengthRoot = params?._last_message_truncation_length;
      const truncationLength = parseTruncationLength(truncationLengthRoot ?? truncationLengthQuery);
      const result = await this.sessionRepo.enrichWithLastMessage(
        session as Session,
        truncationLength
      );
      return result;
    }

    return session as SessionWithLastMessage;
  }

  /**
   * Override find - no custom logic, just use default find
   *
   * Note: Last message is NOT included in list operations - only on single GET
   */
  async find(params?: SessionParams): Promise<Paginated<Session> | Session[]> {
    // Use default find to ensure all hooks and scoping are applied
    return super.find(params);
  }
}

/**
 * Service factory function
 */
export function createSessionsService(db: Database, app: Application): SessionsService {
  return new SessionsService(db, app);
}
